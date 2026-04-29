#!/usr/bin/env node
/**
 * forward-merge-master.mjs <missionId> [masterBranch=master]
 *
 * Invoked from the `mission-pr` gate of the mission workflow as a precondition
 * for "Master merged into integration branch". Runs `git fetch origin <master>`
 * + `git merge --no-ff origin/<master>` in the integration worktree.
 *
 * Exit codes:
 *   0 — already up-to-date OR fast-forward merge succeeded
 *   1 — could not locate state OR git failure
 *   2 — merge conflict; integration worktree was reset to clean state
 *
 * The script reads `<state>/missions.json` to find the integration worktree
 * for the given missionId. It deliberately does NOT import server modules so
 * verification harness invocations don't require a hot Node module graph.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

function fail(msg, code = 1) {
	console.error(`[forward-merge-master] ${msg}`);
	process.exit(code);
}

function findStateDir(start) {
	let dir = path.resolve(start);
	for (let i = 0; i < 12; i++) {
		const candidate = path.join(dir, ".bobbit", "state");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const missionId = process.argv[2];
const masterBranch = process.argv[3] || "master";
if (!missionId) fail("usage: forward-merge-master.mjs <missionId> [masterBranch]");

const stateDir =
	process.env.BOBBIT_STATE_DIR && fs.existsSync(process.env.BOBBIT_STATE_DIR)
		? process.env.BOBBIT_STATE_DIR
		: findStateDir(process.cwd());
if (!stateDir) fail(`could not locate .bobbit/state from ${process.cwd()}`);

const missionsFile = path.join(stateDir, "missions.json");
if (!fs.existsSync(missionsFile)) fail(`missing ${missionsFile}`);

let missions;
try {
	missions = JSON.parse(fs.readFileSync(missionsFile, "utf-8"));
} catch (err) {
	fail(`failed to parse ${missionsFile}: ${err.message}`);
}

const mission = missions.find(m => m && m.id === missionId);
if (!mission) fail(`mission not found: ${missionId}`);
if (!mission.integrationWorktree) fail(`mission ${missionId} has no integrationWorktree`);

const wt = mission.integrationWorktree;
if (!fs.existsSync(wt)) fail(`integration worktree does not exist: ${wt}`);

async function git(args, opts = {}) {
	try {
		const { stdout, stderr } = await execFile("git", args, {
			cwd: wt,
			timeout: opts.timeout ?? 60_000,
		});
		return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
	} catch (err) {
		return {
			ok: false,
			stdout: err.stdout ? err.stdout.toString() : "",
			stderr: err.stderr ? err.stderr.toString() : (err.message ?? ""),
			code: typeof err.code === "number" ? err.code : 1,
		};
	}
}

const fetched = await git(["fetch", "origin", masterBranch], { timeout: 90_000 });
if (!fetched.ok) {
	console.warn(`[forward-merge-master] fetch failed (continuing): ${fetched.stderr.trim()}`);
}

const remoteRef = `origin/${masterBranch}`;
const ancestor = await git(["merge-base", "--is-ancestor", remoteRef, "HEAD"]);
if (ancestor.code === 0) {
	console.log(`[forward-merge-master] already up-to-date with ${remoteRef}`);
	process.exit(0);
}

const merge = await git(
	["merge", "--no-ff", "-m", `Mission: forward-merge ${masterBranch}`, remoteRef],
	{ timeout: 180_000 },
);

if (merge.ok) {
	console.log(`[forward-merge-master] merged ${remoteRef} into HEAD`);
	process.exit(0);
}

// Conflict path: collect unmerged files and abort cleanly.
const unmerged = await git(["diff", "--name-only", "--diff-filter=U"]);
const files = unmerged.stdout.split("\n").map(s => s.trim()).filter(Boolean);
await git(["merge", "--abort"]);

console.error(`[forward-merge-master] merge conflict (${files.length} file(s)):`);
for (const f of files) console.error(`  - ${f}`);
process.exit(2);
