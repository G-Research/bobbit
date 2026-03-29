#!/usr/bin/env node
/**
 * Copy .bobbit/config/ → dist/server/defaults/ for scaffolding into new projects.
 * Excludes project-specific files (project.yaml, mcp.json) that shouldn't be scaffolded.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = ".bobbit/config";
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

copyDir(SRC, DEST);
console.log(`Copied ${SRC}/ → ${DEST}/ (excluding ${[...EXCLUDE].join(", ")})`);
