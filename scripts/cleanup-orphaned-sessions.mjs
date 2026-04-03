#!/usr/bin/env node
/**
 * Cleanup script: remove sessions and goals that were archived into the wrong
 * project store due to a bug in terminateSession() (resolved store after
 * deleting from in-memory map, causing fallback to default project store).
 *
 * What it does:
 *   1. Reads the project registry to find registered project IDs
 *   2. Scans each project's sessions.json and goals.json for entries whose
 *      projectId doesn't match that project — these are misrouted entries
 *   3. Removes misrouted entries
 *
 * Usage:
 *   node scripts/cleanup-orphaned-sessions.mjs [--bobbit-dir <path>] [--dry-run]
 *
 * Options:
 *   --bobbit-dir <path>   Server root (default: current directory)
 *   --dry-run             Show what would be removed without making changes
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dirIdx = args.indexOf("--bobbit-dir");
const serverRoot = dirIdx >= 0 && args[dirIdx + 1] ? resolve(args[dirIdx + 1]) : process.cwd();

const stateDir = join(serverRoot, ".bobbit", "state");
const projectsFile = join(stateDir, "projects.json");

if (!existsSync(projectsFile)) {
	console.error(`No projects.json found at ${projectsFile}`);
	console.error("Run this script from the Bobbit server root, or pass --bobbit-dir <path>");
	process.exit(1);
}

const projects = JSON.parse(readFileSync(projectsFile, "utf-8"));
const registeredIds = new Set(projects.map((p) => p.id));

console.log(`Registered projects: ${projects.length}`);
for (const p of projects) {
	console.log(`  ${p.id} — ${p.name} (${p.rootPath})`);
}

let totalRemoved = 0;

/**
 * Parse a store file. Both GoalStore and SessionStore serialize as a flat
 * JSON array: [ { id, projectId, ... }, ... ]
 */
function loadStoreArray(filePath) {
	if (!existsSync(filePath)) return null;
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8"));
		return Array.isArray(data) ? data : [];
	} catch (err) {
		console.warn(`  Could not parse ${filePath}: ${err.message}`);
		return null;
	}
}

// ── Sessions ────────────────────────────────────────────────────
console.log("\n── Sessions ──");
for (const project of projects) {
	const filePath = join(project.rootPath, ".bobbit", "state", "sessions.json");
	const entries = loadStoreArray(filePath);
	if (entries === null) continue;

	const misrouted = entries.filter((s) => s.projectId && s.projectId !== project.id);

	if (misrouted.length === 0) {
		console.log(`✓ ${project.name}: clean (${entries.length} entries)`);
		continue;
	}

	console.log(`✗ ${project.name}: ${misrouted.length} misrouted out of ${entries.length}`);
	for (const s of misrouted) {
		const reg = registeredIds.has(s.projectId) ? "registered" : "UNREGISTERED";
		console.log(`    ${s.archived ? "ARCH" : "LIVE"}  ${s.id} "${s.title || "(untitled)"}" → projectId=${s.projectId} (${reg})`);
	}

	if (dryRun) {
		console.log(`    [dry-run] Would remove ${misrouted.length} entries`);
	} else {
		const clean = entries.filter((s) => !s.projectId || s.projectId === project.id);
		writeFileSync(filePath, JSON.stringify(clean, null, 2));
		console.log(`    Removed ${misrouted.length} entries`);
	}
	totalRemoved += misrouted.length;
}

// ── Goals ───────────────────────────────────────────────────────
console.log("\n── Goals ──");
for (const project of projects) {
	const filePath = join(project.rootPath, ".bobbit", "state", "goals.json");
	const entries = loadStoreArray(filePath);
	if (entries === null) continue;

	const misrouted = entries.filter((g) => g.projectId && g.projectId !== project.id);

	if (misrouted.length === 0) {
		console.log(`✓ ${project.name}: clean (${entries.length} entries)`);
		continue;
	}

	console.log(`✗ ${project.name}: ${misrouted.length} misrouted out of ${entries.length}`);
	for (const g of misrouted) {
		const reg = registeredIds.has(g.projectId) ? "registered" : "UNREGISTERED";
		console.log(`    ${g.archived ? "ARCH" : "LIVE"}  ${g.id} "${g.title || "(untitled)"}" → projectId=${g.projectId} (${reg})`);
	}

	if (dryRun) {
		console.log(`    [dry-run] Would remove ${misrouted.length} entries`);
	} else {
		const clean = entries.filter((g) => !g.projectId || g.projectId === project.id);
		writeFileSync(filePath, JSON.stringify(clean, null, 2));
		console.log(`    Removed ${misrouted.length} entries`);
	}
	totalRemoved += misrouted.length;
}

console.log();
if (totalRemoved > 0) {
	console.log(dryRun
		? `Would remove ${totalRemoved} total misrouted entries. Run without --dry-run to apply.`
		: `Done. Removed ${totalRemoved} misrouted entries. Restart the server for changes to take effect.`);
} else {
	console.log("All stores are clean — no misrouted entries found.");
}
