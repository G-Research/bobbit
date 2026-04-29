#!/usr/bin/env node
/**
 * check-mission-execution.mjs <missionId>
 *
 * Invoked by the `execution` gate verification of the mission workflow.
 * Exit 0 iff every plan node in the mission has:
 *   - goalId set (child goal spawned)
 *   - the corresponding goal's `ready-to-merge` gate is `passed`
 *   - the plan node has `mergedAt` set (Commander merged it into integration)
 *
 * Reads `<project>/.bobbit/state/missions.json`, `goals.json`, `gates.json`
 * directly. The script walks up from the cwd looking for `.bobbit/state/`
 * (the verification harness runs commands in the integration worktree, but
 * the state files live under the project root).
 */
import fs from "node:fs";
import path from "node:path";

function fail(msg) {
	console.error(`[check-mission-execution] ${msg}`);
	process.exit(1);
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
if (!missionId) fail("usage: check-mission-execution.mjs <missionId>");

const stateDir =
	process.env.BOBBIT_STATE_DIR && fs.existsSync(process.env.BOBBIT_STATE_DIR)
		? process.env.BOBBIT_STATE_DIR
		: findStateDir(process.cwd());
if (!stateDir) fail(`could not locate .bobbit/state from ${process.cwd()}`);

function readJson(file) {
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		fail(`failed to parse ${file}: ${err.message}`);
	}
}

const missions = readJson(path.join(stateDir, "missions.json")) ?? [];
const goals = readJson(path.join(stateDir, "goals.json")) ?? [];
const gates = readJson(path.join(stateDir, "gates.json")) ?? [];

const mission = missions.find(m => m && m.id === missionId);
if (!mission) fail(`mission not found: ${missionId}`);
if (!mission.plan || !Array.isArray(mission.plan.goals) || mission.plan.goals.length === 0) {
	fail(`mission ${missionId} has no plan or empty plan`);
}

const goalsById = new Map(goals.map(g => [g.id, g]));

/**
 * Find a gate state record by (ownerKind, ownerId, gateId). Falls back to
 * the legacy goalId-keyed shape so this script works during the gate-store
 * migration window (Coder B's work).
 */
function findGate(kind, ownerId, gateId) {
	for (const g of gates) {
		if (!g || g.gateId !== gateId) continue;
		const k = g.ownerKind ?? "goal";
		const o = g.ownerId ?? g.goalId;
		if (k === kind && o === ownerId) return g;
	}
	return null;
}

const failures = [];
for (const node of mission.plan.goals) {
	const tag = node.title ? `${node.planId} (${node.title})` : node.planId;
	if (!node.goalId) {
		failures.push(`${tag}: not spawned`);
		continue;
	}
	const goal = goalsById.get(node.goalId);
	if (!goal) {
		failures.push(`${tag}: goalId ${node.goalId} not found`);
		continue;
	}
	const rtm = findGate("goal", node.goalId, "ready-to-merge");
	if (!rtm || rtm.status !== "passed") {
		failures.push(`${tag}: ready-to-merge gate not passed (status=${rtm?.status ?? "missing"})`);
		continue;
	}
	if (!node.mergedAt) {
		failures.push(`${tag}: not merged into integration branch`);
	}
}

if (failures.length > 0) {
	console.error(`[check-mission-execution] ${failures.length} plan node(s) not ready:`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log(`[check-mission-execution] OK: ${mission.plan.goals.length} plan nodes complete and merged`);
process.exit(0);
