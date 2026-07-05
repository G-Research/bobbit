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
 *
 * The replace is atomic (see scripts/lib/atomic-copy-dir.mjs) — dist/server/defaults
 * is bind-mounted read-only into sandbox containers as /tools-builtin, and a naive
 * rm -rf + copy leaves it missing/partial for any container created mid-rebuild.
 */
import { atomicReplaceDir } from "./lib/atomic-copy-dir.mjs";

const SRC = "defaults";
const DEST = "dist/server/defaults";

atomicReplaceDir(SRC, DEST);
console.log(`Built ${DEST}/ from ${SRC}/`);
