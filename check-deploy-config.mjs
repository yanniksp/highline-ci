#!/usr/bin/env node
/**
 * check-deploy-config.mjs - prueft die vom Astro-Cloudflare-Adapter erzeugte
 * Wrangler-Konfiguration gegen Invarianten, die ein Build nicht sieht.
 *
 * Anlass (03.09.2026, elektro-scherzinger): Build gruen, Deploy kaputt. Die
 * SESSION-KV-Bindung stand ohne "id" in der generierten Config. Wrangler hielt
 * sie fuer unprovisioniert, wollte das Namespace neu anlegen, es existierte
 * bereits -> Fehler 10014, Deploy abgebrochen.
 *
 * "wrangler deploy --dry-run" faengt diesen Fall NICHT (nachgemessen: exit 0,
 * die Bindung wird ohne id anstandslos gelistet). Provisioniert wird erst beim
 * echten Deploy. Deshalb dieses Skript zusaetzlich, nicht ersatzweise.
 *
 * Aufruf im Repo-Wurzelverzeichnis, nach "npm run build":
 *   node check-deploy-config.mjs [repo-root]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const problems = [];
const notes = [];

const fail = (msg) => problems.push(msg);
const note = (msg) => notes.push(msg);

/** JSONC -> JSON: Kommentare raus, nachgestellte Kommas raus. */
function parseJsonc(text, label) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += n; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`${label} ist kein gueltiges JSON/JSONC: ${e.message}`);
  }
}

function readJson(path, label) {
  return parseJsonc(readFileSync(path, "utf8"), label);
}

// ---------------------------------------------------------------------------
// 1. Der Deploy-Vertrag: .wrangler/deploy/config.json zeigt auf die Config,
//    die wrangler beim Deploy wirklich benutzt. Die Wurzel-wrangler.jsonc wird
//    nie direkt verwendet -- sie ist die Quelle, nicht die Deploy-Config.
//    Wo die generierte Config liegt, haengt an der Adapter-Version und daran,
//    ob die Site Server-Output hat (statisch: dist/client, sonst dist/server).
//    Deshalb wird der Pfad gelesen, nicht geraten.
// ---------------------------------------------------------------------------
const redirectPath = join(root, ".wrangler", "deploy", "config.json");
if (!existsSync(redirectPath)) {
  console.error(
    "FEHLER: .wrangler/deploy/config.json fehlt.\n" +
      "  Der Astro-Cloudflare-Adapter schreibt diese Datei beim Build. Fehlt sie,\n" +
      "  hat der Build sie nicht erzeugt oder der Adapter hat den Deploy-Vertrag\n" +
      "  geaendert. Beides gehoert angesehen, bevor auf main gemergt wird.",
  );
  process.exit(1);
}

const redirect = readJson(redirectPath, ".wrangler/deploy/config.json");
if (!redirect.configPath) {
  fail(".wrangler/deploy/config.json hat kein Feld \"configPath\".");
  console.error("FEHLER: " + problems[0]);
  process.exit(1);
}

const genPath = resolve(dirname(redirectPath), redirect.configPath);
if (!existsSync(genPath)) {
  console.error(
    `FEHLER: die verwiesene Deploy-Konfiguration fehlt: ${relative(root, genPath)}\n` +
      "  .wrangler/deploy/config.json zeigt auf eine Datei, die der Build nicht\n" +
      "  geschrieben hat. So bricht der Deploy ab, obwohl der Build gruen ist.",
  );
  process.exit(1);
}

const gen = readJson(genPath, relative(root, genPath));
const genDir = dirname(genPath);

// Quell-Config (wrangler.jsonc / wrangler.json) im Repo-Wurzelverzeichnis.
const sourceCandidates = ["wrangler.jsonc", "wrangler.json"];
const sourcePath = sourceCandidates
  .map((f) => join(root, f))
  .find((p) => existsSync(p));
const source = sourcePath ? readJson(sourcePath, relative(root, sourcePath)) : null;
if (!source) note("keine wrangler.jsonc/wrangler.json im Wurzelverzeichnis - Abgleich Quelle/generiert entfaellt");

// ---------------------------------------------------------------------------
// 2. Provisionierte Ressourcen brauchen eine id. Das ist der 10014-Faenger.
//    Ohne id versucht wrangler beim Deploy, die Ressource neu anzulegen.
//    Existiert sie schon, bricht der Deploy ab.
//    "previews" ist ausgenommen - Preview-Bindungen tragen bewusst keine id.
// ---------------------------------------------------------------------------
const idRules = [
  ["kv_namespaces", "id", "npx wrangler kv namespace list"],
  ["d1_databases", "database_id", "npx wrangler d1 list"],
  ["r2_buckets", "bucket_name", "npx wrangler r2 bucket list"],
  ["vectorize", "index_name", "npx wrangler vectorize list"],
  ["hyperdrive", "id", "npx wrangler hyperdrive list"],
];

for (const [key, idField, listCmd] of idRules) {
  const entries = Array.isArray(gen[key]) ? gen[key] : [];
  let missing = 0;
  for (const entry of entries) {
    if (!entry[idField]) {
      missing++;
      fail(
        `${key}: Bindung "${entry.binding ?? "(ohne Namen)"}" hat kein "${idField}".\n` +
          `    Wrangler haelt sie fuer unprovisioniert und legt die Ressource beim\n` +
          `    Deploy neu an. Existiert sie bereits, bricht der Deploy mit 10014 ab.\n` +
          `    Fix: ${listCmd} -> id in ${relative(root, sourcePath ?? genPath)} eintragen:\n` +
          `      "${key}": [{ "binding": "${entry.binding ?? "..."}", "${idField}": "<id>" }]`,
      );
    }
  }
  if (entries.length && !missing) note(`${key}: ${entries.length} Bindung(en), alle mit ${idField}`);
}

// ---------------------------------------------------------------------------
// 3. Pflichtfelder der generierten Config.
// ---------------------------------------------------------------------------
if (!gen.compatibility_date) {
  fail("compatibility_date fehlt in der generierten Config. Wrangler lehnt den Deploy ab.");
}
if (!gen.name) {
  fail("name fehlt in der generierten Config - der Worker haette keinen Zielnamen.");
}

// ---------------------------------------------------------------------------
// 4. Was die Quelle erklaert, muss die generierte Config tragen.
//    Faengt stilles Verlieren von Einstellungen beim Adapter-Sprung.
//    html_handling steuert das trailing-slash-Verhalten und ist SEO-relevant.
// ---------------------------------------------------------------------------
if (source) {
  const preserved = [
    ["name", (c) => c.name],
    ["compatibility_date", (c) => c.compatibility_date],
    ["compatibility_flags", (c) => c.compatibility_flags],
    ["observability.enabled", (c) => c.observability?.enabled],
    ["assets.html_handling", (c) => c.assets?.html_handling],
  ];
  for (const [label, get] of preserved) {
    const want = get(source);
    if (want === undefined) continue;
    const have = get(gen);
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      fail(
        `${label}: Quelle sagt ${JSON.stringify(want)}, generierte Config sagt ${JSON.stringify(have)}.\n` +
          `    Der Adapter hat die Einstellung nicht uebernommen. Beim Deploy gilt die\n` +
          `    generierte Config, nicht die Quelle - die Einstellung waere live weg.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Assets: das Verzeichnis muss existieren und Dateien enthalten.
//    Ein leeres Assets-Verzeichnis deployt eine leere Site mit HTTP 200.
// ---------------------------------------------------------------------------
if (gen.assets?.directory) {
  const assetDir = resolve(genDir, gen.assets.directory);
  if (!existsSync(assetDir) || !statSync(assetDir).isDirectory()) {
    fail(`assets.directory zeigt auf ${relative(root, assetDir)} - das Verzeichnis existiert nicht.`);
  } else {
    const count = readdirSync(assetDir).length;
    if (count === 0) fail(`assets.directory ${relative(root, assetDir)} ist leer.`);
    else note(`assets.directory ${relative(root, assetDir)}: ${count} Eintraege`);
  }
} else if (source?.assets?.directory) {
  fail("Die Quelle deklariert assets, die generierte Config hat keinen assets-Block.");
}

// ---------------------------------------------------------------------------
// 6. Server-Einstiegspunkt, falls die Site einen hat.
// ---------------------------------------------------------------------------
if (gen.main) {
  const entry = resolve(genDir, gen.main);
  if (!existsSync(entry)) {
    fail(`main zeigt auf ${relative(root, entry)} - die Datei existiert nicht.`);
  } else if (statSync(entry).size === 0) {
    fail(`main ${relative(root, entry)} ist 0 Byte.`);
  } else {
    note(`Server-Einstieg ${relative(root, entry)}: ${statSync(entry).size} Byte`);
  }
} else {
  note("kein Server-Einstieg (main) - die Site ist vollstaendig statisch");
}

// ---------------------------------------------------------------------------
console.log(`Deploy-Konfiguration: ${relative(root, genPath)}`);
for (const n of notes) console.log(`  - ${n}`);

if (problems.length) {
  console.error(`\nDeploy-Konfiguration: ${problems.length} Problem(e)\n`);
  for (const p of problems) console.error(`  * ${p}\n`);
  process.exit(1);
}

console.log("Deploy-Konfiguration ok.");
