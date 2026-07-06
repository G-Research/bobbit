/**
 * SWARM-W4.6 — orchestrator-worker / merge-all.
 *
 * One no-tool decompose role produces a fully-validated fenced JSON shard
 * array before any worker goal or swarm-group record is created. The actual
 * fan-out stays on `createBestOfNSwarm` so barrier/governor/restart behavior is
 * shared with the existing swarm topologies; the group differs only by
 * `topology:"orchestrator-worker"` and `reconcileMode:"merge-all"`.
 */
import type { GoalManager } from "./goal-manager.js";
import type { ProjectContext } from "./project-context.js";
import type { SessionManager } from "./session-manager.js";
import type { TeamManager } from "./team-manager.js";
import type { VerificationHarness } from "./verification-harness.js";
import { createBestOfNSwarm, type BestOfNSwarmResult, type BestOfNSiblingSpec } from "./swarm-best-of-n.js";

export interface OrchestratorWorkerShard {
	title: string;
	spec: string;
	rationale: string;
}

export interface OrchestratorWorkerSwarmOptions {
	parentGoalId: string;
	title: string;
	spec: string;
	tokenBudgetPerNode?: number;
	wallClockMsPerNode?: number;
	hardKillMarginMultiplier?: number;
}

export interface OrchestratorWorkerSwarmResult extends BestOfNSwarmResult {
	shards: OrchestratorWorkerShard[];
	decomposeSessionId: string;
}

export interface OrchestratorWorkerSwarmDeps {
	getContextForGoal(goalId: string): ProjectContext | undefined;
	getGoalManagerForGoal(goalId: string): GoalManager;
	harness: VerificationHarness;
	teamManager: TeamManager;
	sessionManager: SessionManager;
}

const DEFAULT_WORKER_TOKEN_BUDGET = 200_000;
const DEFAULT_WORKER_WALL_CLOCK_MS = 30 * 60_000;
const DECOMPOSE_IDLE_TIMEOUT_MS = 2 * 60_000;
export const ORCHESTRATOR_WORKER_VERIFY_PLACEHOLDER = "true";

export function buildOrchestratorWorkerDecomposePrompt(spec: string): string {
	return [
		"Decompose the following goal into 3 to 5 DISJOINT sub-question shards.",
		"Each shard must be independently completable without needing another shard's output.",
		"Do not decompose if the task is not genuinely parallel — in that case return exactly one shard covering the whole task.",
		"Do not use tools. Respond with ONLY a fenced ```json code block containing an array of 1-5 objects, no prose before or after.",
		'Each shard object must be exactly: { "title": "short imperative title, becomes the child goal\'s title", "spec": "the full sub-question / instructions for this shard\'s worker", "rationale": "one sentence: why this shard is disjoint from the others" }.',
		"",
		"Goal:",
		spec,
	].join("\n");
}

export function parseOrchestratorWorkerShards(output: string): OrchestratorWorkerShard[] {
	const match = output.match(/```json\s*([\s\S]*?)```/i);
	if (!match) throw new Error("Decompose response did not contain a fenced ```json block");
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch (err) {
		throw new Error(`Decompose response contained invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5) {
		throw new Error("Decompose response must be a JSON array with 1 to 5 shard objects");
	}
	return parsed.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Shard ${index + 1} must be an object`);
		}
		const keys = Object.keys(item).sort();
		if (keys.join(",") !== "rationale,spec,title") {
			throw new Error(`Shard ${index + 1} must contain exactly title, spec, and rationale`);
		}
		const raw = item as Record<string, unknown>;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const spec = typeof raw.spec === "string" ? raw.spec.trim() : "";
		const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
		if (!title || !spec || !rationale) {
			throw new Error(`Shard ${index + 1} must have non-empty string title, spec, and rationale`);
		}
		return { title, spec, rationale };
	});
}

export async function createOrchestratorWorkerSwarm(
	deps: OrchestratorWorkerSwarmDeps,
	opts: OrchestratorWorkerSwarmOptions,
): Promise<OrchestratorWorkerSwarmResult> {
	const { parentGoalId, title, spec, tokenBudgetPerNode, wallClockMsPerNode, hardKillMarginMultiplier } = opts;
	if (!spec.trim()) throw new Error("createOrchestratorWorkerSwarm requires a non-empty spec");
	const ctx = deps.getContextForGoal(parentGoalId);
	if (!ctx) throw new Error(`createOrchestratorWorkerSwarm: project context not found for parent goal ${parentGoalId}`);
	const parent = ctx.goalStore.get(parentGoalId);
	if (!parent) throw new Error(`createOrchestratorWorkerSwarm: parent goal not found: ${parentGoalId}`);
	if (parent.paused) throw new Error(`createOrchestratorWorkerSwarm: parent goal ${parentGoalId} is paused`);

	const decomposePrompt = buildOrchestratorWorkerDecomposePrompt(spec);
	const spawned = await deps.teamManager.spawnRole(parentGoalId, "reviewer", decomposePrompt, {
		allowedTools: [],
		promptProfile: "narrow-worker",
	});
	await deps.sessionManager.waitForStreaming(spawned.sessionId, 10_000).catch(() => {});
	await deps.sessionManager.waitForIdle(spawned.sessionId, DECOMPOSE_IDLE_TIMEOUT_MS);
	const decomposeOutput = (await deps.sessionManager.getSessionOutput(spawned.sessionId)).trim();
	const shards = parseOrchestratorWorkerShards(decomposeOutput);

	const siblings: BestOfNSiblingSpec[] = shards.map((shard) => ({
		title: shard.title,
		spec: [
			"## Orchestrator-worker shard",
			"",
			shard.spec,
			"",
			"## Disjointness rationale",
			shard.rationale,
		].join("\n"),
	}));
	const result = await createBestOfNSwarm(deps, {
		parentGoalId,
		title,
		spec,
		siblings,
		tokenBudgetPerNode: tokenBudgetPerNode && tokenBudgetPerNode > 0 ? tokenBudgetPerNode : DEFAULT_WORKER_TOKEN_BUDGET,
		wallClockMsPerNode: wallClockMsPerNode && wallClockMsPerNode > 0 ? wallClockMsPerNode : DEFAULT_WORKER_WALL_CLOCK_MS,
		hardKillMarginMultiplier,
		verifyCommand: ORCHESTRATOR_WORKER_VERIFY_PLACEHOLDER,
		earlyKill: false,
		topology: "orchestrator-worker",
		reconcileMode: "merge-all",
	});
	return { ...result, shards, decomposeSessionId: spawned.sessionId };
}
