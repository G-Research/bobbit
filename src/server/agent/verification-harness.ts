import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Cross-platform check: is `pid` currently a live process?
 *
 * `process.kill(pid, 0)` sends signal 0, which performs the permission /
 * existence check without delivering any signal. We treat both "no throw"
 * and `EPERM` as alive — the latter happens when the pid exists but we
 * don't own it, which on Windows can occur for detached children spawned
 * across user sessions but still counts as "the process is alive". Any
 * other error (notably `ESRCH`) means the process is gone.
 */
function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}
import type { GateStore, GateSignal, GateSignalStep } from "./gate-store.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { RoleStore } from "./role-store.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import { detectPrimaryBranch, parseBaseRef } from "../skills/git.js";
import type { WorkflowGate, VerifyStep } from "./workflow-store.js";
import type { ProjectConfigStore, Component } from "./project-config-store.js";
import { WorkflowResolveError } from "./workflow-validator.js";
import { getVerificationShell, GIT_BASH } from "./shell-util.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import { generateTeamName } from "./team-names.js";
import {
	substituteVars as _substituteVars,
	isTransientReviewError,
	isTransientQaError,
	matchExpectFailure,
	groupStepsByPhase,
	getSortedPhases,
	isCommandStepSkippable,
	partitionOptionalSteps,
	buildStepCache,
	computeAllPassed,
	canSkipAllSteps,
	detectJsonValidationError,
	isPreImplementationGate,
} from "./verification-logic.js";
import { Semaphore } from "./semaphore.js";
import { applyReviewModelOverrides, applyModelString } from "./review-model-override.js";
import { THINKING_LEVELS, clampThinkingLevel } from "../../shared/thinking-levels.js";
import { inferMeta } from "./aigw-manager.js";

/**
 * Clamp a thinking-level value against the resolved reviewer/QA model. When
 * the model string is in canonical `provider/modelId` form, infer reasoning
 * metadata and clamp. When no model is resolvable, return the value as-is
 * (the agent will fall back to its built-in default).
 */
function clampReviewThinking(level: string | undefined, modelStr: string | undefined): string | undefined {
	if (!level) return level;
	if (!modelStr) return level;
	const slash = modelStr.indexOf("/");
	if (slash <= 0) return level;
	const provider = modelStr.slice(0, slash);
	const modelId = modelStr.slice(slash + 1);
	const meta = inferMeta(modelId);
	return clampThinkingLevel(level, { id: modelId, provider, reasoning: meta.reasoning });
}

/**
 * Returns the **un-offset** branch container path for a goal — the directory
 * that `resolveStep()` / `componentRoot()` expect as their `branchContainer`
 * argument. Component step resolution layers `repo + relativePath` on top of
 * this value; if you pass `goal.cwd` (which may already include the project's
 * `rootPath` offset relative to the git repo root), the offset is applied
 * twice and verification fails with ENOENT on a doubled path segment.
 *
 * Pinned by `tests/verify-step-resolution.test.ts`.
 */
export function goalBranchContainer(goal: { worktreePath?: string; cwd: string }): string {
	// BUG: should be `goal.worktreePath ?? goal.cwd`. Pinned by the regression test;
	// the Implementation gate flips this to the correct expression.
	return goal.cwd;
}

/**
 * Compute the absolute working directory for a component, given a per-branch
 * container root. For single-repo projects, components have `repo: "."` and
 * (typically) no `relativePath`, collapsing to `branchContainer`. For
 * multi-repo / monorepo cases, this is `<branchContainer>/<repo>/<relativePath>`.
 *
 * Phase 2 only exercises the single-repo collapse; multi-repo plumbing lives
 * in Phase 4. The helper is written for both so verification doesn't need to
 * change again when Phase 4 lands.
 */
function componentRoot(c: Component, branchContainer: string): string {
	let p = branchContainer;
	if (c.repo && c.repo !== ".") p = path.join(p, c.repo);
	if (c.relativePath) p = path.join(p, c.relativePath);
	return p;
}

/**
 * Structural step resolution — see docs/design/multi-repo-components.md §3.3.
 *
 * Given a workflow step, the project's components[] (from project.yaml), and
 * the per-branch container root, return:
 *   - `cwd`: where the step should run
 *   - `runString`: the literal shell command, or `undefined` for non-command
 *     step types (callers handle those separately).
 *
 * Three command shapes are supported:
 *   { component, command }  → lookup `components[name].commands[name]`
 *   { component, run }      → literal `run`, cwd at component root
 *   { run }                 → literal `run`, cwd at branchContainer
 *
 * Throws `WorkflowResolveError` on unknown component / unknown command pairs
 * — the validator catches these at load-time, but runtime resolution still
 * defends in case the workflow snapshot was created before component edits.
 */
export function resolveStep(
	step: VerifyStep,
	components: Component[],
	branchContainer: string,
	ctx?: { workflow?: string; gate?: string; stepIndex?: number },
): { cwd: string; runString?: string } {
	if (step.type !== "command") {
		return { cwd: branchContainer };
	}
	const hasComponent = typeof step.component === "string" && step.component.length > 0;
	const hasCommand = typeof step.command === "string" && step.command.length > 0;

	if (hasComponent) {
		const c = components.find(x => x.name === step.component);
		if (!c) {
			throw new WorkflowResolveError({
				workflow: ctx?.workflow ?? "(unknown)",
				gate: ctx?.gate ?? "(unknown)",
				stepIndex: ctx?.stepIndex ?? 0,
				stepName: step.name,
				reason: `component "${step.component}" not found in components[].`,
			});
		}
		const cwd = componentRoot(c, branchContainer);
		if (hasCommand) {
			const run = c.commands?.[step.command as string];
			if (!run) {
				const available = c.commands ? Object.keys(c.commands).join(", ") : "(none)";
				throw new WorkflowResolveError({
					workflow: ctx?.workflow ?? "(unknown)",
					gate: ctx?.gate ?? "(unknown)",
					stepIndex: ctx?.stepIndex ?? 0,
					stepName: step.name,
					reason: `component "${c.name}" has no command "${step.command}". Available: ${available}.`,
				});
			}
			return { cwd, runString: run };
		}
		return { cwd, runString: step.run };
	}
	// Free-form pure { run } at the per-branch container root.
	return { cwd: branchContainer, runString: step.run };
}

/** Create a deferred promise with exposed resolve/reject. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: any) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** Structured result delivered by the verification_result tool. */
export interface VerificationResult {
	verdict: boolean;
	summary: string;
	reportHtml?: string;
}

/** Reminder prompt sent when an agent goes idle without calling verification_result. */
export const VERIFICATION_RESULT_REMINDER =
	"You went idle without submitting your results. " +
	"Call the `verification_result` tool now with your verdict and summary. " +
	"This is REQUIRED — the verification system only receives results through this tool.";

/**
 * The `verification_result` tool is now a standard goal tool registered in
 * `.bobbit/config/tools/tasks/extension.ts` — no generated extension needed.
 * It calls POST /api/internal/verification-result using the same api() helper
 * as gate_signal, task_update, etc.
 */

// Re-export transient error detection from verification-logic.ts for backward compatibility.
export { isTransientReviewError, isTransientQaError, detectJsonValidationError } from "./verification-logic.js";

/**
 * Build a targeted retry prompt that quotes the validation error back to the
 * model. Keeps the generic `VERIFICATION_RESULT_REMINDER` wording as fallback
 * context so the agent still knows *what* to call.
 */
/** Best-effort extract of a readable string from an agent tool result. */
function extractToolResultText(result: any): string {
	if (!result) return "";
	if (typeof result === "string") return result;
	try {
		const content = result.content;
		if (Array.isArray(content)) {
			return content
				.map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
				.join("\n");
		}
		if (typeof content === "string") return content;
	} catch { /* ignore */ }
	try { return JSON.stringify(result); } catch { return String(result); }
}

function buildJsonRetryPrompt(quotedError: string): string {
	return (
		`Your previous tool call failed with a JSON / argument validation error:\n\n` +
		`    ${quotedError}\n\n` +
		`This is almost certainly a streaming glitch in your previous attempt, not a real problem with your analysis. ` +
		`Re-emit the \`verification_result\` tool call now with well-formed JSON: ` +
		`ensure every property name is double-quoted, every string value is properly escaped, ` +
		`and the arguments match the tool's schema (\`verdict\`: "pass"|"fail", \`summary\`: string). ` +
		`Do not re-run any analysis — just submit your verdict.`
	);
}

/**
 * In-flight verification state for REST bootstrapping.
 *
 * Per-step fields used for the "command subprocess survives a gateway
 * restart" scheme (Layer 1) and the duplicate-detection backstop (Layer 2):
 *
 * - `pid` / `startTimeMs` — child process id and spawn wall-clock time.
 *   Together with `bootEpoch` they identify a process we ourselves started.
 * - `outFile` / `errFile` / `exitFile` — files written by a small bash
 *   wrapper around the real command. `exitFile` is renamed into place
 *   atomically when the real command finishes, so even SIGKILL of the
 *   gateway leaves either no exit file (still running) or a complete one
 *   (finished). On resume we tail `outFile`/`errFile` and read `exitFile`
 *   to finalize the step. Only non-container command steps use this path;
 *   docker-exec steps stay on the simpler attached-pipe path because the
 *   exit file would have to live inside the container.
 * - `bootEpoch` — random UUID generated once per VerificationHarness
 *   instance (i.e. per server process). A step whose bootEpoch matches the
 *   current harness was started by THIS process and so its `pid`/file
 *   layout are addressable here. A step whose bootEpoch differs (or is
 *   absent) was started by a previous server lifetime and is treated as
 *   dead unless `pid` + `process.kill(pid, 0)` proves otherwise.
 */
export interface ActiveVerification {
	goalId: string;
	gateId: string;
	signalId: string;
	steps: Array<{
		name: string;
		type: string;
		status: "running" | "passed" | "failed" | "skipped" | "waiting";
		phase?: number;
		durationMs?: number;
		output?: string;
		startedAt: number;
		sessionId?: string;
		/** OS process id of the spawned command (Layer 1). */
		pid?: number;
		/** Date.now() at spawn — tie-breaker against pid reuse. */
		startTimeMs?: number;
		/** Absolute path to detached child's stdout file (Layer 1). */
		outFile?: string;
		/** Absolute path to detached child's stderr file (Layer 1). */
		errFile?: string;
		/** Absolute path to detached child's exit-code file (Layer 1). */
		exitFile?: string;
		/** bootEpoch of the harness that started this step (Layer 2). */
		bootEpoch?: string;
		/** Step timeout in seconds — propagated for resume budget computation. */
		timeoutSec?: number;
		/** Whether the step expects a non-zero exit (for matchExpectFailure). */
		expectFailure?: boolean;
		/** Optional error-pattern regex for expectFailure matching. */
		errorPattern?: string;
	}>;
	currentPhase?: number;
	overallStatus: "running" | "passed" | "failed" | "cancelled";
	startedAt: number;
	cancelled?: boolean;
}

/**
 * Build the combined system prompt for a review step.
 *
 * Exported at module scope so unit tests can import it directly without
 * instantiating a harness. See docs/goals-workflows-tasks.md — "Gate
 * verification baselines".
 *
 * Branches on `isPreImplementationGate(gate)`:
 * - Pre-implementation (content gate with no upstream): no git diff/log
 *   instructions; `Baseline: none (design gate — no implementation expected)`.
 * - Implementation and later: `git diff origin/<primary>...HEAD` forms; the
 *   `Baseline` line records the resolved origin SHA so failures are trivial
 *   to diagnose.
 */
export async function buildReviewPrompt(
	role: { promptTemplate: string; name?: string },
	step: { name: string; prompt?: string },
	cwd: string,
	builtinVars: Record<string, string>,
	signalContent?: string,
	signalMetadata?: Record<string, string>,
	goalSpec?: string,
	allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
	gate?: { content?: boolean; depends_on?: string[]; dependsOn?: string[] },
): Promise<string> {
	const isDesignGate = gate ? isPreImplementationGate(gate) : false;
	const master = builtinVars.master || "master";
	const branch = builtinVars.branch || "HEAD";
	const commit = builtinVars.commit || "HEAD";

	// Working-directory / review-context block, branches on gate kind.
	const reviewContext = isDesignGate
		? [
			"## Working Directory",
			"Your working directory is the goal's worktree. **This is a pre-implementation",
			"design gate — there is no code on the branch yet.** Do NOT run `git diff` or",
			"`git log`. Evaluate the design content (provided in your prompt) only.",
		].join("\n")
		: [
			"## Working Directory",
			`Your working directory is already set to the goal's worktree, checked out on`,
			`branch \`${branch}\` at the correct commit. **Do NOT run \`git checkout\` or`,
			"`git pull`** — the directory is already in the right state.",
			"",
			"To see what changed:",
			`- \`git diff --stat origin/${master}...HEAD -- . ':!package-lock.json'\` — summary`,
			`- \`git diff origin/${master}...HEAD -M -- . ':!package-lock.json'\` — with rename detection`,
			`- \`git log --oneline origin/${master}..HEAD\` — commits on this branch`,
			"- Read files directly with `read` — they are already at the correct version",
		].join("\n");

	let rolePrompt = role.promptTemplate
		.replace(/\{\{REVIEW_CONTEXT\}\}/g, reviewContext)
		.replace(/\{\{GOAL_BRANCH\}\}/g, branch)
		.replace(/\{\{AGENT_ID\}\}/g, role.name || "reviewer");

	const sections: string[] = [rolePrompt];

	if (step.prompt) {
		sections.push(`\n## Review Step Instructions\n\n${step.prompt}`);
	}

	sections.push([
		"\n## CRITICAL: Submitting Your Results",
		"",
		"When your review is complete, you MUST call the `verification_result` tool:",
		'- `verdict`: "pass" if no critical or high severity findings, "fail" otherwise',
		"- `summary`: detailed markdown summary of your findings — use headings, bullet lists, code blocks with file:line references",
		"Your summary should be detailed markdown: use headings, bullet lists, code blocks with file references.",
		"Structure it as: what was reviewed, specific findings with file:line, verdict rationale.",
		"",
		"This tool call is how the verification system receives your results.",
		"If you go idle without calling it, your review fails automatically.",
		"",
		"Do NOT emit <verdict> tags. Do NOT call gate_signal. Just call verification_result.",
	].join("\n"));

	if (goalSpec) {
		sections.push(`\n## Goal Specification\n\n${goalSpec}`);
	}

	if (allGateStates) {
		const upstreamParts: string[] = [];
		for (const [gateId, gs] of allGateStates) {
			if (gs.status === "passed" && gs.injectDownstream && gs.content) {
				upstreamParts.push(`### Gate: ${gateId}\n\n${gs.content}`);
			}
		}
		if (upstreamParts.length > 0) {
			sections.push(`\n## Upstream Gate Content\n\n${upstreamParts.join("\n\n")}`);
		}
	}

	// Resolve baseline SHA for implementation gates. Non-fatal if unresolved.
	let baselineLine: string;
	if (isDesignGate) {
		baselineLine = "- Baseline: none (design gate — no implementation expected)";
	} else {
		let baselineSha: string | null = null;
		try {
			const { execFile: execFileCb } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFileCb);
			const { stdout } = await execFileAsync("git", ["rev-parse", `origin/${master}`], { cwd, timeout: 5_000 });
			baselineSha = stdout.toString().trim().slice(0, 12);
		} catch {
			baselineSha = null;
		}
		baselineLine = baselineSha
			? `- Baseline: diffed against origin/${master}@${baselineSha}`
			: `- Baseline: origin/${master} (sha unresolved)`;
	}

	const contextLines: string[] = [];
	if (isDesignGate) {
		contextLines.push(
			"\n## Pre-Implementation Design Gate",
			"",
			"This is a PRE-IMPLEMENTATION design gate. The goal branch is expected to have",
			"zero goal-unique commits at this stage. **Do NOT run `git diff`, `git log`,",
			"or any branch-comparison command — there is no implementation to compare",
			"against.** Evaluate the design content only, using the \"Signal Content\" and",
			"\"Upstream Gate Content\" sections below.",
			"",
			"## Signal Context",
			`- Branch: ${branch}`,
			`- Commit: ${commit}`,
			baselineLine,
			`- Working directory: ${cwd}`,
		);
	} else {
		contextLines.push(
			"\n## Working Directory & Branch Setup",
			"",
			"**Your working directory is already set up correctly.** It is the goal's worktree,",
			`checked out on branch \`${branch}\` at commit \`${commit}\`.`,
			"",
			"**Do NOT run `git checkout`, `git pull`, `git fetch`, or any command that modifies the working tree.**",
			"Other reviewers may be reading from this directory concurrently. Mutating it causes stale reads.",
			"",
			"To see what changed (read-only, safe for concurrent use):",
			`- \`git diff --stat origin/${master}...HEAD -- . ':!package-lock.json'\` — summary of which files changed`,
			`- \`git diff origin/${master}...HEAD -M -- . ':!package-lock.json'\` — branch diff with rename detection (collapses pure renames)`,
			`- For large diffs, review individual files with \`read\` instead of loading the full diff into context`,
			`- \`git log --oneline origin/${master}..HEAD\` — commits on this branch`,
			"- Use `read` to view files directly — they are already at the correct version",
			"",
			"## Signal Context",
			`- Branch: ${branch}`,
			`- Commit: ${commit}`,
			`- Primary branch: ${master}`,
			baselineLine,
			`- Working directory: ${cwd}`,
		);
	}

	if (signalContent) {
		contextLines.push(`\n### Signal Content\n${signalContent}`);
	}
	if (signalMetadata && Object.keys(signalMetadata).length > 0) {
		contextLines.push("\n### Signal Metadata");
		for (const [k, v] of Object.entries(signalMetadata)) {
			contextLines.push(`- **${k}**: ${v}`);
		}
	}
	sections.push(contextLines.join("\n"));

	return sections.join("\n");
}

export class VerificationHarness {
	private notifyTeamLeadFn?: (goalId: string, message: string) => void;
	private activeVerifications = new Map<string, ActiveVerification>();
	private readonly _persistPath: string;
	private projectContextManager: ProjectContextManager | null;

	/**
	 * Per-process random UUID stamped on every step that this harness
	 * instance starts (Layer 2 — see `ActiveVerification` jsdoc). On boot,
	 * any persisted step whose `bootEpoch` does not match was started by a
	 * previous server lifetime and its `pid`/file paths are not addressable
	 * by this process. Used by `areVerificationSessionsAlive` and the
	 * resume path to distinguish "we own this child" from "this is a
	 * zombie persisted from before restart".
	 */
	private readonly bootEpoch: string = randomUUID();

	/** Flag for one-time cmd.exe detached-mode degradation warning. */
	private static _warnedCmdExeDetached = false;

	/** Limits concurrent command steps (type-check, tests) across all goals. */
	private commandSemaphore = new Semaphore(4);


	/** Pending verification_result resolvers keyed by sessionId. */
	public pendingResults = new Map<string, (result: VerificationResult) => void>();

	/**
	 * @deprecated The verification_result tool is now registered via the standard
	 * goal tools extension. No generated extension file needed.
	 */

	/** Get all active (in-flight) verifications, optionally filtered by goalId */
	getActiveVerifications(goalId?: string): ActiveVerification[] {
		const all = [...this.activeVerifications.values()];
		return goalId ? all.filter(v => v.goalId === goalId) : all;
	}

	/**
	 * Check if any verification sessions for a given signalId are still alive.
	 *
	 * "Alive" means we have evidence the OS process / agent session is still
	 * doing useful work — not merely that the persisted `status === "running"`
	 * flag survives on disk after a restart.
	 *
	 * Rules:
	 * - `waiting` steps → alive (haven't started yet, phase-gated).
	 * - LLM/agent steps with `sessionId` → alive iff sessionManager has the
	 *   session.
	 * - Command steps → alive iff THIS process started the child
	 *   (`step.bootEpoch === this.bootEpoch`) AND the recorded `pid` is
	 *   still running. After a server restart, bootEpoch always differs,
	 *   so persisted-running command steps correctly read as not-alive and
	 *   the duplicate-detection path can reclaim the gate.
	 */
	areVerificationSessionsAlive(signalId: string): boolean {
		const active = this.activeVerifications.get(signalId);
		if (!active) return false;
		// If any step is still waiting to start, the verification is not a zombie
		if (active.steps.some(s => s.status === "waiting")) return true;
		for (const step of active.steps) {
			if (step.status !== "running") continue;
			if (step.sessionId) {
				// LLM/agent steps — check if session is still alive
				const session = this.sessionManager?.getSession(step.sessionId);
				if (session) return true;
				continue;
			}
			// Command step. Only count as alive when we have positive evidence
			// that THIS process started it AND its pid is still resolvable.
			if (step.bootEpoch === this.bootEpoch && typeof step.pid === "number") {
				if (isPidAlive(step.pid)) return true;
			}
			// Otherwise: persisted-running command step from a previous server
			// lifetime — treat as dead so duplicate-detection can auto-cancel.
		}
		return false;
	}

	/**
	 * Return session IDs from persisted active verifications that are still running.
	 * Used by SessionManager to skip orphan cleanup for sessions that will be resumed.
	 */
	getResumingSessionIds(): Set<string> {
		const ids = new Set<string>();
		const persisted = this._loadActive();
		for (const v of persisted) {
			if (v.overallStatus !== "running") continue;
			for (const step of v.steps) {
				if (step.sessionId && step.status === "running") {
					ids.add(step.sessionId);
				}
			}
		}
		return ids;
	}

	/** Persist active verifications to disk. */
	private _persistActive(): void {
		try {
			const data = { verifications: [...this.activeVerifications.values()] };
			// Defensive: ensure parent dir exists. It is created at startup but may
			// be removed mid-run by external cleanup (test teardown, maintenance,
			// AV quirks). Recreating on demand keeps persistence robust.
			const dir = path.dirname(this._persistPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(this._persistPath, JSON.stringify(data, null, 2));
		} catch (err) {
			console.error("[verification] Failed to persist active verifications:", err);
		}
	}

	/** Load persisted active verifications from disk. */
	private _loadActive(): ActiveVerification[] {
		try {
			if (!fs.existsSync(this._persistPath)) return [];
			const raw = fs.readFileSync(this._persistPath, "utf-8");
			const data = JSON.parse(raw);
			return Array.isArray(data.verifications) ? data.verifications : [];
		} catch (err) {
			console.error("[verification] Failed to load persisted active verifications:", err);
			return [];
		}
	}

	/**
	 * Resume verifications that were interrupted by a server restart.
	 * For running steps with sessionIds, attempts to extract or obtain a verdict
	 * from the restored reviewer session. Fire-and-forget from the caller.
	 */
	async resumeInterruptedVerifications(): Promise<void> {
		const persisted = this._loadActive();
		if (persisted.length === 0) return;

		const running = persisted.filter(v => v.overallStatus === "running");
		if (running.length === 0) {
			// Clean up stale file
			try { fs.unlinkSync(this._persistPath); } catch {}
			return;
		}

		console.log(`[verification] Resuming ${running.length} interrupted verification(s)...`);

		for (const v of running) {
			try {
				// Skip verifications for goals that completed/shelved while we were down
				const goal = this.projectContextManager?.getContextForGoal(v.goalId)?.goalStore.get(v.goalId);
				if (goal && (goal.state === "complete" || goal.state === "shelved")) {
					console.log(`[verification] Skipping resume for ${v.signalId} — goal ${v.goalId} is ${goal.state}`);
					this.activeVerifications.delete(v.signalId);
					this._persistActive();
					continue;
				}
				await this._resumeOneVerification(v);
			} catch (err) {
				console.error(`[verification] Failed to resume verification ${v.signalId}:`, err);
				// Best-effort: mark as failed and update gate. Wrap each external
				// store call in try/catch so a missing goal/gate doesn't stop us
				// from cleaning up the in-memory entry below — leaving it would
				// reproduce the HTTP 409 lock-after-restart bug.
				try {
					this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
						status: "failed",
						steps: [{ name: "Resume Error", type: "command", passed: false, output: `Failed to resume after restart: ${(err as Error).message}`, duration_ms: 0 }],
					});
					this.resolveGateStore(v.goalId).updateGateStatus(v.goalId, v.gateId, "failed");
				} catch (storeErr) {
					console.error(`[verification] Failed to update gate store for ${v.signalId} during resume cleanup:`, storeErr);
				}
				try {
					this.broadcastFn(v.goalId, {
						type: "gate_verification_complete",
						goalId: v.goalId, gateId: v.gateId, signalId: v.signalId, status: "failed",
					});
					this.broadcastFn(v.goalId, {
						type: "gate_status_changed",
						goalId: v.goalId, gateId: v.gateId, status: "failed",
					});
					this.notifyTeamLead(v.goalId, v.gateId, "failed");
				} catch (bcastErr) {
					console.error(`[verification] Failed to broadcast failure for ${v.signalId} during resume cleanup:`, bcastErr);
				}
			} finally {
				// Synchronously drop the in-memory entry so subsequent
				// gate_signal calls on the same SHA aren't rejected with HTTP 409
				// by areVerificationSessionsAlive seeing a leftover "running" step
				// from a previous server lifetime (Layer 2 acceptance criterion).
				this.activeVerifications.delete(v.signalId);
			}
		}

		// Clear persisted file after all verifications finalized
		try { fs.unlinkSync(this._persistPath); } catch {}
		console.log("[verification] Finished resuming interrupted verifications.");
	}

	/**
	 * Look up the original VerifyStep definition from the goal's snapshotted workflow.
	 * Returns undefined if not found (goal deleted, workflow missing, etc.).
	 */
	private _findStepDefinition(goalId: string, gateId: string, stepName: string): VerifyStep | undefined {
		const goal = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
		if (!goal?.workflow?.gates) return undefined;
		const gate = goal.workflow.gates.find((g: any) => g.id === gateId);
		if (!gate?.verify) return undefined;
		return gate.verify.find((s: any) => s.name === stepName);
	}

	/**
	 * Gather the context needed to re-run an LLM review step from scratch.
	 * Returns null if context is unavailable (goal deleted, etc.).
	 */
	private async _gatherRerunContext(goalId: string, gateId: string, signalId: string): Promise<{
		signal: GateSignal;
		cwd: string;
		builtinVars: Record<string, string>;
		goalSpec?: string;
		allGateStates: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>;
		gate?: WorkflowGate;
	} | null> {
		const goal = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
		if (!goal) return null;

		const gateStore = this.resolveGateStore(goalId);
		const gateState = gateStore.getGate(goalId, gateId);
		if (!gateState) return null;

		const signal = gateState.signals.find(s => s.id === signalId);
		if (!signal) return null;

		const cwd = goal.worktreePath || goal.cwd;
		const primary = await detectPrimaryBranch(cwd).catch(() => "master");
		// {{baseBranch}} — bare branch name derived from the project's `base_ref`,
		// or `primary` when unset. {{master}} stays bound to `detectPrimaryBranch`
		// (the project primary), independent of `base_ref`. See
		// `docs/design/base-ref.md` §3.
		const configuredBaseRef = this.resolveProjectConfigStore(goalId)?.get("base_ref") ?? "";
		const baseBranch = parseBaseRef(configuredBaseRef).branch || primary;
		const builtinVars: Record<string, string> = {
			branch: goal.branch || "HEAD",
			master: primary,
			baseBranch,
			cwd,
			goal_spec: goal.spec || "",
			commit: signal.commitSha || "HEAD",
		};
		const rerunGate = goal.workflow?.gates?.find((g: any) => g.id === gateId) as WorkflowGate | undefined;

		// Build allGateStates for variable substitution
		const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
		const allGates = gateStore.getGatesForGoal(goalId);
		for (const g of allGates) {
			const gateDef = goal.workflow?.gates?.find((wg: any) => wg.id === g.gateId);
			allGateStates.set(g.gateId, {
				metadata: g.currentMetadata,
				content: g.currentContent,
				status: g.status,
				injectDownstream: gateDef?.injectDownstream,
			});
		}

		return { signal, cwd, builtinVars, goalSpec: goal.spec, allGateStates, gate: rerunGate };
	}

	private async _resumeOneVerification(v: ActiveVerification): Promise<void> {
		const resolvedSteps: Array<{ name: string; type: string; passed: boolean; output: string; duration_ms: number }> = [];

		for (const step of v.steps) {
			if (step.status !== "running") {
				// Already completed before restart — keep result
				// Skipped steps (optional or phase-skipped) count as passed for overall verdict
				resolvedSteps.push({
					name: step.name,
					type: step.type,
					passed: step.status === "passed" || step.status === "skipped",
					output: step.output || "",
					duration_ms: step.durationMs || 0,
				});
				continue;
			}

			// Step was running — for command-type steps, try the file-based
			// (Layer 1) resume path; for session-backed steps, re-attach to the
			// restored reviewer session as before.
			let resumeResult = step.type === "command"
				? await this._resumeCommandStep(v, step)
				: await this._tryResumeFromSession(v, step);

			// If resume failed with a transient error and this is an llm-review or agent-qa step,
			// re-run from scratch rather than giving up
			const isTransient = step.type === "agent-qa"
					? isTransientQaError(resumeResult?.output || "")
					: isTransientReviewError(resumeResult?.output || "");
			if (resumeResult && !resumeResult.passed && (step.type === "llm-review" || step.type === "agent-qa") && isTransient) {
				console.log(`[verification] Resume failed transiently for "${step.name}", re-running from scratch...`);
				let rerunResult: typeof resumeResult | null = null;
				if (step.type === "agent-qa") {
					rerunResult = await this._rerunAgentQaStep(v.goalId, v.gateId, v.signalId, step.name);
				} else {
					rerunResult = await this._rerunLlmReviewStep(v.goalId, v.gateId, v.signalId, step.name);
				}
				if (rerunResult) {
					resumeResult = rerunResult;
				}
				// If rerun context unavailable, fall through with the original transient failure
			}

			if (resumeResult) {
				resolvedSteps.push(resumeResult);
			} else {
				// No session and not an llm-review — cannot recover
				resolvedSteps.push({
					name: step.name,
					type: step.type,
					passed: false,
					output: "Step was running but had no session ID — cannot resume after restart.",
					duration_ms: Date.now() - step.startedAt,
				});
			}
		}

		// Compute overall result
		const allPassed = resolvedSteps.every(r => r.passed);
		const status = allPassed ? "passed" as const : "failed" as const;

		this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
			status,
			steps: resolvedSteps.map(r => ({
				name: r.name,
				type: r.type as "command" | "llm-review" | "agent-qa",
				passed: r.passed,
				output: r.output,
				duration_ms: r.duration_ms,
			})),
		});
		this.resolveGateStore(v.goalId).updateGateStatus(v.goalId, v.gateId, status);

		this.broadcastFn(v.goalId, {
			type: "gate_verification_complete",
			goalId: v.goalId, gateId: v.gateId, signalId: v.signalId, status,
		});
		this.broadcastFn(v.goalId, {
			type: "gate_status_changed",
			goalId: v.goalId, gateId: v.gateId, status,
		});
		this.notifyTeamLead(v.goalId, v.gateId, status);

		console.log(`[verification] Resumed verification ${v.signalId}: ${status}`);
	}

	/**
	 * Try to resume an llm-review step from its existing session.
	 * Returns the step result, or null if no session exists.
	 */
	private async _tryResumeFromSession(
		v: ActiveVerification,
		step: ActiveVerification["steps"][number],
	): Promise<{ name: string; type: string; passed: boolean; output: string; duration_ms: number } | null> {
		if (!step.sessionId) return null;

		const session = this.sessionManager?.getSession(step.sessionId);
		if (!session) {
			// Session lost — return transient failure so caller can re-run
			return {
				name: step.name, type: step.type, passed: false,
				output: "Session lost during server restart.",
				duration_ms: Date.now() - step.startedAt,
			};
		}

		// Re-register reviewer session in team store so team_list shows it
		if (this.teamManager) {
			try { this.teamManager.registerReviewerSession(v.goalId, step.sessionId, step.name); } catch { /* ignore */ }
		}

		// Set up verification_result promise for this resumed session
		const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
		this.pendingResults.set(step.sessionId, resultResolver);

		// Watch for errored tool_results so we can send a targeted JSON-retry
		// prompt if the agent gives up after a streaming/arg-validation glitch.
		let lastErroredToolOutput: string | null = null;
		const errListenerUnsub = session.rpcClient.onEvent((event: any) => {
			if (event.type === "tool_execution_end" && event.isError) {
				lastErroredToolOutput = extractToolResultText(event.result);
			}
		});

		try {
			// Wait for the agent to finish if it was mid-turn
			const idleResult = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(step.sessionId, 180_000).then(() => ({ type: "idle" as const })),
			]).catch(() => ({ type: "idle" as const }));

			if (idleResult.type === "result") {
				await this.sessionManager!.waitForIdle(step.sessionId, 30_000).catch(() => {});
				return {
					name: step.name, type: step.type,
					passed: idleResult.verdict,
					output: idleResult.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}

			// Agent went idle without calling verification_result — inspect whether
			// the previous turn hit a JSON / tool-argument validation glitch, and
			// send a targeted nudge if so. Falls back to the generic reminder.
			const jsonErr = lastErroredToolOutput ? detectJsonValidationError(lastErroredToolOutput) : null;
			const reminderPrompt = jsonErr ? buildJsonRetryPrompt(jsonErr) : VERIFICATION_RESULT_REMINDER;
			console.log(`[verification] No verification_result from resumed session ${step.sessionId}, sending ${jsonErr ? "JSON-retry" : "generic"} reminder...`);
			await session.rpcClient.prompt(reminderPrompt);
			// Reminder dispatch is fire-and-forget on the RPC channel; the session
			// stays `idle` for a tick before transitioning to `streaming`. Wait for
			// the next agent_start so the subsequent waitForIdle race doesn't
			// resolve instantly against the still-idle status.
			await this.sessionManager!.waitForStreaming(step.sessionId, 10_000).catch(() => {});

			const result2 = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(step.sessionId, 120_000).then(() => ({ type: "idle" as const })),
			]).catch(() => ({ type: "idle" as const }));

			if (result2.type === "result") {
				return {
					name: step.name, type: step.type,
					passed: result2.verdict,
					output: result2.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}

			return {
				name: step.name, type: step.type,
				passed: false,
				output: "Agent did not call verification_result after server restart and reminder.",
				duration_ms: Date.now() - step.startedAt,
			};
		} finally {
			try { errListenerUnsub(); } catch { /* ignore */ }
			this.pendingResults.delete(step.sessionId);
			// Terminate and unregister reviewer session
			try { await this.sessionManager!.terminateSession(step.sessionId); } catch { /* ignore */ }
			if (this.teamManager) {
				try { await this.teamManager.unregisterReviewerSession(v.goalId, step.sessionId); } catch { /* ignore */ }
			}
		}
	}

	/**
	 * Re-run an LLM review step from scratch — used when resume fails transiently.
	 * Looks up the original step definition from the goal's workflow and runs with
	 * full retry logic (3 attempts with backoff).
	 */
	private async _rerunLlmReviewStep(
		goalId: string, gateId: string, signalId: string, stepName: string,
	): Promise<{ name: string; type: string; passed: boolean; output: string; duration_ms: number } | null> {
		if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
			return { name: stepName, type: "llm-review", passed: true, output: "LLM review skipped (BOBBIT_LLM_REVIEW_SKIP is set).", duration_ms: 0 };
		}

		const stepDef = this._findStepDefinition(goalId, gateId, stepName);
		if (!stepDef) {
			console.warn(`[verification] Cannot re-run "${stepName}" — step definition not found in workflow`);
			return null;
		}

		const ctx = await this._gatherRerunContext(goalId, gateId, signalId);
		if (!ctx) {
			console.warn(`[verification] Cannot re-run "${stepName}" — goal/signal context unavailable`);
			return null;
		}

		const startedAt = Date.now();
		const maxAttempts = 3;
		let result: { passed: boolean; output: string; sessionId?: string } = { passed: false, output: "Re-run failed." };

		// Resolve project vars and substitute the prompt template
		const projectConfigStore = this.resolveProjectConfigStore(goalId);
		const projectVars: Record<string, string> = projectConfigStore
			? projectConfigStore.getWithDefaults()
			: {};
		const agentVars: Record<string, string> = ctx.signal.metadata || {};
		const prompt = this.substituteVars(stepDef.prompt || "", ctx.builtinVars, projectVars, agentVars, ctx.allGateStates);

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// Check if goal completed/shelved before retrying
			const goalCheck = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
			if (goalCheck && (goalCheck.state === "complete" || goalCheck.state === "shelved")) {
				console.log(`[verification] Aborting re-run of "${stepName}" — goal ${goalId} is ${goalCheck.state}`);
				return { name: stepName, type: "llm-review", passed: false, output: `Aborted: goal is ${goalCheck.state}`, duration_ms: Date.now() - startedAt };
			}
			result = await this.runLlmReviewStep(
				{ name: stepDef.name, prompt, timeout: stepDef.timeout, role: stepDef.role },
				ctx.cwd, ctx.builtinVars,
				ctx.signal.content, ctx.signal.metadata,
				ctx.goalSpec, ctx.allGateStates, goalId,
				undefined, ctx.gate,
			);
			if (result.passed || !isTransientReviewError(result.output) || attempt === maxAttempts) break;
			const delayMs = 2000 * Math.pow(2, attempt - 1);
			console.log(`[verification] Re-run "${stepName}" failed transiently (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
			await new Promise(r => setTimeout(r, delayMs));
		}

		return {
			name: stepName, type: "llm-review",
			passed: result.passed,
			output: result.output,
			duration_ms: Date.now() - startedAt,
		};
	}

	/**
	 * Re-run an agent-qa step from scratch — used when resume fails transiently.
	 */
	private async _rerunAgentQaStep(
		goalId: string, gateId: string, signalId: string, stepName: string,
	): Promise<{ name: string; type: string; passed: boolean; output: string; duration_ms: number } | null> {
		if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
			return { name: stepName, type: "agent-qa", passed: true, output: "Agent QA skipped (BOBBIT_LLM_REVIEW_SKIP is set).", duration_ms: 0 };
		}

		const stepDef = this._findStepDefinition(goalId, gateId, stepName);
		if (!stepDef) {
			console.warn(`[verification] Cannot re-run QA "${stepName}" — step definition not found in workflow`);
			return null;
		}

		const ctx = await this._gatherRerunContext(goalId, gateId, signalId);
		if (!ctx) {
			console.warn(`[verification] Cannot re-run QA "${stepName}" — goal/signal context unavailable`);
			return null;
		}

		const startedAt = Date.now();
		const projectVars = this.resolveProjectConfigStore(goalId)?.getWithDefaults() ?? {};
		const agentVars: Record<string, string> = ctx.signal.metadata || {};
		const prompt = this.substituteVars(stepDef.prompt || "", ctx.builtinVars, projectVars, agentVars, ctx.allGateStates);

		// QA agents are expensive (5-15 min each) — only retry once on true infrastructure failures,
		// not on "no verdict tag" (which means the agent burned its budget without producing results).
		const maxAttempts = 2;
		let result: { passed: boolean; output: string; sessionId?: string; artifact?: any } = { passed: false, output: "Re-run failed." };
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// Check if goal completed/shelved before retrying
			const goalCheck = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
			if (goalCheck && (goalCheck.state === "complete" || goalCheck.state === "shelved")) {
				console.log(`[verification] Aborting re-run of QA "${stepName}" — goal ${goalId} is ${goalCheck.state}`);
				return { name: stepName, type: "agent-qa", passed: false, output: `Aborted: goal is ${goalCheck.state}`, duration_ms: Date.now() - startedAt };
			}
			result = await this.runAgentQaStep(
				{ name: stepDef.name, prompt, timeout: stepDef.timeout, role: stepDef.role, component: stepDef.component },
				ctx.cwd, goalId, ctx.builtinVars,
				ctx.signal.content, ctx.signal.metadata, ctx.goalSpec, ctx.allGateStates,
			);
			if (result.passed || !isTransientQaError(result.output) || attempt === maxAttempts) break;
			await new Promise(r => setTimeout(r, 5000));
		}

		return { name: stepName, type: "agent-qa", passed: result.passed, output: result.output, duration_ms: Date.now() - startedAt };
	}

	private readonly _stateDir: string;

	private configCascade?: import("./config-cascade.js").ConfigCascade;

	/** Monotonic counter used to stamp `seq` on every broadcast event. */
	private _verifSeqCounter = 0;

	private readonly broadcastFn: (goalId: string, event: any) => void;

	constructor(
		stateDir: string,
		/** @deprecated Resolve per-goal via projectContextManager instead. */
		private gateStore: GateStore | undefined,
		private _rawBroadcastFn: (goalId: string, event: any) => void,
		private roleStore: RoleStore,
		private preferencesStore?: PreferencesStore,
		private sessionManager?: import("./session-manager.js").SessionManager,
		private teamManager?: import("./team-manager.js").TeamManager,
		private projectConfigStore?: ProjectConfigStore,
		projectContextManager?: ProjectContextManager,
		configCascade?: import("./config-cascade.js").ConfigCascade,
	) {
		this.configCascade = configCascade;
		// Wrap the broadcast fn so every gate_verification_* event carries a
		// monotonic `seq`. The UI uses (type, signalId, stepIndex, seq) to
		// dedupe payloads delivered via per-session WS fan-out (see
		// src/app/verification-event-bus.ts). The seq is global per harness
		// instance — simpler than scoping per (goal,gate,signal) and equally
		// effective since the dedupe key includes signalId.
		this.broadcastFn = (goalId: string, event: any) => {
			if (event && typeof event === "object" && typeof event.type === "string" && event.type.startsWith("gate_verification_") && event.seq == null) {
				event.seq = ++this._verifSeqCounter;
			}
			this._rawBroadcastFn(goalId, event);
		};
		this._stateDir = stateDir;
		this._persistPath = path.join(stateDir, "active-verifications.json");
		this.projectContextManager = projectContextManager ?? null;
		// Load any persisted active verifications from a prior run into memory
		// (they'll be resumed by resumeInterruptedVerifications() after session restore)
		const persisted = this._loadActive();
		for (const v of persisted) {
			this.activeVerifications.set(v.signalId, v);
		}
	}

	/**
	 * Resolve a role from the cascade so project-level overrides apply, falling
	 * back to the server-level role store when the cascade is unavailable
	 * (e.g. unit tests). Returns undefined if the role does not exist.
	 */
	private resolveRoleForGoal(roleName: string, goalId?: string): { model?: string; thinkingLevel?: string } | undefined {
		if (this.configCascade) {
			const projectId = goalId ? this.projectContextManager?.getContextForGoal(goalId)?.project?.id : undefined;
			try {
				const resolved = this.configCascade.resolveRoles(projectId);
				const found = resolved.find(r => r.item.name === roleName);
				if (found) return { model: found.item.model, thinkingLevel: found.item.thinkingLevel };
			} catch (err) {
				console.warn(`[verification] Failed to resolve role "${roleName}" via cascade:`, err);
			}
		}
		const r = this.roleStore.get(roleName);
		if (!r) return undefined;
		return { model: r.model, thinkingLevel: r.thinkingLevel };
	}

	private resolveProjectConfigStore(goalId: string): ProjectConfigStore | undefined {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.projectConfigStore;
			console.warn(`[verification] Goal "${goalId}" not found in any project context — falling back to server-level projectConfigStore. This likely means the gate will run with wrong commands.`);
		}
		return this.projectConfigStore;
	}

	/**
	 * Pick a component to source `config.qa_*` from when an agent-qa step
	 * does not declare `component:` explicitly. Preference order:
	 *   1. First component whose `config.qa_start_command` is set.
	 *   2. Component whose `name` matches the project name.
	 *   3. `components[0]`.
	 * Returns undefined when no components are configured.
	 */
	private resolveDefaultQaComponentName(goalId: string): string | undefined {
		const pcs = this.resolveProjectConfigStore(goalId);
		if (!pcs) return undefined;
		const comps = pcs.getComponents();
		const hit = comps.find(c => c.config?.qa_start_command);
		if (hit) return hit.name;
		const projectName = this.projectContextManager?.getContextForGoal(goalId)?.project?.name;
		if (projectName) {
			const nameMatch = comps.find(c => c.name === projectName);
			if (nameMatch) return nameMatch.name;
		}
		return comps[0]?.name;
	}

	private resolveGateStore(goalId: string): GateStore {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.gateStore;
			throw new Error(`Cannot resolve gate store: goal "${goalId}" not found in any project`);
		}
		// Fallback for non-PCM path (tests without project context)
		if (this.gateStore) return this.gateStore;
		throw new Error(`Cannot resolve gate store: no project context manager and no fallback gate store`);
	}

	/** Register a callback to notify the team lead agent when verification completes. */
	setTeamLeadNotifier(fn: (goalId: string, message: string) => void): void {
		this.notifyTeamLeadFn = fn;
	}

	/**
	 * Cancel ALL in-flight verifications for a goal (all gates).
	 * Called when a goal completes, a team is torn down, or the goal is shelved.
	 */
	async cancelAllVerifications(goalId: string): Promise<void> {
		for (const [signalId, active] of this.activeVerifications) {
			if (active.goalId !== goalId) continue;
			active.cancelled = true;
			active.overallStatus = "cancelled";

			for (const step of active.steps) {
				if (step.sessionId && step.status === "running") {
					try { await this.sessionManager?.terminateSession(step.sessionId); } catch { /* ignore */ }
					if (this.teamManager) {
						try { await this.teamManager.unregisterReviewerSession(goalId, step.sessionId); } catch { /* ignore */ }
					}
				}
			}

			this.activeVerifications.delete(signalId);
			this._persistActive();

			this.broadcastFn(goalId, {
				type: "gate_verification_complete",
				goalId, gateId: active.gateId, signalId,
				status: "cancelled",
			});

			console.log(`[verification] Cancelled verification ${signalId} for goal ${goalId} (goal completing)`);
		}
	}

	/**
	 * Cancel any in-flight verifications for the same (goalId, gateId).
	 * Terminates reviewer sessions and removes from activeVerifications.
	 */
	async cancelStaleVerifications(goalId: string, gateId: string): Promise<void> {
		for (const [signalId, active] of this.activeVerifications) {
			if (active.goalId === goalId && active.gateId === gateId) {
				// Mark as cancelled
				active.cancelled = true;
				active.overallStatus = "cancelled";

				// Terminate all running reviewer sessions
				for (const step of active.steps) {
					if (step.sessionId && step.status === "running") {
						try {
							await this.sessionManager?.terminateSession(step.sessionId);
						} catch { /* ignore — may already be terminated */ }
						if (this.teamManager) {
							try {
								await this.teamManager.unregisterReviewerSession(goalId, step.sessionId);
							} catch { /* ignore */ }
						}
					}
				}

				// Persist cancellation to gate store so UI sees "failed" instead of stale "running"
				this.resolveGateStore(goalId).updateSignalVerification(signalId, {
					status: "failed",
					steps: [{ name: "Cancelled", type: "command", passed: false, output: "Verification cancelled.", duration_ms: 0 }],
				});
				// Note: gate status is NOT updated here — the caller decides whether to set it
				// (e.g. explicit user cancel sets it to "failed", but re-signal lets the new verification decide)

				// Remove from active verifications
				this.activeVerifications.delete(signalId);
				this._persistActive();

				// Broadcast cancellation
				this.broadcastFn(goalId, {
					type: "gate_verification_complete",
					goalId, gateId, signalId,
					status: "cancelled",
				});

				console.log(`[verification] Cancelled stale verification ${signalId} for gate ${gateId}`);
			}
		}
	}

	private notifyTeamLead(goalId: string, gateId: string, status: string): void {
		if (!this.notifyTeamLeadFn) return;
		const verb = status === "passed" ? "PASSED" : "FAILED";
		this.notifyTeamLeadFn(goalId, `Gate verification ${verb}: "${gateId}". ${status === "passed" ? "Downstream work for this gate can now proceed." : "Check the verification output, fix the issues, and re-signal the gate."}`);
	}

	/**
	 * Verify a gate signal asynchronously (fire-and-forget from caller).
	 * Updates signal verification results and gate status when done.
	 */
	async verifyGateSignal(
		signal: GateSignal,
		gate: WorkflowGate,
		cwd: string,
		goalBranch?: string,
		primaryBranch?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
		goalSpec?: string,
	): Promise<void> {
		const steps = gate.verify;
		if (!steps || steps.length === 0) {
			// No verification — auto-pass
			this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, { status: "passed", steps: [] });
			this.resolveGateStore(signal.goalId).updateGateStatus(signal.goalId, signal.gateId, "passed");
			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status: "passed",
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status: "passed",
			});
			this.notifyTeamLead(signal.goalId, signal.gateId, "passed");
			return;
		}

		// Broadcast verification started
		const verificationStartedAt = Date.now();
		this.broadcastFn(signal.goalId, {
			type: "gate_verification_started",
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			startedAt: verificationStartedAt,
			steps: steps.map(s => ({ name: s.name, type: s.type, phase: s.phase ?? 0 })),
		});

		// Track active verification for REST bootstrapping
		const minPhase = Math.min(...steps.map(s => s.phase ?? 0));
		const active: ActiveVerification = {
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			steps: steps.map(s => {
				const phase = s.phase ?? 0;
				return { name: s.name, type: s.type, status: (phase === minPhase ? "running" : "waiting") as "running" | "waiting", phase, startedAt: verificationStartedAt };
			}),
			overallStatus: "running",
			startedAt: verificationStartedAt,
		};
		this.activeVerifications.set(signal.id, active);
		this._persistActive();

		try {
			// Project config — resolved via {{project.key}}. Look up `base_ref`
			// here so `{{baseBranch}}` can be threaded into `builtinVars` below.
			const projectConfigStore = this.resolveProjectConfigStore(signal.goalId);
			const configuredBaseRef = projectConfigStore?.get("base_ref") ?? "";
			// {{baseBranch}} — bare branch name from `base_ref`, falling back to
			// the project primary when unset. {{master}} keeps its meaning.
			// See `docs/design/base-ref.md` §3.
			const baseBranch = parseBaseRef(configuredBaseRef).branch || primaryBranch || "master";
			const builtinVars: Record<string, string> = {
				branch: goalBranch || "HEAD",
				master: primaryBranch || "master",
				baseBranch,
				cwd,
				goal_spec: goalSpec || "",
				commit: signal.commitSha || "HEAD",
			};
			const projectVars: Record<string, string> = projectConfigStore
				? projectConfigStore.getWithDefaults()
				: {};

			// Signal metadata — resolved via {{agent.key}}
			const agentVars: Record<string, string> = signal.metadata || {};

			// Results array indexed by step position (declared early for optional step skipping)
			const allResults: Array<GateSignalStep | null> = new Array(steps.length).fill(null);

			// Build cache of previously-passed step results for the same commit SHA.
			// This avoids re-running expensive LLM reviews that already passed on a prior signal.
			const gateState = this.resolveGateStore(signal.goalId).getGate(signal.goalId, signal.gateId);
			const cachedSteps = buildStepCache(gateState?.signals ?? [], signal.id, signal.commitSha);
			if (cachedSteps.size > 0) {
				console.log(`[verification] Reusing ${cachedSteps.size} previously-passed step(s) for commit ${signal.commitSha.slice(0, 8)}: ${[...cachedSteps.keys()].join(", ")}`);
			}

			// --- Optional step skipping ---
			// Look up enabledOptionalSteps from the goal
			const goalForOptional = this.projectContextManager?.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
			const enabledOptional = goalForOptional?.enabledOptionalSteps ?? [];

			// Partition steps into active and skipped
			const { active: activeSteps, skippedIndices } = partitionOptionalSteps(steps, enabledOptional);

			// Immediately resolve skipped optional steps
			for (const idx of skippedIndices) {
				const s = steps[idx];
				const skipResult: GateSignalStep = {
					name: s.name, type: s.type as GateSignalStep["type"],
					passed: true, skipped: true, output: "Skipped — not enabled for this goal", duration_ms: 0,
				};
				allResults[idx] = skipResult;
				const av = this.activeVerifications.get(signal.id);
				if (av?.steps[idx]) {
					av.steps[idx] = { ...av.steps[idx], status: "skipped", durationMs: 0, output: skipResult.output };
					this._persistActive();
				}
				if (!active.cancelled) this.broadcastFn(signal.goalId, {
					type: "gate_verification_step_complete",
					goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
					stepIndex: idx, stepName: s.name,
					status: "skipped", durationMs: 0, output: skipResult.output,
					phase: s.phase ?? 0,
				});
			}

			// If ALL active steps can be served from cache, skip spawning agents entirely
			if (canSkipAllSteps(cachedSteps, activeSteps)) {
				console.log(`[verification] All ${activeSteps.length} active step(s) cached for commit ${signal.commitSha!.slice(0, 8)} — skipping agent spawn`);
				const results: GateSignalStep[] = steps.map((s, i) => {
					if (allResults[i]) return allResults[i]!; // skipped optional step
					const cached = cachedSteps.get(s.name)!;
					return { ...cached, output: `[cached from prior signal] ${cached.output}` };
				});
				const allPassed = computeAllPassed(results);
				const status = allPassed ? "passed" as const : "failed" as const;
				this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, { status, steps: results });
				this.resolveGateStore(signal.goalId).updateGateStatus(signal.goalId, signal.gateId, status);
				this.activeVerifications.delete(signal.id);
				this._persistActive();
				// Broadcast step completions and overall result
				results.forEach((r, index) => {
					this.broadcastFn(signal.goalId, {
						type: "gate_verification_step_complete",
						goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
						stepIndex: index, stepName: r.name,
						status: r.passed ? "passed" : "failed",
						durationMs: r.duration_ms || 0, output: r.output,
						phase: steps[index].phase ?? 0,
					});
				});
				this.broadcastFn(signal.goalId, {
					type: "gate_verification_complete",
					goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id, status,
				});
				this.broadcastFn(signal.goalId, {
					type: "gate_status_changed",
					goalId: signal.goalId, gateId: signal.gateId, status,
				});
				this.notifyTeamLead(signal.goalId, signal.gateId, status);
				return;
			}

			// --- Phased execution ---
			// Group active steps by phase (default 0), execute phases sequentially,
			// steps within each phase run in parallel. Skipped optional steps are excluded.
			const phaseGroups = groupStepsByPhase(activeSteps, steps);
			const sortedPhases = getSortedPhases(phaseGroups);

			// Sync the goal worktree with the latest commits before running verification.
			// Agents (sandbox or not) push to origin — fetch and reset to pick up their changes.
			if (goalBranch) {
				try {
					const { execFile: execFileCb } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execFileAsync = promisify(execFileCb);
					await execFileAsync("git", ["fetch", "origin", goalBranch], { cwd, timeout: 30_000 });
					await execFileAsync("git", ["reset", "--hard", `origin/${goalBranch}`], { cwd, timeout: 15_000 });
					console.log(`[verification] Synced goal worktree to origin/${goalBranch}`);
				} catch (err) {
					// Non-fatal — local-only repos without a remote will fail fetch
					console.warn(`[verification] Failed to sync worktree from origin/${goalBranch}:`, err);
				}

				// Also fetch the primary branch so origin/<primary> is up-to-date for
				// implementation-gate diff baselines. Non-fatal on failure (offline / no remote).
				if (builtinVars.master) {
					try {
						const { execFile: execFileCb } = await import("node:child_process");
						const { promisify } = await import("node:util");
						const execFileAsync = promisify(execFileCb);
						await execFileAsync("git", ["fetch", "origin", builtinVars.master], { cwd, timeout: 30_000 });
					} catch (err) {
						console.warn(`[verification] Failed to fetch origin/${builtinVars.master} (non-fatal):`, err);
					}
				}
			}

			const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MB
			let phaseFailed = false;

			for (const phase of sortedPhases) {
				if (active.cancelled) break;

				if (phaseFailed) {
					// Skip all steps in this and subsequent phases
					const phaseSteps = phaseGroups.get(phase)!;
					for (const { step, index } of phaseSteps) {
						const skipResult: GateSignalStep = {
							name: step.name,
							type: step.type,
							passed: false,
							skipped: true,
							output: "Skipped — earlier phase failed",
							duration_ms: 0,
							expect: step.expect,
						};
						allResults[index] = skipResult;
						const av = this.activeVerifications.get(signal.id);
						if (av && av.steps[index]) {
							av.steps[index] = { ...av.steps[index], status: "skipped", durationMs: 0, output: skipResult.output };
							this._persistActive();
						}
						if (!active.cancelled) this.broadcastFn(signal.goalId, {
							type: "gate_verification_step_complete",
							goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
							stepIndex: index, stepName: step.name,
							status: "skipped", durationMs: 0, output: skipResult.output,
							phase,
						});
					}
					continue;
				}

				const phaseSteps = phaseGroups.get(phase)!;
				const stepIndices = phaseSteps.map(ps => ps.index);

				// Broadcast phase started — transition waiting steps in this phase to running
				active.currentPhase = phase;
				for (const { index } of phaseSteps) {
					if (active.steps[index]?.status === "waiting") {
						active.steps[index].status = "running";
						active.steps[index].startedAt = Date.now();
					}
				}
				this._persistActive();
				this.broadcastFn(signal.goalId, {
					type: "gate_verification_phase_started",
					goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
					phase, stepIndices,
				});

				// Run steps in this phase in parallel
				const phaseResults = await Promise.all(
					phaseSteps.map(async ({ step, index }) => {
						const cached = cachedSteps.get(step.name);
						if (cached) {
							const cachedResult: GateSignalStep = { ...cached, output: `[cached from prior signal] ${cached.output}` };
							if (!active.cancelled) this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_complete",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								status: cachedResult.passed ? "passed" : "failed",
								durationMs: cachedResult.duration_ms || 0, output: cachedResult.output,
								phase,
							});
							const av = this.activeVerifications.get(signal.id);
							if (av && av.steps[index]) {
								av.steps[index] = { ...av.steps[index], status: cachedResult.passed ? "passed" : "failed", durationMs: cachedResult.duration_ms || 0, output: cachedResult.output };
								this._persistActive();
							}
							return { index, stepResult: cachedResult };
						}

						let result: { passed: boolean; output: string; sessionId?: string } = { passed: false, output: "No verification result." };
						let artifact: GateSignalStep["artifact"];
						const startTime = Date.now();

						// Pre-generate sessionId for LLM review and agent-qa steps so we can broadcast it before the step starts
						let stepSessionId: string | undefined;
						if (step.type === "llm-review" || step.type === "agent-qa") {
							const prefix = step.type === "agent-qa" ? "agent-qa" : "llm-review";
							stepSessionId = `${prefix}-${randomUUID().slice(0, 12)}`;
							active.steps[index].startedAt = Date.now();
							this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_started",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								startedAt: active.steps[index].startedAt,
								sessionId: stepSessionId, phase,
							});
							const av = this.activeVerifications.get(signal.id);
							if (av && av.steps[index]) {
								av.steps[index].sessionId = stepSessionId;
								this._persistActive();
							}
						}

						if (step.type === "command") {
							active.steps[index].startedAt = Date.now();
							this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_started",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								startedAt: active.steps[index].startedAt,
								phase,
							});
							// Structural step resolution — see resolveStep() above.
							// Component-linked steps run from the component's root path
							// and resolve their shell command via components[name].commands.
							// Free-form { run } steps run at the branch-container root (cwd).
							let resolvedRun: string;
							let resolvedCwd = cwd;
							try {
								const components = projectConfigStore?.getComponents() ?? [];
								const goalForCtx = this.projectContextManager?.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
								const r = resolveStep(step, components, cwd, {
									workflow: goalForCtx?.workflowId ?? signal.goalId,
									gate: signal.gateId,
									stepIndex: index,
								});
								resolvedRun = r.runString ?? "";
								resolvedCwd = r.cwd;
							} catch (resolveErr) {
								const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
								result = { passed: false, output: msg };
								const duration_ms = Date.now() - startTime;
								return { index, stepResult: { name: step.name, type: step.type, passed: false, output: msg, duration_ms, expect: step.expect } };
							}
							const cmd = this.substituteVars(resolvedRun, builtinVars, projectVars, agentVars, allGateStates);
							// Auto-skip command steps whose run string is empty or contains
							// unresolved template vars (e.g. {{project.build_command}} when the
							// project has no build_command configured). Skipped-as-passed so
							// optional infrastructure steps (build, custom commands) don't fail
							// the gate for projects that don't define them.
							const skipReason = isCommandStepSkippable(cmd);
							if (skipReason) {
								result = { passed: true, output: skipReason };
							} else {
							const expectFailure = step.expect === "failure";

							// Look up error_pattern for expect: failure steps
							let errorPattern: string | undefined;
							if (expectFailure) {
								errorPattern = agentVars["error_pattern"];
								if (!errorPattern && allGateStates) {
									for (const [, gs] of allGateStates) {
										if (gs.metadata?.["error_pattern"]) {
											errorPattern = gs.metadata["error_pattern"];
											break;
										}
									}
								}
							}

							const streamCtx = {
								goalId: signal.goalId, gateId: signal.gateId,
								signalId: signal.id, stepIndex: index,
							};

							// For sandboxed goals, resolve the project container ID
							// so the command runs inside the container (where the code lives).
							// Also resolve the container-internal worktree path so the command
							// runs on the goal's branch, not /workspace (the main branch).
							let commandContainerId: string | undefined;
							let commandCwd = resolvedCwd;
							const sandboxedGoal = this.projectContextManager?.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
							const isSandboxedGoal = sandboxedGoal?.sandboxed;
							if (isSandboxedGoal && this.sessionManager) {
								const sandboxMgr = this.sessionManager.getSandboxManager();
								const goalCtx = this.projectContextManager?.getContextForGoal(signal.goalId);
								if (sandboxMgr && goalCtx) {
									const projectSandbox = sandboxMgr.get(goalCtx.project.id);
									if (projectSandbox) {
										try {
											commandContainerId = await projectSandbox.getContainerId();
											// Resolve the container worktree path for this goal's branch.
											// Worktrees are created at /workspace-wt/<branch> by ProjectSandbox.
											const goalBranchName = sandboxedGoal?.branch;
											if (goalBranchName) {
												commandCwd = `/workspace-wt/${goalBranchName}`;
											} else {
												commandCwd = "/workspace";
											}
										} catch {
											// Container unavailable — fall through to warning
										}
									}
								}
								if (!commandContainerId) {
									const warning = `[verification] Sandboxed goal ${signal.goalId} but no project container found — falling back to host execution`;
									console.warn(warning);
									this.broadcastFn(streamCtx.goalId, {
										type: "gate_verification_step_output",
										goalId: streamCtx.goalId, gateId: streamCtx.gateId,
										signalId: streamCtx.signalId, stepIndex: streamCtx.stepIndex,
										stream: "stderr", text: warning + "\n", ts: Date.now(),
									});
								}
							}

							if (this.commandSemaphore.available === 0) {
								console.log(`[verification] Step "${step.name}" waiting for semaphore slot...`);
							}
							await this.commandSemaphore.acquire();
							try {
								result = await this.runCommandStep(cmd, commandCwd, step.timeout || 300, expectFailure, streamCtx, errorPattern, commandContainerId);
							} finally {
								this.commandSemaphore.release();
							}
							}
						} else if (step.type === "agent-qa") {
							// agent-qa — spawn a one-shot test-engineer sub-agent
							if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
								result = { passed: true, output: "Agent QA skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								const maxAttempts = 3;
								for (let attempt = 1; attempt <= maxAttempts; attempt++) {
									if (active.cancelled) break;
									const qaResult = await this.runAgentQaStep(
										{ name: step.name, prompt, timeout: step.timeout, role: step.role, component: (step as any).component },
										cwd, signal.goalId, builtinVars,
										signal.content, signal.metadata,
										goalSpec, allGateStates, stepSessionId,
									);
									result = qaResult;
									if (qaResult.artifact) {
										artifact = qaResult.artifact;
									}
									const isTransient = isTransientQaError(qaResult.output);
									if (qaResult.passed || !isTransient || attempt === maxAttempts) break;
									const delayMs = 2000 * Math.pow(2, attempt - 1);
									console.log(`[verification] Agent QA "${step.name}" failed transiently (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
									await new Promise(r => setTimeout(r, delayMs));
								}
							}
						} else {
							// llm-review — spawn a one-shot reviewer sub-agent
							if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
								result = { passed: true, output: "LLM review skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								const maxAttempts = 3;
								for (let attempt = 1; attempt <= maxAttempts; attempt++) {
									if (active.cancelled) break;
									result = await this.runLlmReviewStep(
										{ name: step.name, prompt, timeout: step.timeout, role: step.role },
										cwd, builtinVars,
										signal.content, signal.metadata,
										goalSpec, allGateStates, signal.goalId, stepSessionId,
										gate,
									);
									const isTransient = isTransientReviewError(result.output);
									if (result.passed || !isTransient || attempt === maxAttempts) break;
									const delayMs = 2000 * Math.pow(2, attempt - 1);
									console.log(`[verification] LLM review "${step.name}" failed transiently (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
									await new Promise(r => setTimeout(r, delayMs));
								}
							}
						}

						const duration_ms = Date.now() - startTime;

						// Build artifact for llm-review steps (agent-qa artifacts are set during execution)
						if (!artifact && step.type === "llm-review" && result.output && result.output.length > 0) {
							artifact = {
								content: result.output.length > MAX_ARTIFACT_SIZE ? result.output.slice(0, MAX_ARTIFACT_SIZE) : result.output,
								contentType: "text/markdown",
							};
						}

						if (!active.cancelled) this.broadcastFn(signal.goalId, {
							type: "gate_verification_step_complete",
							goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
							stepIndex: index, stepName: step.name,
							status: result.passed ? "passed" : "failed",
							durationMs: duration_ms, output: result.output || "",
							sessionId: result.sessionId, phase,
						});
						const av = this.activeVerifications.get(signal.id);
						if (av && av.steps[index]) {
							av.steps[index] = { ...av.steps[index], status: result.passed ? "passed" : "failed", durationMs: duration_ms, output: result.output || "", sessionId: result.sessionId };
							this._persistActive();
						}
						const stepResult: GateSignalStep = {
							name: step.name,
							type: step.type,
							passed: result.passed,
							output: result.output,
							duration_ms,
							expect: step.expect,
						};
						if (artifact) stepResult.artifact = artifact;
						return { index, stepResult };
					})
				);

				// Store phase results
				for (const { index, stepResult } of phaseResults) {
					allResults[index] = stepResult;
				}

				// Check if any step in this phase failed
				if (phaseResults.some(r => !r.stepResult.passed)) {
					phaseFailed = true;
				}
			}

			// If cancelled while steps were running, skip result processing
			if (active.cancelled) {
				this.activeVerifications.delete(signal.id);
				this._persistActive();
				return;
			}

			// Collect final results in YAML order
			const results = allResults.map((r, i) => r ?? {
				name: steps[i].name,
				type: steps[i].type,
				passed: false,
				output: "No result collected",
				duration_ms: 0,
				expect: steps[i].expect,
			});

			const allPassed = computeAllPassed(results);
			const status = allPassed ? "passed" : "failed";

			this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, { status, steps: results });
			this.resolveGateStore(signal.goalId).updateGateStatus(signal.goalId, signal.gateId, status);
			this.activeVerifications.delete(signal.id);
			this._persistActive();

			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status,
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status,
			});
			this.notifyTeamLead(signal.goalId, signal.gateId, status);
		} catch (err: any) {
			if (active.cancelled) {
				this.activeVerifications.delete(signal.id);
				this._persistActive();
				return;
			}
			this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, {
				status: "failed",
				steps: [{ name: "Error", type: "command", passed: false, output: err.message, duration_ms: 0 }],
			});
			this.resolveGateStore(signal.goalId).updateGateStatus(signal.goalId, signal.gateId, "failed");
			this.activeVerifications.delete(signal.id);
			this._persistActive();

			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status: "failed",
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status: "failed",
			});
			this.notifyTeamLead(signal.goalId, signal.gateId, "failed");
		}
	}

	/**
	 * Spawn a one-shot reviewer sub-agent to perform an LLM-powered code review.
	 * Follows the pattern from src/server/skills/sub-agent.ts.
	 */
	private async runLlmReviewStep(
		step: { name: string; prompt?: string; timeout?: number; role?: string },
		cwd: string,
		builtinVars: Record<string, string>,
		signalContent?: string,
		signalMetadata?: Record<string, string>,
		goalSpec?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
		goalId?: string,
		sessionId?: string,
		gate?: WorkflowGate,
	): Promise<{ passed: boolean; output: string; sessionId?: string }> {
		const roleName = step.role || "reviewer";
		const role = this.roleStore.get(roleName) || this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: `LLM review failed: '${roleName}' role not found in role store.`, sessionId };
		}

		const timeoutMs = (step.timeout || 600) * 1000;

		// Build the combined prompt sections (shared between session-based and direct-RpcBridge paths)
		const combinedPrompt = await buildReviewPrompt(role, step, cwd, builtinVars, signalContent, signalMetadata, goalSpec, allGateStates, gate);

		// Build the kickoff message (shared between both paths)
		const kickoff = [
			`Perform the review for the gate verification step: "${step.name}".`,
			"",
			`Your working directory is on branch \`${builtinVars.branch}\` at commit \`${builtinVars.commit || "HEAD"}\`. Do NOT run git checkout/pull/fetch. Follow the review step instructions below — they define exactly what to check at this stage.`,
			"",
			step.prompt || "",
			"",
			"## Submitting Results",
			"",
			"When your review is complete, call `verification_result`:",
			'- verdict: "pass" or "fail" based on findings severity',
			"- summary: detailed markdown — headings, bullet lists, code blocks with file:line references",
			"",
			"You MUST call this tool. Going idle without calling it means your review is lost.",
			"Do NOT emit <verdict> XML tags. Do NOT call gate_signal.",
		].join("\n");

		// ── Session-based path (visible in UI) ──
		if (this.sessionManager && goalId) {
			return this.runLlmReviewViaSession(step, cwd, goalId, role, combinedPrompt, kickoff, timeoutMs, sessionId);
		}

		// ── Legacy direct-RpcBridge path (fallback when SessionManager unavailable) ──
		return this.runLlmReviewDirect(step, cwd, role, combinedPrompt, kickoff, timeoutMs, roleName);
	}

	// buildReviewPrompt is exported at module scope (below) so unit tests can
	// import it directly without going through a class instance.


	/**
	 * Run an LLM review step via SessionManager (visible in UI as a proper session).
	 */
	private async runLlmReviewViaSession(
		step: { name: string; prompt?: string; timeout?: number; role?: string },
		cwd: string,
		goalId: string,
		role: { promptTemplate: string; accessory?: string; name?: string },
		combinedPrompt: string,
		kickoff: string,
		timeoutMs: number,
		preGeneratedSessionId?: string,
	): Promise<{ passed: boolean; output: string; sessionId?: string }> {
		// Pre-generate sessionId so we can register the verification_result resolver and extension before session creation
		const sessionId = preGeneratedSessionId || `llm-review-${randomUUID().slice(0, 12)}`;

		// Set up verification_result promise
		const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
		this.pendingResults.set(sessionId, resultResolver);

		let lastErroredToolOutput: string | null = null;
		let errListenerUnsub: (() => void) | undefined;

		try {
			// Create session via SessionManager — no worktree created (direct createSession, not spawnRole)
			// verification_result tool is registered via the standard goal tools extension (tasks/extension.ts)
			const roleName = role.name || step.role || "reviewer";
			const isSandboxed = (goalId
				? this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId)?.sandboxed
				: undefined) ?? this.sessionManager!.isSandboxEnabled;

			// Resolve the model and thinking level up-front so we can pin them at
			// spawn time (avoids a redundant initial `model_change` event).
			const _preRoleOverrides = this.resolveRoleForGoal(roleName, goalId);
			const _preRoleModel = _preRoleOverrides?.model;
			const _preReviewPref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
			const _preInitialModel = (_preRoleModel && /^[^/]+\/.+$/.test(_preRoleModel))
				? _preRoleModel
				: ((_preReviewPref && /^[^/]+\/.+$/.test(_preReviewPref)) ? _preReviewPref : undefined);
			const _preRoleThinking = _preRoleOverrides?.thinkingLevel;
			const _preReviewThinkingPref = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
			const _validLevels = THINKING_LEVELS as readonly string[];
			const _preInitialThinkingRaw = (_preRoleThinking && _validLevels.includes(_preRoleThinking))
				? _preRoleThinking
				: ((_preReviewThinkingPref && _validLevels.includes(_preReviewThinkingPref)) ? _preReviewThinkingPref : "off");
			const _preInitialThinking = clampReviewThinking(_preInitialThinkingRaw, _preInitialModel) ?? _preInitialThinkingRaw;

			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName,
				sandboxed: isSandboxed,
				sessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
				initialModel: _preInitialModel,
				initialThinkingLevel: _preInitialThinking,
			});

			// Set title and metadata
			const funName = await generateTeamName("verification");
			this.sessionManager!.setTitle(sessionId, `${step.name}: ${funName}`);
			this.sessionManager!.updateSessionMeta(sessionId, {
				role: roleName,
				teamGoalId: goalId,
				accessory: role.accessory || "magnifying-glass",
				nonInteractive: true,
			});

			// Register in team store (if team manager available)
			if (this.teamManager) {
				try {
					await this.teamManager.registerReviewerSession(goalId, sessionId, step.name);
				} catch (err) {
					// Non-fatal — session still works even if team registration fails
					console.warn(`[verification] Failed to register reviewer session in team:`, err);
				}
			}

			// Resolve role overrides so they win over default.reviewModel/Thinking.
			const roleOverrides_r = this.resolveRoleForGoal(roleName, goalId);
			const roleModel_r = roleOverrides_r?.model;
			const roleThinking_r = roleOverrides_r?.thinkingLevel;

			// Override model: role wins, else default.reviewModel preference.
			// Throws on failure/mismatch — outer catch converts to a failed gate result.
			// `skipSetModel` is true when the spawn already pinned the same model;
			// the read-back verification still runs and still hard-fails on mismatch.
			if (roleModel_r) {
				try {
					await applyModelString(session.rpcClient, roleModel_r, {
						sessionManager: this.sessionManager ?? null,
						sessionId,
						contextLabel: `role.${roleName}.model`,
						skipSetModel: _preInitialModel === roleModel_r,
					});
					console.log(`[verification] Set role-override model "${roleModel_r}" for reviewer ${sessionId} (role=${roleName})`);
				} catch (err) {
					console.error(`[verification] Role model "${roleModel_r}" failed for reviewer ${sessionId}:`, err);
					throw err;
				}
			} else if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				try {
					await applyReviewModelOverrides(session.rpcClient, {
						prefs: { get: (k) => this.preferencesStore!.get(k) as string | undefined },
						sessionManager: this.sessionManager ?? null,
						sessionId,
						role: "reviewer",
						skipSetModel: !!reviewModelPref && _preInitialModel === reviewModelPref,
					});
					if (reviewModelPref) {
						console.log(`[verification] Set review model "${reviewModelPref}" for ${sessionId}`);
					}
				} catch (err) {
					console.error(`[verification] applyReviewModelOverrides failed for reviewer ${sessionId} (pref="${reviewModelPref ?? "<unset>"}"):`, err);
					throw err;
				}
			}

			// Apply thinking level: role wins; else default.reviewThinkingLevel pref;
			// else "off" (matches Settings page default for review agents).
			// Skip the RPC if spawn already pinned the same level.
			{
				let level: string;
				if (roleThinking_r) {
					level = roleThinking_r;
				} else {
					const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
					level = (reviewThinking && (THINKING_LEVELS as readonly string[]).includes(reviewThinking))
						? reviewThinking : "off";
				}
				// Clamp against the reviewer's resolved model so xhigh on a model
				// that doesn't support it degrades to high before the RPC.
				level = clampReviewThinking(level, roleModel_r ?? this.preferencesStore?.get("default.reviewModel") as string | undefined) ?? level;
				if (_preInitialThinking === level) {
					console.log(`[verification] Review thinking level "${level}" already pinned at spawn for ${sessionId}`);
				} else {
					try {
						await session.rpcClient.setThinkingLevel(level);
						console.log(`[verification] Set review thinking level "${level}" for ${sessionId}${roleThinking_r ? " (role override)" : ""}`);
					} catch (err) {
						console.error(`[verification] Failed to set review thinking level:`, err);
					}
				}
			}

			// Watch for errored tool_results so we can send a targeted JSON-retry
			// prompt if the agent gives up after a streaming/arg-validation glitch.
			errListenerUnsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "tool_execution_end" && event.isError) {
					lastErroredToolOutput = extractToolResultText(event.result);
				}
			});

			// Send kickoff prompt
			await session.rpcClient.prompt(kickoff);

			// Race: tool result vs idle-without-result
			const result = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(sessionId, timeoutMs).then(() => ({ type: "idle" as const })),
			]);

			if (result.type === "result") {
				// Got structured result — still wait for agent to go idle (cleanup)
				await this.sessionManager!.waitForIdle(sessionId, 30_000).catch(() => {});
				return { passed: result.verdict, output: result.summary, sessionId };
			}

			// Agent went idle without calling the tool — if the last turn hit a
			// JSON/arg-validation glitch, send a targeted retry prompt; otherwise
			// fall back to the generic reminder.
			const jsonErr = lastErroredToolOutput ? detectJsonValidationError(lastErroredToolOutput) : null;
			const reminderPrompt = jsonErr ? buildJsonRetryPrompt(jsonErr) : VERIFICATION_RESULT_REMINDER;
			console.log(`[verification] No verification_result from ${sessionId}, sending ${jsonErr ? "JSON-retry" : "generic"} reminder`);
			await session.rpcClient.prompt(reminderPrompt);
			// Wait for the agent to actually pick up the reminder before racing
			// against waitForIdle — see _tryResumeFromSession for rationale. The
			// live-session path is normally streaming when the reminder fires, but
			// guard for consistency in case the kickoff turn ended without a tool
			// call and the session is already idle.
			await this.sessionManager!.waitForStreaming(sessionId, 10_000).catch(() => {});
			const result2 = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(sessionId, timeoutMs).then(() => ({ type: "idle" as const })),
			]);

			if (result2.type === "result") {
				return { passed: result2.verdict, output: result2.summary, sessionId };
			}

			// Hard failure
			return { passed: false, output: "Agent did not call verification_result after reminder.", sessionId };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out") || err.message?.includes("Timeout");
			const isProcessDeath = err.message?.includes("process exited") || err.message?.includes("process not running");
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.`
				: `LLM review failed: ${err.message}`;
			if (isProcessDeath) {
				console.error(`[verification] Reviewer agent process died during "${step.name}" (session ${sessionId}): ${err.message}`);
			}
			return { passed: false, output: errOutput, sessionId };
		} finally {
			try { errListenerUnsub?.(); } catch { /* ignore */ }
			// Always clean up pending results, extension file, terminate, and unregister
			if (sessionId) {
				this.pendingResults.delete(sessionId);
				try {
					await this.sessionManager!.terminateSession(sessionId);
				} catch { /* ignore — session may already be terminated */ }
				if (this.teamManager) {
					try {
						await this.teamManager.unregisterReviewerSession(goalId, sessionId);
					} catch { /* ignore */ }
				}
			}
		}
	}

	/**
	 * Build the kickoff message sent to a QA-tester sub-agent. Exposed as a
	 * static helper so unit tests can assert that the resolved component name
	 * is threaded into a `[QA-TEST CONTEXT]` block. The /qa-test skill reads
	 * this block in Step 1 to disambiguate when multiple components carry
	 * `config.qa_start_command`.
	 */
	static buildQaKickoffMessage(args: {
		stepName: string;
		prompt?: string;
		branch?: string;
		commit?: string;
		componentName?: string;
	}): string {
		const contextBlock = args.componentName
			? `[QA-TEST CONTEXT]\ncomponent: ${args.componentName}\n\n`
			: "";
		return [
			`Perform QA testing for: "${args.stepName}".`,
			`Your working directory is on branch \`${args.branch || "HEAD"}\` at commit \`${args.commit || "HEAD"}\`.`,
			"",
			`${contextBlock}${args.prompt || ""}`,
			"",
			"## Screenshots",
			"When taking screenshots for the report, call `browser_screenshot(includeBase64=true)`. The screenshot is saved to disk and the tool returns its absolute path in a `[screenshot_file]<path>[/screenshot_file]` text block. Reference screenshots in your HTML report via `<img src=\"file:///<path>\">` — never paste base64 strings into the report (they bloat the transcript and burn tokens). For smaller files you can also pass `format: \"jpeg\", quality: 75`.",
			"",
			"## Submitting Results",
			"After completing all scenarios, call `verification_result` to submit your results:",
			'- `verdict`: "pass" or "fail"',
			"- `summary`: detailed markdown summary — headings, bullet lists, specific findings with file references",
			"- `report_html_file`: path to an HTML report file on disk (PREFERRED — the server reads it directly, so large reports with embedded base64 screenshots work without hitting tool output limits). Write the report in your working directory (e.g. `qa-report.html`) and pass the filename.",
			"- `report_html`: inline HTML report string (only for small reports; for reports with screenshots, always use report_html_file instead)",
			"",
			"This tool call is REQUIRED. Do not emit <verdict> or <qa_report> XML tags.",
		].join("\n");
	}

	/**
	 * Spawn a one-shot test-engineer sub-agent to perform QA testing.
	 * Similar to runLlmReviewViaSession() but with test-engineer role and QA-specific prompt.
	 */
	private async runAgentQaStep(
		step: { name: string; prompt?: string; timeout?: number; role?: string; component?: string },
		cwd: string,
		goalId: string,
		builtinVars: Record<string, string>,
		_signalContent?: string,
		_signalMetadata?: Record<string, string>,
		goalSpec?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
		sessionId?: string,
	): Promise<{ passed: boolean; output: string; sessionId?: string; artifact?: { content: string; contentType: string } }> {
		const QA_MAX_ARTIFACT = 10 * 1024 * 1024; // 10 MB — same limit as llm-review artifacts
		const role = this.roleStore.get(step.role || "qa-tester") || this.roleStore.get("test-engineer") || this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: "Agent QA failed: no 'qa-tester', 'test-engineer', or 'reviewer' role found in role store.", sessionId };
		}

		// Build system prompt using the role's prompt template
		const rolePrompt = role.promptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, builtinVars.branch || "HEAD")
			.replace(/\{\{AGENT_ID\}\}/g, role.name || "qa-tester");
		const sections: string[] = [rolePrompt || "You are a QA tester performing automated testing."];
		if (step.prompt) sections.push(`\n## Task\n\n${step.prompt}`);
		if (goalSpec) sections.push(`\n## Goal Specification\n\n${goalSpec}`);
		if (allGateStates) {
			const upstreamParts: string[] = [];
			for (const [gateId, gs] of allGateStates) {
				if (gs.status === "passed" && gs.injectDownstream && gs.content) {
					upstreamParts.push(`### Gate: ${gateId}\n\n${gs.content}`);
				}
			}
			if (upstreamParts.length > 0) {
				sections.push(`\n## Upstream Gate Content\n\n${upstreamParts.join("\n\n")}`);
			}
		}
		const combinedPrompt = sections.join("\n");

		// Compute timeout: qa_max_duration_minutes + 5 min buffer.
		// `qa_max_duration_minutes` lives on the owning component's `config`
		// map. Most agent-qa steps now declare `component:` explicitly; for
		// legacy gates without it, fall back to the first component carrying
		// `qa_start_command`, then a project-name match, then `components[0]`.
		const pcs = this.resolveProjectConfigStore(goalId);
		const componentName = step.component
			?? this.resolveDefaultQaComponentName(goalId)
			?? "";
		const qaMinutes = pcs?.getQaMaxDurationMinutes(componentName) ?? 10;
		const qaTimeoutMs = (qaMinutes + 5) * 60 * 1000;
		const timeoutMs = Math.max(qaTimeoutMs, (step.timeout || 900) * 1000);

		// Build kickoff message via the testable static helper. Threads the
		// resolved `componentName` into a `[QA-TEST CONTEXT]` block when present,
		// so the /qa-test skill picks the correct component (see
		// .claude/skills/qa-test/SKILL.md Step 1).
		const kickoff = VerificationHarness.buildQaKickoffMessage({
			stepName: step.name,
			prompt: step.prompt,
			branch: builtinVars.branch,
			commit: builtinVars.commit,
			componentName,
		});
		let qaSessionId: string | undefined;
		let qaLastErroredToolOutput: string | null = null;
		let qaErrListenerUnsub: (() => void) | undefined;
		try {
			// Create session via SessionManager
			const qaRoleName = role.name || step.role || "qa-tester";

			// Pre-generate sessionId so we can register the verification_result resolver before session creation
			qaSessionId = sessionId || `agent-qa-${randomUUID().slice(0, 12)}`;

			// Set up verification_result promise
			const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
			this.pendingResults.set(qaSessionId, resultResolver);

			// verification_result tool is registered via the standard goal tools extension (tasks/extension.ts)
			const qaIsSandboxed = (goalId
				? this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId)?.sandboxed
				: undefined) ?? this.sessionManager!.isSandboxEnabled;

			// Resolve QA model + thinking level for spawn-time pin.
			const _preQaRoleOverrides = this.resolveRoleForGoal(qaRoleName, goalId);
			const _preQaRoleModel = _preQaRoleOverrides?.model;
			const _preQaReviewPref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
			const _preQaInitialModel = (_preQaRoleModel && /^[^/]+\/.+$/.test(_preQaRoleModel))
				? _preQaRoleModel
				: ((_preQaReviewPref && /^[^/]+\/.+$/.test(_preQaReviewPref)) ? _preQaReviewPref : undefined);
			const _preQaRoleThinking = _preQaRoleOverrides?.thinkingLevel;
			const _preQaReviewThinkPref = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
			const _qaValidLevels = THINKING_LEVELS as readonly string[];
			const _preQaInitialThinkingRaw = (_preQaRoleThinking && _qaValidLevels.includes(_preQaRoleThinking))
				? _preQaRoleThinking
				: ((_preQaReviewThinkPref && _qaValidLevels.includes(_preQaReviewThinkPref)) ? _preQaReviewThinkPref : "off");
			const _preQaInitialThinking = clampReviewThinking(_preQaInitialThinkingRaw, _preQaInitialModel) ?? _preQaInitialThinkingRaw;

			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName: qaRoleName,
				sandboxed: qaIsSandboxed,
				sessionId: qaSessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
				initialModel: _preQaInitialModel,
				initialThinkingLevel: _preQaInitialThinking,
			});
			qaSessionId = session.id;

			// Set title and metadata
			const qaFunName = await generateTeamName("verification");
			this.sessionManager!.setTitle(qaSessionId, `${step.name}: ${qaFunName}`);
			this.sessionManager!.updateSessionMeta(qaSessionId, {
				role: qaRoleName,
				teamGoalId: goalId,
				accessory: role.accessory || "stamp",
				nonInteractive: true,
			});

			// Register in team store
			if (this.teamManager) {
				try {
					await this.teamManager.registerReviewerSession(goalId, qaSessionId, step.name);
				} catch (err) {
					console.warn(`[verification] Failed to register QA session in team:`, err);
				}
			}

			// Resolve role overrides for QA — role wins over default.reviewModel/Thinking.
			const roleOverrides_q = this.resolveRoleForGoal(qaRoleName, goalId);
			const roleModel_q = roleOverrides_q?.model;
			const roleThinking_q = roleOverrides_q?.thinkingLevel;

			// Override model: role wins, else default.reviewModel preference.
			// Throws on failure/mismatch — outer catch converts to a failed gate result.
			if (roleModel_q) {
				try {
					await applyModelString(session.rpcClient, roleModel_q, {
						sessionManager: this.sessionManager ?? null,
						sessionId: qaSessionId,
						contextLabel: `role.${qaRoleName}.model`,
						skipSetModel: _preQaInitialModel === roleModel_q,
					});
					console.log(`[verification] Set role-override model "${roleModel_q}" for QA ${qaSessionId} (role=${qaRoleName})`);
				} catch (err) {
					console.error(`[verification] Role model "${roleModel_q}" failed for QA ${qaSessionId}:`, err);
					throw err;
				}
			} else if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				try {
					await applyReviewModelOverrides(session.rpcClient, {
						prefs: { get: (k) => this.preferencesStore!.get(k) as string | undefined },
						sessionManager: this.sessionManager ?? null,
						sessionId: qaSessionId,
						role: "qa",
						skipSetModel: !!reviewModelPref && _preQaInitialModel === reviewModelPref,
					});
					if (reviewModelPref) {
						console.log(`[verification] Set QA model "${reviewModelPref}" for ${qaSessionId}`);
					}
				} catch (err) {
					console.error(`[verification] applyReviewModelOverrides failed for QA ${qaSessionId} (pref="${reviewModelPref ?? "<unset>"}"):`, err);
					throw err;
				}
			}

			// Apply thinking level: role wins; else default.reviewThinkingLevel pref; else "off".
			{
				let level: string;
				if (roleThinking_q) {
					level = roleThinking_q;
				} else {
					const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
					level = (reviewThinking && (THINKING_LEVELS as readonly string[]).includes(reviewThinking))
						? reviewThinking : "off";
				}
				level = clampReviewThinking(level, roleModel_q ?? this.preferencesStore?.get("default.reviewModel") as string | undefined) ?? level;
				if (_preQaInitialThinking === level) {
					console.log(`[verification] QA thinking level "${level}" already pinned at spawn for ${qaSessionId}`);
				} else {
					try {
						await session.rpcClient.setThinkingLevel(level);
					} catch (err) {
						console.error(`[verification] Failed to set QA thinking level:`, err);
					}
				}
			}

			// Watch for errored tool_results so we can send a targeted JSON-retry
			// prompt if the agent gives up after a streaming/arg-validation glitch.
			qaErrListenerUnsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "tool_execution_end" && event.isError) {
					qaLastErroredToolOutput = extractToolResultText(event.result);
				}
			});

			// Send kickoff prompt
			await session.rpcClient.prompt(kickoff);

			// Race: tool result vs idle-without-result
			const result = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(qaSessionId, timeoutMs).then(() => ({ type: "idle" as const })),
			]);

			if (result.type === "result") {
				// Got structured result — still wait for agent to go idle (cleanup)
				await this.sessionManager!.waitForIdle(qaSessionId, 30_000).catch(() => {});
				const artifact = result.reportHtml
					? { content: result.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
					: undefined;
				return { passed: result.verdict, output: result.summary, sessionId: qaSessionId, artifact };
			}

			// Agent went idle without calling the tool — if the last turn hit a
			// JSON/arg-validation glitch, send a targeted retry prompt; otherwise
			// fall back to the generic reminder.
			const qaJsonErr = qaLastErroredToolOutput ? detectJsonValidationError(qaLastErroredToolOutput) : null;
			const qaReminderPrompt = qaJsonErr ? buildJsonRetryPrompt(qaJsonErr) : VERIFICATION_RESULT_REMINDER;
			console.log(`[verification] No verification_result from QA agent ${qaSessionId}, sending ${qaJsonErr ? "JSON-retry" : "generic"} reminder`);
			await session.rpcClient.prompt(qaReminderPrompt);
			// Wait for the agent to actually pick up the reminder before racing
			// against waitForIdle — see _tryResumeFromSession for rationale.
			await this.sessionManager!.waitForStreaming(qaSessionId, 10_000).catch(() => {});
			const result2 = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(qaSessionId, timeoutMs).then(() => ({ type: "idle" as const })),
			]);

			if (result2.type === "result") {
				const artifact = result2.reportHtml
					? { content: result2.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
					: undefined;
				return { passed: result2.verdict, output: result2.summary, sessionId: qaSessionId, artifact };
			}

			// Hard failure
			return { passed: false, output: "Agent did not call verification_result after reminder.", sessionId: qaSessionId };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out") || err.message?.includes("Timeout");
			const isProcessDeath = err.message?.includes("process exited") || err.message?.includes("process not running");
			const errOutput = isTimeout
				? `Agent QA timed out after ${(timeoutMs / 1000)}s.`
				: `Agent QA failed: ${err.message}`;
			if (isProcessDeath) {
				console.error(`[verification] QA agent process died during "${step.name}" (session ${qaSessionId}): ${err.message}`);
			}
			return { passed: false, output: errOutput, sessionId: qaSessionId };
		} finally {
			try { qaErrListenerUnsub?.(); } catch { /* ignore */ }
			if (qaSessionId) {
				this.pendingResults.delete(qaSessionId);
				try { await this.sessionManager!.terminateSession(qaSessionId); } catch { /* ignore */ }
				if (this.teamManager) {
					try { await this.teamManager.unregisterReviewerSession(goalId, qaSessionId); } catch { /* ignore */ }
				}
			}
		}
	}

	/**
	 * Legacy direct-RpcBridge path for LLM review (invisible to UI).
	 * Used when SessionManager is not available.
	 */
	private async runLlmReviewDirect(
		step: { name: string; prompt?: string; timeout?: number },
		cwd: string,
		role: { promptTemplate: string; toolPolicies?: Record<string, string> },
		combinedPrompt: string,
		kickoff: string,
		timeoutMs: number,
		roleName?: string,
	): Promise<{ passed: boolean; output: string; sessionId?: string }> {
		const subSessionId = `llm-review-${randomUUID().slice(0, 12)}`;

		// Set up verification_result promise
		const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
		this.pendingResults.set(subSessionId, resultResolver);

		// Assemble system prompt to temp file
		const systemPromptPath = assembleSystemPrompt(subSessionId, {
			cwd,
			goalSpec: combinedPrompt,
			goalTitle: `LLM Review: ${step.name}`,
			goalState: "active",
		});

		// Derive allowed tools from toolPolicies (include all non-"never" entries)
		const allowedTools = role.toolPolicies
			? Object.entries(role.toolPolicies).filter(([, p]) => p !== "never").map(([name]) => name)
			: [];
		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: [
				...(allowedTools.length > 0 ? ["--tools", allowedTools.join(",")] : []),
			],
		};
		if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

		// Resolve and pin model + thinking level at spawn time (legacy direct path).
		const _preLegacyRoleOverrides = roleName ? this.resolveRoleForGoal(roleName) : undefined;
		const _preLegacyRoleModel = _preLegacyRoleOverrides?.model;
		const _preLegacyReviewPref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
		const _preLegacyInitialModel = (_preLegacyRoleModel && /^[^/]+\/.+$/.test(_preLegacyRoleModel))
			? _preLegacyRoleModel
			: ((_preLegacyReviewPref && /^[^/]+\/.+$/.test(_preLegacyReviewPref)) ? _preLegacyReviewPref : undefined);
		if (_preLegacyInitialModel) bridgeOptions.initialModel = _preLegacyInitialModel;
		const _preLegacyRoleThinking = _preLegacyRoleOverrides?.thinkingLevel;
		const _preLegacyReviewThinkPref = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
		const _legacyValidLevels = THINKING_LEVELS as readonly string[];
		const _preLegacyInitialThinkingRaw = (_preLegacyRoleThinking && _legacyValidLevels.includes(_preLegacyRoleThinking))
			? _preLegacyRoleThinking
			: ((_preLegacyReviewThinkPref && _legacyValidLevels.includes(_preLegacyReviewThinkPref)) ? _preLegacyReviewThinkPref : "off");
		const _preLegacyInitialThinking = clampReviewThinking(_preLegacyInitialThinkingRaw, _preLegacyInitialModel) ?? _preLegacyInitialThinkingRaw;
		bridgeOptions.initialThinkingLevel = _preLegacyInitialThinking;

		const rpc = new RpcBridge(bridgeOptions);
		let unregisterSession: (() => void) | undefined;
		let legacyLastErroredToolOutput: string | null = null;
		let legacyErrListenerUnsub: (() => void) | undefined;

		try {
			await rpc.start();

			legacyErrListenerUnsub = rpc.onEvent((event: any) => {
				if (event.type === "tool_execution_end" && event.isError) {
					legacyLastErroredToolOutput = extractToolResultText(event.result);
				}
			});

			// Register as a viewable session so users can watch the review live
			if (this.sessionManager) {
				// Best-effort: resolve the project from cwd so the review session
				// persists under a real project. If none is registered, we simply
				// don't register the session as viewable (no silent default).
				const reviewProjectId = this.projectContextManager?.getRegistry().findByCwd(cwd)?.id;
				if (reviewProjectId) {
					unregisterSession = this.sessionManager.registerExternalSession(subSessionId, rpc, {
						title: `LLM Review: ${step.name}`,
						cwd,
						role: "reviewer",
						projectId: reviewProjectId,
					});
				}
			}

			// Resolve role overrides (sub-session path: no goalId for project lookup).
			const roleOverrides_s = roleName ? this.resolveRoleForGoal(roleName) : undefined;
			const roleModel_s = roleOverrides_s?.model;
			const roleThinking_s = roleOverrides_s?.thinkingLevel;

			// Override model: role wins, else default.reviewModel preference.
			// Sub-session path: no UI session, no persistence (sessionManager=null).
			// Throws on failure/mismatch — outer catch converts to a failed gate result.
			if (roleModel_s) {
				try {
					await applyModelString(rpc, roleModel_s, {
						sessionManager: null,
						sessionId: null,
						contextLabel: `role.${roleName}.model`,
						skipSetModel: _preLegacyInitialModel === roleModel_s,
					});
					console.log(`[verification] Set role-override model "${roleModel_s}" for sub-session ${subSessionId} (role=${roleName})`);
				} catch (err) {
					console.error(`[verification] Role model "${roleModel_s}" failed for sub-session ${subSessionId}:`, err);
					throw err;
				}
			} else if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				try {
					await applyReviewModelOverrides(rpc, {
						prefs: { get: (k) => this.preferencesStore!.get(k) as string | undefined },
						sessionManager: null,
						sessionId: null,
						role: "subsession",
						skipSetModel: !!reviewModelPref && _preLegacyInitialModel === reviewModelPref,
					});
					if (reviewModelPref) {
						console.log(`[verification] Set review model "${reviewModelPref}" for ${subSessionId}`);
					}
				} catch (err) {
					console.error(`[verification] applyReviewModelOverrides failed for sub-session ${subSessionId} (pref="${reviewModelPref ?? "<unset>"}"):`, err);
					throw err;
				}
			}

			// Apply thinking level: role wins; else default.reviewThinkingLevel pref; else "off".
			{
				let level: string;
				if (roleThinking_s) {
					level = roleThinking_s;
				} else {
					const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
					level = (reviewThinking && (THINKING_LEVELS as readonly string[]).includes(reviewThinking))
						? reviewThinking : "off";
				}
				level = clampReviewThinking(level, roleModel_s ?? this.preferencesStore?.get("default.reviewModel") as string | undefined) ?? level;
				if (_preLegacyInitialThinking === level) {
					console.log(`[verification] Review thinking level "${level}" already pinned at spawn for ${subSessionId}`);
				} else {
					try {
						await rpc.setThinkingLevel(level);
						console.log(`[verification] Set review thinking level "${level}" for ${subSessionId}"${roleThinking_s ? " (role override)" : ""}`);
					} catch (err) {
						console.error(`[verification] Failed to set review thinking level:`, err);
					}
				}
			}

			const completionPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`LLM review sub-agent timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs);

				const eventUnsub = rpc.onEvent((event: any) => {
					if (event.type === "agent_end") {
						clearTimeout(timer);
						eventUnsub();
						resolve();
					}
				});
			});

			await rpc.prompt(kickoff);

			// Race: tool result vs agent completion
			const result = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				completionPromise.then(() => ({ type: "idle" as const })),
			]);

			if (result.type === "result") {
				// Got structured result — wait briefly for agent to finish
				await completionPromise.catch(() => {});
				return { passed: result.verdict, output: result.summary, sessionId: subSessionId };
			}

			// Agent completed without calling the tool — send reminder
			console.log(`[verification] No verification_result from ${subSessionId}, sending reminder`);

			const reminderCompletionPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`Reminder timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs);
				const eventUnsub = rpc.onEvent((event: any) => {
					if (event.type === "agent_end") {
						clearTimeout(timer);
						eventUnsub();
						resolve();
					}
				});
			});

			const legacyJsonErr = legacyLastErroredToolOutput ? detectJsonValidationError(legacyLastErroredToolOutput) : null;
			const legacyReminderPrompt = legacyJsonErr ? buildJsonRetryPrompt(legacyJsonErr) : VERIFICATION_RESULT_REMINDER;
			if (legacyJsonErr) {
				console.log(`[verification] Detected JSON/arg-validation glitch in ${subSessionId}, sending targeted retry prompt`);
			}
			await rpc.prompt(legacyReminderPrompt);
			// Wait briefly for the agent to acknowledge the reminder (agent_start)
			// before racing against agent_end — mirror of SessionManager.waitForStreaming
			// for the legacy direct-RpcBridge path.
			await new Promise<void>((resolve) => {
				const t = setTimeout(() => { try { unsub(); } catch { /* ignore */ } resolve(); }, 10_000);
				const unsub = rpc.onEvent((event: any) => {
					if (event.type === "agent_start") {
						clearTimeout(t);
						try { unsub(); } catch { /* ignore */ }
						resolve();
					}
				});
			}).catch(() => {});

			const result2 = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				reminderCompletionPromise.then(() => ({ type: "idle" as const })),
			]);

			if (result2.type === "result") {
				return { passed: result2.verdict, output: result2.summary, sessionId: subSessionId };
			}

			return { passed: false, output: "Agent did not call verification_result after reminder.", sessionId: subSessionId };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out");
			const isProcessDeath = err.message?.includes("process exited") || err.message?.includes("process not running");
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.`
				: `LLM review failed: ${err.message}`;
			if (isProcessDeath) {
				console.error(`[verification] Reviewer agent process died during "${step.name}" (session ${subSessionId}): ${err.message}`);
			}
			return { passed: false, output: errOutput, sessionId: subSessionId };
		} finally {
			try { legacyErrListenerUnsub?.(); } catch { /* ignore */ }
			this.pendingResults.delete(subSessionId);
			await rpc.stop().catch(() => {});
			// Unregister the session (archives it so chat history remains viewable)
			if (unregisterSession) unregisterSession();
			try {
				const promptDir = path.join(this._stateDir, "session-prompts");
				const promptFile = path.join(promptDir, `${subSessionId}.md`);
				if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
			} catch { /* ignore */ }

		}
	}

	/**
	 * Substitute namespaced variables in a template string.
	 *
	 * Namespaces:
	 * - {{branch}}, {{master}}, etc. — built-in goal variables
	 * - {{project.key}} — from project config (.bobbit/config/project.yaml)
	 * - {{agent.key}} — from the signal's metadata (provided by the agent)
	 * - {{gate_id.meta.key}} — from an upstream gate's metadata
	 * - {{goal_spec}} — the goal specification text
	 *
	 * Legacy bare references like {{typecheck_command}} are NOT resolved to
	 * prevent accidental cross-namespace collisions. Use the explicit namespace.
	 */
	private substituteVars(
		template: string,
		builtinVars: Record<string, string>,
		projectVars: Record<string, string>,
		agentVars: Record<string, string>,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
	): string {
		return _substituteVars(template, builtinVars, projectVars, agentVars, allGateStates);
	}

	/**
	 * Spawn a command-type verification step.
	 *
	 * Two execution modes:
	 *
	 * 1. **Detached survival mode** (Layer 1 — default for non-container,
	 *    streamed steps): the child is spawned with `detached: true` and
	 *    stdout/stderr redirected to files under
	 *    `<stateDir>/verifications/<signalId>/<stepIndex>.{out,err}`. A small
	 *    shell wrapper writes the exit code to `<stepIndex>.exit` via an
	 *    atomic `mv tmp → exit` so that even SIGKILL of the gateway leaves
	 *    either no exit file (child still running) or a complete one. We
	 *    `unref()` the child, stamp pid + bootEpoch + file paths onto the
	 *    persisted `ActiveVerification.step`, and from the parent we tail
	 *    the files for live broadcast. On gateway restart,
	 *    `_resumeCommandStep` re-attaches by polling the exit file.
	 *
	 * 2. **Attached pipe mode** (fallback): used when running inside a docker
	 *    container (`containerId` set) or when no `streamCtx` is available
	 *    (i.e. no signal/step to anchor file paths on). Docker steps stay on
	 *    this path because writing the exit file inside the container while
	 *    persisting state on the host adds complexity that isn't required by
	 *    the acceptance criteria — container survival across host gateway
	 *    restart is intentionally out of scope.
	 */
	private runCommandStep(
		command: string,
		cwd: string,
		timeoutSec: number,
		expectFailure: boolean,
		streamCtx?: { goalId: string; gateId: string; signalId: string; stepIndex: number },
		errorPattern?: string,
		containerId?: string,
	): Promise<{ passed: boolean; output: string }> {
		return new Promise((resolve) => {
			const normalizedCwd = cwd.replace(/\\/g, "/");
			// Shell selection: default to plain bash (fast), use --login only for
			// commands that need the full interactive PATH (npm, pytest, gh, etc.).
			const { shell: shellBin, args: shellArgs } = getVerificationShell(command);

			// Decide execution mode.
			let useDetached = !containerId && !!streamCtx;

			// On Windows without Git Bash, the resolved shell is cmd.exe which
			// cannot execute the bash exit-file wrapper. Silently degrade to
			// attached mode so the verification still runs, and warn once so
			// the missing restart-survival capability is visible in the logs.
			if (useDetached && process.platform === "win32" && !GIT_BASH) {
				if (!VerificationHarness._warnedCmdExeDetached) {
					VerificationHarness._warnedCmdExeDetached = true;
					console.warn("[verification] Git Bash not found on Windows — detached command mode disabled (cmd.exe cannot run the bash exit-file wrapper). Verification command steps will not survive a gateway restart.");
				}
				useDetached = false;
			}
			let outFile: string | undefined;
			let errFile: string | undefined;
			let exitFile: string | undefined;
			let outFd: number | undefined;
			let errFd: number | undefined;

			if (useDetached && streamCtx) {
				try {
					const stepDir = path.join(this._stateDir, "verifications", streamCtx.signalId);
					fs.mkdirSync(stepDir, { recursive: true });
					outFile = path.join(stepDir, `${streamCtx.stepIndex}.out`);
					errFile = path.join(stepDir, `${streamCtx.stepIndex}.err`);
					exitFile = path.join(stepDir, `${streamCtx.stepIndex}.exit`);
					try { fs.unlinkSync(exitFile); } catch { /* not present */ }
					try { fs.unlinkSync(exitFile + ".tmp"); } catch { /* not present */ }
					outFd = fs.openSync(outFile, "w");
					errFd = fs.openSync(errFile, "w");
				} catch (err) {
					console.warn(`[verification] Failed to set up survival files — falling back to attached mode: ${(err as Error).message}`);
					if (outFd !== undefined) { try { fs.closeSync(outFd); } catch {} }
					if (errFd !== undefined) { try { fs.closeSync(errFd); } catch {} }
					useDetached = false;
					outFile = errFile = exitFile = undefined;
				}
			}

			// Build the command to actually run. In detached mode we wrap so
			// the wrapper, not the gateway, owns writing the exit code atomically.
			let cmdToRun = command;
			if (useDetached && exitFile) {
				const exitTmp = exitFile + ".tmp";
				const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
				// Run command in a subshell so its `exit` does not short-circuit our
				// exit-file write; capture $?, write atomically, then propagate.
				cmdToRun = `( ${command}\n); __ec=$?; printf %s "$__ec" > ${sq(exitTmp)} && mv ${sq(exitTmp)} ${sq(exitFile)}; exit $__ec`;
			}

			// Resolve a synchronously-thrown spawn error the same way we'd
			// handle child.on("error", ...) — surface the error text and honour
			// expectFailure semantics. Without this, accessing child.pid below
			// would throw TypeError and crash the verification pipeline.
			const handleSpawnError = (err: Error): { passed: boolean; output: string } => {
				if (expectFailure && errorPattern) {
					try {
						const regex = new RegExp(errorPattern, "i");
						return { passed: regex.test(err.message), output: err.message };
					} catch {
						return { passed: false, output: `Invalid error_pattern regex when handling spawn error: ${err.message}` };
					}
				}
				return { passed: expectFailure, output: err.message };
			};

			let child;
			let spawnError: Error | undefined;
			try {
				child = containerId
					? spawn("docker", ["exec", "-w", normalizedCwd, containerId, "/bin/sh", "-c", command], {
						stdio: ["ignore", "pipe", "pipe"],
						timeout: timeoutSec * 1000,
						env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
					})
					: useDetached
						? spawn(shellBin, [...shellArgs, cmdToRun], {
							cwd: normalizedCwd,
							detached: true,
							stdio: ["ignore", outFd!, errFd!],
							...(process.platform === "win32" ? { windowsHide: true } : {}),
						})
						: spawn(shellBin, [...shellArgs, cmdToRun], {
							cwd: normalizedCwd,
							timeout: timeoutSec * 1000,
							stdio: ["ignore", "pipe", "pipe"],
							...(process.platform === "win32" ? { windowsHide: true } : {}),
						});
			} catch (err) {
				spawnError = err as Error;
			} finally {
				// Once spawn has dup'd the FDs into the child, parent's copies are
				// no longer needed. Closing them avoids leaks even if we don't
				// reach the resolve path.
				if (outFd !== undefined) { try { fs.closeSync(outFd); } catch {} }
				if (errFd !== undefined) { try { fs.closeSync(errFd); } catch {} }
			}

			if (spawnError || !child) {
				resolve(handleSpawnError(spawnError ?? new Error("spawn returned no child")));
				return;
			}

			// Stamp the persisted step with everything needed for cross-restart
			// recovery before doing anything else — if the gateway dies right
			// now, the next boot must be able to find the child.
			if (useDetached && streamCtx && child.pid != null) {
				const av = this.activeVerifications.get(streamCtx.signalId);
				if (av && av.steps[streamCtx.stepIndex]) {
					const s = av.steps[streamCtx.stepIndex];
					s.pid = child.pid;
					s.startTimeMs = Date.now();
					s.outFile = outFile;
					s.errFile = errFile;
					s.exitFile = exitFile;
					s.bootEpoch = this.bootEpoch;
					s.timeoutSec = timeoutSec;
					s.expectFailure = expectFailure;
					s.errorPattern = errorPattern;
					this._persistActive();
				}
				// unref so the child does not keep the gateway alive during a
				// graceful shutdown — we want it to survive past our exit.
				try { child.unref(); } catch { /* ignore */ }
			}

			let stdout = "";
			let stderr = "";
			let stopTail: (() => void) | undefined;

			if (useDetached && streamCtx && outFile && errFile) {
				stopTail = this._startFileTailers(outFile, errFile, streamCtx);
			} else if (!useDetached) {
				const onData = (text: string, stream: "stdout" | "stderr") => {
					if (stream === "stdout") {
						stdout += text;
						if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024);
					} else {
						stderr += text;
						if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
					}
					if (streamCtx) {
						this.broadcastFn(streamCtx.goalId, {
							type: "gate_verification_step_output",
							goalId: streamCtx.goalId,
							gateId: streamCtx.gateId,
							signalId: streamCtx.signalId,
							stepIndex: streamCtx.stepIndex,
							stream,
							text,
							ts: Date.now(),
						});
						const av = this.activeVerifications.get(streamCtx.signalId);
						if (av && av.steps[streamCtx.stepIndex]) {
							const step = av.steps[streamCtx.stepIndex];
							step.output = (step.output || "") + text;
							if (step.output.length > 512 * 1024) {
								step.output = step.output.slice(-512 * 1024);
							}
						}
					}
				};
				child.stdout?.on("data", (d: Buffer) => onData(d.toString(), "stdout"));
				child.stderr?.on("data", (d: Buffer) => onData(d.toString(), "stderr"));
			}

			// Manual timeout for the detached path — spawn's `timeout` option
			// kills only the immediate child; the detached subshell may outlive
			// it on some platforms. Doing it ourselves keeps the semantics
			// uniform across modes.
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (useDetached) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
				}, timeoutSec * 1000);
			}

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				try { stopTail?.(); } catch { /* ignore */ }

				let outText = stdout;
				let errText = stderr;
				if (useDetached && outFile && errFile) {
					try { outText = fs.readFileSync(outFile, "utf8"); } catch { outText = stdout; }
					try { errText = fs.readFileSync(errFile, "utf8"); } catch { errText = stderr; }
				}
				const output = (outText + "\n" + errText).trim().slice(-5000);
				const effectiveCode: number | null = timedOut ? null : code;
				if (expectFailure) {
					resolve(matchExpectFailure(effectiveCode, output, errorPattern));
					return;
				}
				if (timedOut) {
					resolve({ passed: false, output: output || `command timed out after ${timeoutSec}s` });
					return;
				}
				resolve({ passed: code === 0, output: output || `exit code ${code}` });
			});
			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				try { stopTail?.(); } catch { /* ignore */ }
				resolve(handleSpawnError(err));
			});
		});
	}

	/**
	 * Poll the per-step stdout/stderr files for new bytes and broadcast each
	 * chunk as a `gate_verification_step_output` event, mirroring the live
	 * UI broadcast path of the legacy attached-pipe mode. Returns a stop
	 * function that does a final flush before clearing the interval.
	 */
	private _startFileTailers(
		outFile: string,
		errFile: string,
		ctx: { goalId: string; gateId: string; signalId: string; stepIndex: number },
	): () => void {
		let outPos = 0;
		let errPos = 0;
		let stopped = false;

		const readNew = (filePath: string, pos: number, stream: "stdout" | "stderr"): number => {
			try {
				const stat = fs.statSync(filePath);
				if (stat.size <= pos) return pos;
				const fd = fs.openSync(filePath, "r");
				try {
					const len = stat.size - pos;
					const buf = Buffer.alloc(len);
					fs.readSync(fd, buf, 0, len, pos);
					const text = buf.toString("utf8");
					this.broadcastFn(ctx.goalId, {
						type: "gate_verification_step_output",
						goalId: ctx.goalId,
						gateId: ctx.gateId,
						signalId: ctx.signalId,
						stepIndex: ctx.stepIndex,
						stream,
						text,
						ts: Date.now(),
					});
					const av = this.activeVerifications.get(ctx.signalId);
					if (av && av.steps[ctx.stepIndex]) {
						const s = av.steps[ctx.stepIndex];
						s.output = (s.output || "") + text;
						if (s.output.length > 512 * 1024) s.output = s.output.slice(-512 * 1024);
					}
					return stat.size;
				} finally {
					try { fs.closeSync(fd); } catch { /* ignore */ }
				}
			} catch {
				return pos;
			}
		};

		const interval = setInterval(() => {
			if (stopped) return;
			outPos = readNew(outFile, outPos, "stdout");
			errPos = readNew(errFile, errPos, "stderr");
		}, 200);

		return () => {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
			// Final flush to catch the tail end of output written between the
			// last poll and child exit.
			outPos = readNew(outFile, outPos, "stdout");
			errPos = readNew(errFile, errPos, "stderr");
		};
	}

	/**
	 * Resume a command-type step that was running when the gateway died.
	 *
	 * Strategy (see `ActiveVerification` jsdoc for context):
	 *
	 * 1. If `exitFile` already exists — the wrapper completed before we got
	 *    back — read it plus the stdout/stderr tails and finalize via the
	 *    same `matchExpectFailure` / pass-fail logic the live path uses.
	 * 2. Else if `pid` is still alive — the detached child outlived the
	 *    gateway and is still chugging away. Poll for the exit file with
	 *    the remaining timeout budget computed from `startedAt`.
	 * 3. Else — process is gone and there's no exit file. The child was
	 *    killed (OOM, manual kill, antivirus). Finalize as failed.
	 *
	 * Returns null when there's nothing to resume (no exit file recorded,
	 * e.g. the step pre-dates Layer 1 or used the attached-mode fallback)
	 * so the caller can fall through to the legacy "no session id" failure.
	 */
	private async _resumeCommandStep(
		v: ActiveVerification,
		step: ActiveVerification["steps"][number],
	): Promise<{ name: string; type: string; passed: boolean; output: string; duration_ms: number } | null> {
		if (!step.exitFile && !step.pid) return null;

		const readFiles = (): { out: string; err: string } => {
			let out = "";
			let err = "";
			try { if (step.outFile) out = fs.readFileSync(step.outFile, "utf8"); } catch { /* ignore */ }
			try { if (step.errFile) err = fs.readFileSync(step.errFile, "utf8"); } catch { /* ignore */ }
			return { out, err };
		};
		const readExitFile = (): number | null => {
			if (!step.exitFile) return null;
			try {
				const raw = fs.readFileSync(step.exitFile, "utf8").trim();
				const n = parseInt(raw, 10);
				return Number.isFinite(n) ? n : null;
			} catch {
				return null;
			}
		};
		const finalize = (code: number | null) => {
			const { out, err } = readFiles();
			const output = (out + "\n" + err).trim().slice(-5000);
			let passed: boolean;
			let displayOutput: string;
			if (step.expectFailure) {
				const m = matchExpectFailure(code, output, step.errorPattern);
				passed = m.passed;
				displayOutput = m.output;
			} else {
				passed = code === 0;
				displayOutput = output || `exit code ${code}`;
			}
			return {
				name: step.name,
				type: step.type,
				passed,
				output: displayOutput,
				duration_ms: Date.now() - step.startedAt,
			};
		};

		// Case A: child already finished before we restarted.
		if (step.exitFile && fs.existsSync(step.exitFile)) {
			console.log(`[verification] Resume: exit file present for "${step.name}" — finalizing from disk`);
			return finalize(readExitFile());
		}

		// Cross-platform PID-reuse safeguard: Node doesn't expose a per-PID OS
		// start time, so we can't directly tie a live pid back to the same
		// process we spawned. As a pragmatic floor: if the recorded
		// startTimeMs is older than the step's own timeout, the original
		// child must already have exited (timeout would have killed it),
		// so a live `step.pid` here is almost certainly a reused/recycled
		// pid belonging to an unrelated process. Skip Case B and fall
		// through to Case C (finalize as failed).
		const timeoutSec = step.timeoutSec ?? 300;
		const pidLooksReused = typeof step.startTimeMs === "number"
			&& (Date.now() - step.startTimeMs) > timeoutSec * 1000;

		// Case B: child still running on the host.
		if (!pidLooksReused && typeof step.pid === "number" && isPidAlive(step.pid)) {
			const timeoutMs = timeoutSec * 1000;
			const deadline = step.startedAt + timeoutMs;
			console.log(`[verification] Resume: pid ${step.pid} for "${step.name}" still alive — polling for exit file (deadline in ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s)`);

			// Tail the surviving child's stdout/stderr files so UI clients see
			// live output during the resume wait (and so subsequent gate_status
			// calls show the streamed tail). Mirrors the live-spawn path.
			let stopTail: (() => void) | undefined;
			if (step.outFile && step.errFile) {
				const stepIndex = v.steps.indexOf(step);
				if (stepIndex >= 0) {
					stopTail = this._startFileTailers(step.outFile, step.errFile, {
						goalId: v.goalId,
						gateId: v.gateId,
						signalId: v.signalId,
						stepIndex,
					});
				}
			}

			try {
				while (Date.now() < deadline) {
					await new Promise(r => setTimeout(r, 500));
					if (step.exitFile && fs.existsSync(step.exitFile)) {
						return finalize(readExitFile());
					}
					if (!isPidAlive(step.pid)) break;
				}
				// One last check after the loop
				if (step.exitFile && fs.existsSync(step.exitFile)) {
					return finalize(readExitFile());
				}
				// Timed out or process died without writing the exit file
				try { if (step.pid) process.kill(step.pid, "SIGKILL"); } catch { /* already dead */ }
				return {
					name: step.name,
					type: step.type,
					passed: false,
					output: "Verification command did not produce an exit code (timeout or process died after restart).",
					duration_ms: Date.now() - step.startedAt,
				};
			} finally {
				if (stopTail) stopTail();
			}
		}

		// Case C: process gone, no exit file — killed by something between our
		// last persist and now.
		console.log(`[verification] Resume: pid/exit-file gone for "${step.name}" — marking failed`);
		return {
			name: step.name,
			type: step.type,
			passed: false,
			output: "Verification command process died during gateway restart before producing an exit code.",
			duration_ms: Date.now() - step.startedAt,
		};
	}
}

