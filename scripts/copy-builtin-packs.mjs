#!/usr/bin/env node
/**
 * Ship first-party (built-in) packs into dist/server/builtin-packs/market-packs/.
 *
 * Source: repo-root market-packs/<name>/ — the canonical home for first-party
 *         pack sources (see docs/design/built-in-first-party-packs.md §3).
 *
 * Only an EXPLICIT allowlist of packs ships as first-party builtins; everything
 * else under market-packs/ (e.g. the `artifacts` litmus pack) stays test-only and
 * is installed via fixtures. The shipped tree keeps the `market-packs` path
 * segment deliberately so the pack-identity derivation (derivePackId,
 * packIdFromRoot, isMarketPackBaseDir) resolves a correct, stable packId with no
 * changes to the security-critical identity code.
 *
 * For each pack we copy pack.yaml, panels/, entrypoints/, and lib/ — the latter
 * contains the built lib/*.js bundles (produced by `npm run build:packs`, which
 * runs BEFORE this step) plus the hand-authored lib/routes.mjs server module. We
 * SKIP src/ (source-only) and any node_modules.
 */
import fs from "node:fs";
import path from "node:path";

const FIRST_PARTY_PACKS = ["pr-walkthrough"]; // explicit allowlist
const SRC = "market-packs";
const DEST = "dist/server/builtin-packs/market-packs";

const SKIP_DIRS = new Set(["src", "node_modules"]);

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

for (const name of FIRST_PARTY_PACKS) {
  const src = path.join(SRC, name);
  if (!fs.existsSync(src)) {
    throw new Error(`copy-builtin-packs: first-party pack not found: ${src}`);
  }
  copyDir(src, path.join(DEST, name));
}

console.log(`Built ${DEST}/ from ${SRC}/ (${FIRST_PARTY_PACKS.join(", ")})`);
