#!/usr/bin/env node
/**
 * Atomically replace a destination directory with a fresh recursive copy of a
 * source directory.
 *
 * Why: `build:server` used to do `rm -rf dist/server/defaults && copy(...)`
 * (and the equivalent for `dist/server/builtin-packs`) as two separate steps.
 * That leaves a real window — tens to ~150ms, measured — where the dest
 * directory is either completely absent or only partially repopulated. On a
 * machine running builds/restarts frequently (e.g. `npm run dev:harness` /
 * `restart-server` firing while a sandboxed session is being spawned), a
 * Docker bind-mount (`docker run -v <dest>:/tools-builtin:ro`) that lands
 * inside that window silently mounts an empty directory — Docker auto-creates
 * missing bind-mount sources with no error — and the sandboxed session sees
 * `/tools-builtin/*` as unresolvable for the container's entire lifetime. See
 * docs/debugging.md entry for "tools-builtin not resolving in sandbox".
 *
 * Fix: build the fresh tree into a staging dir, then swap it into place with
 * two renames (old→`.old-*`, staging→dest). Both renames are atomic on a
 * single filesystem, so any concurrent reader (including a Docker bind mount
 * being created) always observes either the fully-old tree or the fully-new
 * tree — never a missing or partial one.
 */
import fs from "node:fs";
import path from "node:path";

// Exported so gapless-symlink-swap.mjs (the zero-window swap variant, see its
// file header) can reuse the same recursive-copy semantics without
// duplicating them.
export function copyDirRecursive(src, dest, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs?.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skipDirs);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * @param {string} src source directory to copy from; a no-op if it doesn't exist
 * @param {string} dest destination directory to atomically replace
 * @param {{ skipDirs?: Set<string>, populate?: (staging: string) => void }} [opts]
 *   `populate`, if given, replaces the default recursive copy of `src` into the
 *   staging dir (used by callers with more elaborate per-entry copy rules).
 */
export function atomicReplaceDir(src, dest, opts = {}) {
  if (!opts.populate && !fs.existsSync(src)) return;

  const staging = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const old = `${dest}.old-${process.pid}-${Date.now()}`;

  // Clean up ANY `.tmp-*`/`.old-*` debris left behind by a previous crashed run
  // (a different pid/timestamp than this run's own staging/old names above) so
  // it doesn't accumulate silently next to dest across repeated builds.
  const destParent = path.dirname(dest);
  const destBase = path.basename(dest);
  try {
    for (const entry of fs.readdirSync(destParent)) {
      if (entry.startsWith(`${destBase}.tmp-`) || entry.startsWith(`${destBase}.old-`)) {
        fs.rmSync(path.join(destParent, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // destParent doesn't exist yet on a first-ever build — nothing to clean up.
  }

  if (opts.populate) {
    fs.mkdirSync(staging, { recursive: true });
    opts.populate(staging);
  } else {
    copyDirRecursive(src, staging, opts.skipDirs);
  }

  try {
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, old);
    }
    fs.renameSync(staging, dest);
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
