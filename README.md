# highline-ci

Zentrale CI für die Astro/Cloudflare-Workers-Sites von
[Highline Webdesign](https://highline-webdesign.com/).

Gleiches Prinzip wie [`renovate-config`](https://github.com/yanniksp/renovate-config):
eine Definition hier, dünne Aufrufer in den Kundenrepos. Sonst driftet die CI über
fünfzehn Sites auseinander.

## Einbinden

Im Kundenrepo `.github/workflows/ci.yml` anlegen:

```yaml
name: CI
on: pull_request

jobs:
  ci:
    uses: yanniksp/highline-ci/.github/workflows/astro-pr.yml@main
```

Das ist alles. Abweichende Werte nur, wenn nötig:

```yaml
    with:
      node-version: "22"
      dist-dir: dist/client
```

Danach im Repo unter **Settings → Branches → `main`** den Check
**„Build & Smoke"** als *Required status check* setzen. Ohne diesen Schritt ist der
Workflow nur eine Ampel, die man ignorieren kann.

## Was der Workflow tut

| Schritt | Zweck |
|---|---|
| `npm ci` | Installiert exakt aus dem Lockfile — dasselbe, was Cloudflare beim Deploy tut |
| `npm run lint --if-present` | biome, falls das Repo ein `lint`-Skript hat |
| `npm run build` | Zieht `prebuild`/`postbuild` mit, also auch `validate-schema.mjs` und `check-links.mjs` |
| `node .highline-ci/smoke.mjs` | Prüft den gebauten Output (siehe unten) |

**Kein `astro check`.** Instaltec hatte am 03.09.2026 22 offene Typfehler. Ein Typecheck
als Blocker am Tag eins hätte jeden PR gestoppt. Kommt dazu, wenn die abgeräumt sind.

**Kein Browser-Test.** Klasse B (gsap, lenis, swiper) braucht einen echten Browser, aber
solange ein Mensch jeden PR ansieht, zahlt sich der Aufwand nicht aus. Der Browser-Test
gehört zusammen mit Automerge — die Absicherung wächst mit der Automatisierung, nicht
auf Vorrat.

## Was `smoke.mjs` prüft

Ergänzt die Checks, die in den Repos schon laufen, statt sie zu wiederholen.
`check-links.mjs` deckt `<a href>`, `<link href>` (ohne preload) und `<form action>` ab —
**Bilder und Skripte ausdrücklich nicht.** Genau da setzt der Smoke-Test an:

1. Jedes referenzierte Bild, Skript, Stylesheet und jeder Preload existiert auf der Platte
2. Kein referenziertes Asset ist 0 Byte
3. Keine 0-Byte-Dateien im Output (Dotfiles wie `.gitkeep` ausgenommen)
4. Jede Seite hat einen nicht-leeren `<title>`

Das ist die Fehlerklasse, die eine Adapter- oder Bildpipeline-Regression erzeugt. Der
`@astrojs/cloudflare`-13.2-Bug schrieb Bilder nach `dist/client/_astro/`, während der
Generator sie unter `dist/_astro/` suchte — Punkt 1 und 2 hätten das gefangen.

Lokal ausführen:

```bash
node smoke.mjs path/to/dist/client
```

Kein npm-Paket nötig, das Skript nutzt nur Node-Bordmittel.

## Warum GitHub Actions und nicht Cloudflare Workers Builds

Zwei Systeme, beide führen `npm run build` aus. Der Unterschied ist die Befugnis:

```
PR ──► GitHub Actions ──► darf NEIN sagen
       (vor dem Merge)         │
                               ▼
                         Merge auf main
                               │
                               ▼
       Cloudflare Workers Builds ──► muss JA sagen
       (nach dem Merge)              live beim Kunden
```

Workers Builds ist die Deploy-Pipeline und läuft erst nach dem Merge — wenn sie
fehlschlägt, ist der kaputte Stand schon auf `main`. Diese CI ist das Gate davor.

Sie ist zugleich die Voraussetzung für Renovate-Automerge: ohne sie sind fünf Gruppen
über fünfzehn Sites bis zu 75 PRs im Monat von Hand.
