import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GateStore, GateSignal, GateSignalStep } from "./gate-store.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { RoleStore } from "./role-store.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { WorkflowGate, VerifyStep } from "./workflow-store.js";
import type { ProjectConfigStore } from "./project-config-store.js";
import { getVerificationShell } from "./shell-util.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import { generateTeamName } from "./team-names.js";
import {
	substituteVars as _substituteVars,
	isTransientReviewError,
	isTransientQaError,
	matchExpectFailure,
	groupStepsByPhase,
	getSortedPhases,
	partitionOptionalSteps,
	buildStepCache,
	computeAllPassed,
	canSkipAllSteps,
	detectJsonValidationError,
} from "./verification-logic.js";
import { Semaphore } from "./semaphore.js";

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

/** In-flight verification state for REST bootstrapping */
export interface ActiveVerification {
	goalId: string;
	gateId: string;
	signalId: string;
	steps: Array<{ name: string; type: string; status: "running" | "passed" | "failed" | "skipped" | "waiting"; phase?: number; durationMs?: number; output?: string; startedAt: number; sessionId?: string }>;
	currentPhase?: number;
	overallStatus: "running" | "passed" | "failed" | "cancelled";
	startedAt: number;
	cancelled?: boolean;
}

export class VerificationHarness {
	private notifyTeamLeadFn?: (goalId: string, message: string) => void;
	private activeVerifications = new Map<string, ActiveVerification>();
	private readonly _persistPath: string;
	private projectContextManager: ProjectContextManager | null;

	/** Limits concurrent command steps (type-check, tests) across all goals. */
	private commandSemaphore = new Semaphore(4);
	/** Limits concurrent LLM review / QA sessions across all goals. */
	private reviewSemaphore = new Semaphore(6);

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
	 * Returns true if at least one running step has a live session.
	 * Returns false (zombie) if no running sessions exist — safe to auto-cancel.
	 * Also returns true if steps are still in "waiting" state (not yet started),
	 * to avoid premature cancellation during phase transitions.
	 */
	areVerificationSessionsAlive(signalId: string): boolean {
		const active = this.activeVerifications.get(signalId);
		if (!active) return false;
		// If any step is still waiting to start, the verification is not a zombie
		if (active.steps.some(s => s.status === "waiting")) return true;
		for (const step of active.steps) {
			if (step.status === "running") {
				// Command steps have no sessionId — if status is running, the process is alive
				if (!step.sessionId) return true;
				// LLM/agent steps — check if session is still alive
				const session = this.sessionManager?.getSession(step.sessionId);
				if (session) return true;
			}
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
				// Mark as failed and update gate
				this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
					status: "failed",
					steps: [{ name: "Resume Error", type: "command", passed: false, output: `Failed to resume after restart: ${(err as Error).message}`, duration_ms: 0 }],
				});
				this.resolveGateStore(v.goalId).updateGateStatus(v.goalId, v.gateId, "failed");
				this.broadcastFn(v.goalId, {
					type: "gate_verification_complete",
					goalId: v.goalId, gateId: v.gateId, signalId: v.signalId, status: "failed",
				});
				this.broadcastFn(v.goalId, {
					type: "gate_status_changed",
					goalId: v.goalId, gateId: v.gateId, status: "failed",
				});
				this.notifyTeamLead(v.goalId, v.gateId, "failed");
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
	private _gatherRerunContext(goalId: string, gateId: string, signalId: string): {
		signal: GateSignal;
		cwd: string;
		builtinVars: Record<string, string>;
		goalSpec?: string;
		allGateStates: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>;
	} | null {
		const goal = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
		if (!goal) return null;

		const gateStore = this.resolveGateStore(goalId);
		const gateState = gateStore.getGate(goalId, gateId);
		if (!gateState) return null;

		const signal = gateState.signals.find(s => s.id === signalId);
		if (!signal) return null;

		const cwd = goal.worktreePath || goal.cwd;
		const builtinVars: Record<string, string> = {
			branch: goal.branch || "HEAD",
			master: "master",
			cwd,
			goal_spec: goal.spec || "",
			commit: signal.commitSha || "HEAD",
		};

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

		return { signal, cwd, builtinVars, goalSpec: goal.spec, allGateStates };
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

			// Step was running — try to resume from the existing session first
			let resumeResult = await this._tryResumeFromSession(v, step);

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

		const ctx = this._gatherRerunContext(goalId, gateId, signalId);
		if (!ctx) {
			console.warn(`[verification] Cannot re-run "${stepName}" — goal/signal context unavailable`);
			return null;
		}

		const startedAt = Date.now();
		const maxAttempts = 3;
		let result: { passed: boolean; output: string; sessionId?: string } = { passed: false, output: "Re-run failed." };

		// Resolve project vars and substitute the prompt template
		const projectVars: Record<string, string> = this.projectConfigStore
			? this.projectConfigStore.getWithDefaults()
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

		const ctx = this._gatherRerunContext(goalId, gateId, signalId);
		if (!ctx) {
			console.warn(`[verification] Cannot re-run QA "${stepName}" — goal/signal context unavailable`);
			return null;
		}

		const startedAt = Date.now();
		const projectVars = this.projectConfigStore?.getWithDefaults() ?? {};
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
				{ name: stepDef.name, prompt, timeout: stepDef.timeout, role: stepDef.role },
				ctx.cwd, goalId, ctx.builtinVars,
				ctx.signal.content, ctx.signal.metadata, ctx.goalSpec, ctx.allGateStates,
			);
			if (result.passed || !isTransientQaError(result.output) || attempt === maxAttempts) break;
			await new Promise(r => setTimeout(r, 5000));
		}

		return { name: stepName, type: "agent-qa", passed: result.passed, output: result.output, duration_ms: Date.now() - startedAt };
	}

	private readonly _stateDir: string;

	constructor(
		stateDir: string,
		/** @deprecated Resolve per-goal via projectContextManager instead. */
		private gateStore: GateStore | undefined,
		private broadcastFn: (goalId: string, event: any) => void,
		private roleStore: RoleStore,
		private preferencesStore?: PreferencesStore,
		private sessionManager?: import("./session-manager.js").SessionManager,
		private teamManager?: import("./team-manager.js").TeamManager,
		private projectConfigStore?: ProjectConfigStore,
		projectContextManager?: ProjectContextManager,
	) {
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
			const builtinVars: Record<string, string> = {
				branch: goalBranch || "HEAD",
				master: primaryBranch || "master",
				cwd,
				goal_spec: goalSpec || "",
				commit: signal.commitSha || "HEAD",
			};

			// Project config — resolved via {{project.key}}
			const projectVars: Record<string, string> = this.projectConfigStore
				? this.projectConfigStore.getWithDefaults()
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
							const cmd = this.substituteVars(step.run || "", builtinVars, projectVars, agentVars, allGateStates);
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
							let commandCwd = cwd;
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
						} else if (step.type === "agent-qa") {
							// agent-qa — spawn a one-shot test-engineer sub-agent
							if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
								result = { passed: true, output: "Agent QA skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								if (this.reviewSemaphore.available === 0) {
									console.log(`[verification] Step "${step.name}" waiting for semaphore slot...`);
								}
								await this.reviewSemaphore.acquire();
								try {
									const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
									const maxAttempts = 3;
									for (let attempt = 1; attempt <= maxAttempts; attempt++) {
										if (active.cancelled) break;
										const qaResult = await this.runAgentQaStep(
											{ name: step.name, prompt, timeout: step.timeout, role: step.role },
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
								} finally {
									this.reviewSemaphore.release();
								}
							}
						} else {
							// llm-review — spawn a one-shot reviewer sub-agent
							if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
								result = { passed: true, output: "LLM review skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								if (this.reviewSemaphore.available === 0) {
									console.log(`[verification] Step "${step.name}" waiting for semaphore slot...`);
								}
								await this.reviewSemaphore.acquire();
								try {
									const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
									const maxAttempts = 3;
									for (let attempt = 1; attempt <= maxAttempts; attempt++) {
										if (active.cancelled) break;
										result = await this.runLlmReviewStep(
											{ name: step.name, prompt, timeout: step.timeout, role: step.role },
											cwd, builtinVars,
											signal.content, signal.metadata,
											goalSpec, allGateStates, signal.goalId, stepSessionId,
										);
										const isTransient = isTransientReviewError(result.output);
										if (result.passed || !isTransient || attempt === maxAttempts) break;
										const delayMs = 2000 * Math.pow(2, attempt - 1);
										console.log(`[verification] LLM review "${step.name}" failed transiently (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
										await new Promise(r => setTimeout(r, delayMs));
									}
								} finally {
									this.reviewSemaphore.release();
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
	): Promise<{ passed: boolean; output: string; sessionId?: string }> {
		const roleName = step.role || "reviewer";
		const role = this.roleStore.get(roleName) || this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: `LLM review failed: '${roleName}' role not found in role store.`, sessionId };
		}

		const timeoutMs = (step.timeout || 600) * 1000;

		// Build the combined prompt sections (shared between session-based and direct-RpcBridge paths)
		const combinedPrompt = this.buildReviewPrompt(role, step, cwd, builtinVars, signalContent, signalMetadata, goalSpec, allGateStates);

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
		return this.runLlmReviewDirect(step, cwd, role, combinedPrompt, kickoff, timeoutMs);
	}

	/**
	 * Build the combined system prompt for a review step.
	 */
	private buildReviewPrompt(
		role: { promptTemplate: string; name?: string },
		step: { name: string; prompt?: string },
		cwd: string,
		builtinVars: Record<string, string>,
		signalContent?: string,
		signalMetadata?: Record<string, string>,
		goalSpec?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
	): string {
		let rolePrompt = role.promptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, builtinVars.branch || "HEAD")
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

		const contextLines: string[] = [
			"\n## Working Directory & Branch Setup",
			"",
			"**Your working directory is already set up correctly.** It is the goal's worktree,",
			`checked out on branch \`${builtinVars.branch || "HEAD"}\` at commit \`${builtinVars.commit || "HEAD"}\`.`,
			"",
			"**Do NOT run `git checkout`, `git pull`, `git fetch`, or any command that modifies the working tree.**",
			"Other reviewers may be reading from this directory concurrently. Mutating it causes stale reads.",
			"",
			"To see what changed (read-only, safe for concurrent use):",
			`- \`git diff --stat ${builtinVars.master || "master"}...HEAD -- . ':!package-lock.json'\` — summary of which files changed`,
			`- \`git diff ${builtinVars.master || "master"}...HEAD -M -- . ':!package-lock.json'\` — branch diff with rename detection (collapses pure renames)`,
			`- For large diffs, review individual files with \`read\` instead of loading the full diff into context`,
			`- \`git log --oneline ${builtinVars.master || "master"}..HEAD\` — commits on this branch`,
			"- Use `read` to view files directly — they are already at the correct version",
			"",
			"## Signal Context",
			`- Branch: ${builtinVars.branch || "HEAD"}`,
			`- Commit: ${builtinVars.commit || "HEAD"}`,
			`- Primary branch: ${builtinVars.master || "master"}`,
			`- Working directory: ${cwd}`,
		];
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
			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName,
				sandboxed: isSandboxed,
				sessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
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

			// Override model if default.reviewModel preference is set
			if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				if (reviewModelPref) {
					const slash = reviewModelPref.indexOf("/");
					if (slash > 0 && slash < reviewModelPref.length - 1) {
						const provider = reviewModelPref.slice(0, slash);
						const modelId = reviewModelPref.slice(slash + 1);
						try {
							await session.rpcClient.setModel(provider, modelId);
							this.sessionManager?.persistSessionModel(sessionId, provider, modelId);
							console.log(`[verification] Set review model "${reviewModelPref}" for ${sessionId}`);
						} catch (err) {
							console.warn(`[verification] Failed to set review model "${reviewModelPref}", using default:`, err);
						}
					} else {
						console.warn(`[verification] Malformed default.reviewModel preference: "${reviewModelPref}", ignoring`);
					}
				}
			}

			// Apply review thinking level (defaults to "off" when not configured,
			// matching the Settings page display default for review agents)
			{
				const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
				const level = (reviewThinking && ["off", "minimal", "low", "medium", "high"].includes(reviewThinking))
					? reviewThinking : "off";
				try {
					await session.rpcClient.setThinkingLevel(level);
					console.log(`[verification] Set review thinking level "${level}" for ${sessionId}`);
				} catch (err) {
					console.warn(`[verification] Failed to set review thinking level:`, err);
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
	 * Spawn a one-shot test-engineer sub-agent to perform QA testing.
	 * Similar to runLlmReviewViaSession() but with test-engineer role and QA-specific prompt.
	 */
	private async runAgentQaStep(
		step: { name: string; prompt?: string; timeout?: number; role?: string },
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

		// Compute timeout: qa_max_duration_minutes + 5 min buffer
		const projectVars = this.projectConfigStore?.getWithDefaults() ?? {};
		const qaMinutes = parseInt(projectVars["qa_max_duration_minutes"] || "10", 10) || 10;
		const qaTimeoutMs = (qaMinutes + 5) * 60 * 1000;
		const timeoutMs = Math.max(qaTimeoutMs, (step.timeout || 900) * 1000);

		// Build kickoff message
		const kickoff = [
			`Perform QA testing for: "${step.name}".`,
			`Your working directory is on branch \`${builtinVars.branch}\` at commit \`${builtinVars.commit || "HEAD"}\`.`,
			"",
			step.prompt || "",
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
			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName: qaRoleName,
				sandboxed: qaIsSandboxed,
				sessionId: qaSessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
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

			// Override model if default.reviewModel preference is set
			if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				if (reviewModelPref) {
					const slash = reviewModelPref.indexOf("/");
					if (slash > 0 && slash < reviewModelPref.length - 1) {
						const provider = reviewModelPref.slice(0, slash);
						const modelId = reviewModelPref.slice(slash + 1);
						try {
							await session.rpcClient.setModel(provider, modelId);
							this.sessionManager?.persistSessionModel(qaSessionId, provider, modelId);
							console.log(`[verification] Set QA model "${reviewModelPref}" for ${qaSessionId}`);
						} catch (err) {
							console.warn(`[verification] Failed to set QA model "${reviewModelPref}", using default:`, err);
						}
					}
				}
			}

			// Apply thinking level
			{
				const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
				const level = (reviewThinking && ["off", "minimal", "low", "medium", "high"].includes(reviewThinking))
					? reviewThinking : "off";
				try {
					await session.rpcClient.setThinkingLevel(level);
				} catch (err) {
					console.warn(`[verification] Failed to set QA thinking level:`, err);
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

			// Override model if default.reviewModel preference is set
			if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				if (reviewModelPref) {
					const slash = reviewModelPref.indexOf("/");
					if (slash > 0 && slash < reviewModelPref.length - 1) {
						const provider = reviewModelPref.slice(0, slash);
						const modelId = reviewModelPref.slice(slash + 1);
						try {
							await rpc.setModel(provider, modelId);
							console.log(`[verification] Set review model "${reviewModelPref}" for ${subSessionId}`);
						} catch (err) {
							console.warn(`[verification] Failed to set review model "${reviewModelPref}", using default:`, err);
						}
					} else {
						console.warn(`[verification] Malformed default.reviewModel preference: "${reviewModelPref}", ignoring`);
					}
				}
			}

			// Apply review thinking level (defaults to "off" when not configured,
			// matching the Settings page display default for review agents)
			{
				const reviewThinking = this.preferencesStore?.get("default.reviewThinkingLevel") as string | undefined;
				const level = (reviewThinking && ["off", "minimal", "low", "medium", "high"].includes(reviewThinking))
					? reviewThinking : "off";
				try {
					await rpc.setThinkingLevel(level);
					console.log(`[verification] Set review thinking level "${level}" for ${subSessionId}`);
				} catch (err) {
					console.warn(`[verification] Failed to set review thinking level:`, err);
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
			//
			// On Windows, Git Bash with --login is ~3.7s per spawn (sources /etc/profile,
			// ~/.bash_profile). Plain bash is ~150ms. 25× difference.
			//
			// Heuristic: commands that reference common tool names get --login.
			// Everything else (echo, test, [], cat, grep, basic shell operators)
			// runs in plain shell. This preserves backward compat for real workflows
			// while making test workflows 25× faster.
			const { shell: shellBin, args: shellArgs } = getVerificationShell(command);
			// For sandboxed goals, run the command inside the project container
			const child = containerId
				? spawn("docker", ["exec", "-w", normalizedCwd, containerId, "/bin/sh", "-c", command], {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: timeoutSec * 1000,
					env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
				})
				: spawn(shellBin, [...shellArgs, command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
					...(process.platform === "win32" ? { windowsHide: true } : {}),
				});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => {
				const text = d.toString();
				stdout += text;
				if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024);
				if (streamCtx) {
					this.broadcastFn(streamCtx.goalId, {
						type: "gate_verification_step_output",
						goalId: streamCtx.goalId,
						gateId: streamCtx.gateId,
						signalId: streamCtx.signalId,
						stepIndex: streamCtx.stepIndex,
						stream: "stdout" as const,
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
			});
			child.stderr.on("data", (d: Buffer) => {
				const text = d.toString();
				stderr += text;
				if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
				if (streamCtx) {
					this.broadcastFn(streamCtx.goalId, {
						type: "gate_verification_step_output",
						goalId: streamCtx.goalId,
						gateId: streamCtx.gateId,
						signalId: streamCtx.signalId,
						stepIndex: streamCtx.stepIndex,
						stream: "stderr" as const,
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
			});
			child.on("close", (code) => {
				const output = (stdout + "\n" + stderr).trim().slice(-5000);
				if (expectFailure) {
					resolve(matchExpectFailure(code, output, errorPattern));
					return;
				}
				resolve({ passed: code === 0, output: output || `exit code ${code}` });
			});
			child.on("error", (err) => {
				if (expectFailure && errorPattern) {
					try {
						const regex = new RegExp(errorPattern, 'i');
						resolve({ passed: regex.test(err.message), output: err.message });
					} catch {
						resolve({ passed: false, output: `Invalid error_pattern regex when handling spawn error: ${err.message}` });
					}
				} else {
					resolve({ passed: expectFailure, output: err.message });
				}
			});
		});
	}
}

