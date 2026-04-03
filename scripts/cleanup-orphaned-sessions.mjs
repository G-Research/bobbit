#!/usr/bin/env node
/**
 * Cleanup script: remove sessions and goals that were archived into the wrong
 * project store due to a bug in terminateSession() (resolved store after
 * deleting from in-memory map, causing fallback to default project store).
 *
 * What it does:
 *   1. Reads the project registry to find registered project IDs
 *   2. Scans each project's sessions.json for entries whose projectId
 *      doesn't match that project — these are misrouted entries
 *   3. Removes (or optionally moves) misrouted entries
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
console.log();

let totalRemoved = 0;

// For each project, check its sessions.json for misrouted entries
for (const project of projects) {
	const sessionsFile = join(project.rootPath, ".bobbit", "state", "sessions.json");
	if (!existsSync(sessionsFile)) continue;

	let data;
	try {
		data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
	} catch (err) {
		console.warn(`  Could not parse ${sessionsFile}: ${err.message}`);
		continue;
	}

	const live = data.sessions || [];
	const archived = data.archived || [];

	// Misrouted = has a projectId that doesn't match this project
	const misroutedLive = live.filter(
		(s) => s.projectId && s.projectId !== project.id,
	);
	const misroutedArchived = archived.filter(
		(s) => s.projectId && s.projectId !== project.id,
	);
	// Also find entries whose projectId is not registered at all (truly orphaned)
	const orphanedLive = live.filter(
		(s) => s.projectId && !registeredIds.has(s.projectId),
	);
	const orphanedArchived = archived.filter(
		(s) => s.projectId && !registeredIds.has(s.projectId),
	);

	const misrouted = misroutedLive.length + misroutedArchived.length;
	const orphaned = orphanedLive.length + orphanedArchived.length;

	if (misrouted === 0 && orphaned === 0) {
		console.log(`✓ ${project.name}: clean (${live.length} live, ${archived.length} archived)`);
		continue;
	}

	console.log(`✗ ${project.name}: ${misrouted} misrouted, ${orphaned} orphaned`);

	for (const s of misroutedLive) {
		const registered = registeredIds.has(s.projectId);
		console.log(`    LIVE  ${s.id} "${s.title || "(untitled)"}" → projectId=${s.projectId} (${registered ? "registered" : "UNREGISTERED"})`);
	}
	for (const s of misroutedArchived) {
		const registered = registeredIds.has(s.projectId);
		console.log(`    ARCH  ${s.id} "${s.title || "(untitled)"}" → projectId=${s.projectId} (${registered ? "registered" : "UNREGISTERED"})`);
	}

	if (dryRun) {
		console.log(`    [dry-run] Would remove ${misrouted} entries`);
		totalRemoved += misrouted;
		continue;
	}

	// Remove misrouted entries
	data.sessions = live.filter((s) => !s.projectId || s.projectId === project.id);
	data.archived = archived.filter((s) => !s.projectId || s.projectId === project.id);
	writeFileSync(sessionsFile, JSON.stringify(data, null, 2));
	console.log(`    Removed ${misrouted} misrouted entries from ${sessionsFile}`);
	totalRemoved += misrouted;
}

// Also check for misrouted goals
console.log();
for (const project of projects) {
	const goalsFile = join(project.rootPath, ".bobbit", "state", "goals.json");
	if (!existsSync(goalsFile)) continue;

	let data;
	try {
		data = JSON.parse(readFileSync(goalsFile, "utf-8"));
	} catch (err) {
		console.warn(`  Could not parse ${goalsFile}: ${err.message}`);
		continue;
	}

	const live = data.goals || [];
	const archived = data.archived || [];

	const misroutedLive = live.filter((g) => g.projectId && g.projectId !== project.id);
	const misroutedArchived = archived.filter((g) => g.projectId && g.projectId !== project.id);
	const misrouted = misroutedLive.length + misroutedArchived.length;

	if (misrouted === 0) {
		console.log(`✓ ${project.name} goals: clean (${live.length} live, ${archived.length} archived)`);
		continue;
	}

	console.log(`✗ ${project.name} goals: ${misrouted} misrouted`);
	for (const g of [...misroutedLive, ...misroutedArchived]) {
		const registered = registeredIds.has(g.projectId);
		console.log(`    ${g.archived ? "ARCH" : "LIVE"}  ${g.id} "${g.title || "(untitled)"}" → projectId=${g.projectId} (${registered ? "registered" : "UNREGISTERED"})`);
	}

	if (dryRun) {
		console.log(`    [dry-run] Would remove ${misrouted} entries`);
		totalRemoved += misrouted;
		continue;
	}

	data.goals = live.filter((g) => !g.projectId || g.projectId === project.id);
	data.archived = archived.filter((g) => !g.projectId || g.projectId === project.id);
	writeFileSync(goalsFile, JSON.stringify(data, null, 2));
	console.log(`    Removed ${misrouted} misrouted entries from ${goalsFile}`);
	totalRemoved += misrouted;
}

console.log();
if (totalRemoved > 0) {
	console.log(dryRun
		? `Would remove ${totalRemoved} total misrouted entries. Run without --dry-run to apply.`
		: `Done. Removed ${totalRemoved} misrouted entries. Restart the server for changes to take effect.`);
} else {
	console.log("All stores are clean — no misrouted entries found.");
}
