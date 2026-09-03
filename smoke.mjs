#!/usr/bin/env node
/**
 * Highline CI — static smoke test for built Astro output.
 *
 * Complements (does not repeat) the per-repo postbuild checks:
 *   validate-schema.mjs  → JSON-LD
 *   check-links.mjs      → <a href>, <link href> (non-preload), <form action>
 *
 * This one covers what those skip, which is exactly the failure class an
 * adapter or image-pipeline regression produces:
 *   1. every referenced image, script, stylesheet and preload exists on disk
 *   2. no referenced asset is 0 bytes
 *   3. no 0-byte files anywhere in the output (dotfiles excluded)
 *   4. every page has a non-empty <title>
 *
 * Usage: node smoke.mjs [distDir]   (default: dist/client, else dist)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT =
  process.argv[2] ??
  ["dist/client", "dist"].find((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

if (!ROOT) {
  console.error("FAIL: no build output found — run the build first.");
  process.exit(1);
}

const SKIP_PROTOCOL = /^(https?:)?\/\/|^(data|mailto|tel|blob|javascript):|^#/i;
const errors = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    entry.isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT);
const pages = allFiles.filter((f) => f.endsWith(".html"));

if (pages.length === 0) {
  console.error(`FAIL: no HTML pages in ${ROOT}`);
  process.exit(1);
}

// --- 3. no 0-byte files (dotfiles like .gitkeep are legitimate markers)
for (const f of allFiles) {
  const name = f.split("/").pop();
  if (name.startsWith(".")) continue;
  if (statSync(f).size === 0) errors.push(`0 bytes: ${relative(ROOT, f)}`);
}

function collectRefs(html) {
  const refs = new Set();
  const add = (u) => {
    if (u && !SKIP_PROTOCOL.test(u.trim())) refs.add(u.trim());
  };

  for (const [, attrs] of html.matchAll(/<(?:img|source)\b([^>]*)>/gi)) {
    add(attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1]);
    const srcset = attrs.match(/\bsrcset=["']([^"']+)["']/i)?.[1];
    if (srcset) {
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url && !url.startsWith("data:")) add(url);
      }
    }
  }

  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(src);

  // check-links.mjs deliberately skips preload/modulepreload — cover them here
  for (const [, attrs] of html.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = attrs.match(/\brel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!/(pre|module)load|stylesheet|icon/i.test(rel)) continue;
    add(attrs.match(/\bhref=["']([^"']+)["']/i)?.[1]);
  }

  return refs;
}

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const where = relative(ROOT, page);

  // --- 4. non-empty <title>
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) errors.push(`no <title>: ${where}`);

  // --- 1 + 2. referenced assets exist and are non-empty
  for (const ref of collectRefs(html)) {
    const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
    if (!clean) continue;
    const target = clean.startsWith("/")
      ? join(ROOT, clean)
      : resolve(dirname(page), clean);

    let size;
    try {
      const st = statSync(target);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      errors.push(`missing asset: ${clean}  (referenced by ${where})`);
      continue;
    }
    if (size === 0) errors.push(`empty asset: ${clean}  (referenced by ${where})`);
  }
}

const images = allFiles.filter((f) => /\.(webp|avif|png|jpe?g|svg)$/i.test(f)).length;
console.log(`Smoke: ${pages.length} Seiten, ${allFiles.length} Dateien, ${images} Bilder in ${ROOT}`);

if (errors.length) {
  console.error(`\nFAIL: ${errors.length} Problem(e)\n`);
  for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
  if (errors.length > 40) console.error(`  ... und ${errors.length - 40} weitere`);
  process.exit(1);
}

console.log("Smoke passed.");
