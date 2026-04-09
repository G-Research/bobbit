#!/usr/bin/env node
/**
 * Build builtins into dist/server/defaults/ for the config cascade.
 *
 * Sources (in order, later wins for same file):
 *   1. defaults/          — canonical builtin configs (roles, personalities, workflows,
 *                           tools with extension code, tool-group-policies)
 *   2. .bobbit/config/    — system-prompt, user overrides
 *
 * The defaults/ directory is the source of truth for builtins that participate
 * in the config cascade. .bobbit/config/ provides the system prompt and any
 * user-created overrides (which are NOT copied into builtins).
 *
 * Excludes project-specific files (project.yaml, mcp.json) that shouldn't be scaffolded.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULTS_SRC = "defaults";
const CONFIG_SRC = ".bobbit/config";
const DEST = "dist/server/defaults";

/** Files that are project-specific and should NOT be scaffolded into user projects. */
const EXCLUDE = new Set(["project.yaml", "mcp.json"]);

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy .bobbit/config/ first (tools, system-prompt, tool-group-policies)
copyDir(CONFIG_SRC, DEST);
// Then overlay defaults/ (canonical builtins — roles, personalities, workflows)
// Builtins always win: if a file exists in both, defaults/ takes priority.
copyDir(DEFAULTS_SRC, DEST);
console.log(`Built ${DEST}/ from ${CONFIG_SRC}/ + ${DEFAULTS_SRC}/ (excluding ${[...EXCLUDE].join(", ")})`);
