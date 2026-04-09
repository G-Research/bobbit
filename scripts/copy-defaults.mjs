#!/usr/bin/env node
/**
 * Build builtins into dist/server/defaults/ for the config cascade.
 *
 * Source: defaults/ — canonical builtin configs (roles, personalities, workflows,
 *         tools with extension code, tool-group-policies, system-prompt).
 *
 * The defaults/ directory is the source of truth for all shipped builtins that
 * participate in the config cascade. .bobbit/config/ is purely runtime state
 * for per-project overrides and is NOT copied into builtins.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = "defaults";
const DEST = "dist/server/defaults";

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(SRC, DEST);
console.log(`Built ${DEST}/ from ${SRC}/`);
