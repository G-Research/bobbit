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
import { GIT_BASH, getShellConfig } from "./shell-util.js";
import type { ProjectContextManager } from "./project-context-manager.js";

/** Extract pass/fail verdict from sub-agent output. Exported for unit testing. */
export function parseVerdict(output: string): boolean | null {
	const match = output.match(/<verdict>\s*(pass|fail)\s*<\/verdict>/i);
	if (!match) return null;
	return match[1].toLowerCase() === "pass";
}

/** Extract QA report HTML from agent output. Exported for unit testing. */
export function parseQaReport(output: string): string | null {
	const match = output.match(/<qa_report>([\s\S]*?)<\/qa_report>/i);
	return match ? match[1].trim() : null;
}

const VERDICT_FOLLOWUP_PROMPT = "Your review is complete but you did not include the required <verdict> tag. Based on your review findings above, respond with ONLY a <verdict>pass</verdict> or <verdict>fail</verdict> tag. Use <verdict>fail</verdict> if you found any critical or high severity issues, otherwise <verdict>pass</verdict>.";

/** Patterns that indicate a transient/infrastructure failure worth retrying. */
const TRANSIENT_ERROR_PATTERNS = [
	"timed out",
	"no <verdict> tag",
	"Agent process not running",
	"process exited",
	"Session lost during server restart",
	"ECONNRESET",
	"EPIPE",
	"spawn UNKNOWN",
	"socket hang up",
	"connect ECONNREFUSED",
];

/** Check if an LLM review error output matches a transient failure pattern. */
export function isTransientReviewError(output: string): boolean {
	return TRANSIENT_ERROR_PATTERNS.some(pattern => output.includes(pattern));
}

/** In-flight verification state for REST bootstrapping */
export interface ActiveVerification {
	goalId: string;
	gateId: string;
	signalId: string;
	steps: Array<{ name: string; type: string; status: "running" | "passed" | "failed" | "skipped"; phase?: number; durationMs?: number; output?: string; startedAt: number; sessionId?: string }>;
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

	/** Get all active (in-flight) verifications, optionally filtered by goalId */
	getActiveVerifications(goalId?: string): ActiveVerification[] {
		const all = [...this.activeVerifications.values()];
		return goalId ? all.filter(v => v.goalId === goalId) : all;
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
		const goal = this.sessionManager?.goalManager?.getGoal(goalId);
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
		const goal = this.sessionManager?.goalManager?.getGoal(goalId);
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
				resolvedSteps.push({
					name: step.name,
					type: step.type,
					passed: step.status === "passed",
					output: step.output || "",
					duration_ms: step.durationMs || 0,
				});
				continue;
			}

			// Step was running — try to resume from the existing session first
			let resumeResult = await this._tryResumeFromSession(v, step);

			// If resume failed with a transient error and this is an llm-review or agent-qa step,
			// re-run from scratch rather than giving up
			if (resumeResult && !resumeResult.passed && (step.type === "llm-review" || step.type === "agent-qa") && isTransientReviewError(resumeResult.output)) {
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

		// Wait for the agent to finish if it was mid-turn
		try {
			await this.sessionManager!.waitForIdle(step.sessionId, 180_000);
		} catch (err) {
			console.warn(`[verification] waitForIdle failed for resumed session ${step.sessionId}: ${(err as Error).message}`);
		}

		// Extract verdict from output
		let output = "";
		try { output = await this.sessionManager!.getSessionOutput(step.sessionId); } catch { /* fall through */ }

		let verdict = parseVerdict(output);
		if (verdict === null) {
			console.log(`[verification] No verdict in restored session ${step.sessionId}, sending follow-up...`);
			try {
				await session.rpcClient.prompt(VERDICT_FOLLOWUP_PROMPT);
				await this.sessionManager!.waitForIdle(step.sessionId, 120_000);
				output = await this.sessionManager!.getSessionOutput(step.sessionId);
				verdict = parseVerdict(output);
			} catch (err) {
				output = output || `Follow-up failed: ${(err as Error).message}`;
			}
		}

		// Terminate and unregister reviewer session
		try { await this.sessionManager!.terminateSession(step.sessionId); } catch { /* ignore */ }
		if (this.teamManager) {
			try { await this.teamManager.unregisterReviewerSession(v.goalId, step.sessionId); } catch { /* ignore */ }
		}

		return {
			name: step.name, type: step.type,
			passed: verdict ?? false,
			output: output || "No <verdict> tag found after server restart and follow-up.",
			duration_ms: Date.now() - step.startedAt,
		};
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

		const maxAttempts = 3;
		let result: { passed: boolean; output: string; sessionId?: string; artifact?: any } = { passed: false, output: "Re-run failed." };
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			result = await this.runAgentQaStep(
				{ name: stepDef.name, prompt, timeout: stepDef.timeout, role: stepDef.role },
				ctx.cwd, goalId, ctx.builtinVars,
				ctx.signal.content, ctx.signal.metadata, ctx.goalSpec, ctx.allGateStates,
			);
			if (result.passed || !isTransientReviewError(result.output) || attempt === maxAttempts) break;
			await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
		}

		return { name: stepName, type: "agent-qa", passed: result.passed, output: result.output, duration_ms: Date.now() - startedAt };
	}

	private readonly _stateDir: string;

	constructor(
		stateDir: string,
		private gateStore: GateStore,
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
		}
		return this.gateStore;
	}

	/** Register a callback to notify the team lead agent when verification completes. */
	setTeamLeadNotifier(fn: (goalId: string, message: string) => void): void {
		this.notifyTeamLeadFn = fn;
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
			steps: steps.map(s => ({ name: s.name, type: s.type })),
		});

		// Track active verification for REST bootstrapping
		const active: ActiveVerification = {
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			steps: steps.map(s => ({ name: s.name, type: s.type, status: "running" as const, phase: s.phase ?? 0, startedAt: verificationStartedAt })),
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
			const cachedSteps = new Map<string, GateSignalStep>();
			if (signal.commitSha) {
				const gateState = this.resolveGateStore(signal.goalId).getGate(signal.goalId, signal.gateId);
				if (gateState) {
					for (const prev of gateState.signals) {
						if (prev.id === signal.id) continue;
						if (prev.commitSha !== signal.commitSha) continue;
						if (!prev.verification?.status || prev.verification.status === "running") continue;
						for (const s of prev.verification.steps) {
							if (s.passed && !cachedSteps.has(s.name)) {
								cachedSteps.set(s.name, s);
							}
						}
					}
				}
				if (cachedSteps.size > 0) {
					console.log(`[verification] Reusing ${cachedSteps.size} previously-passed step(s) for commit ${signal.commitSha.slice(0, 8)}: ${[...cachedSteps.keys()].join(", ")}`);
				}
			}

			// --- Optional step skipping ---
			// Look up enabledOptionalSteps from the goal
			const goalForOptional = this.sessionManager?.goalManager?.getGoal(signal.goalId)
				?? (this.projectContextManager?.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId));
			const enabledOptional = goalForOptional?.enabledOptionalSteps ?? [];

			// Partition steps into active and skipped
			const activeSteps: typeof steps = [];
			const skippedIndices: number[] = [];
			steps.forEach((step, index) => {
				if (step.optional && !enabledOptional.includes(step.name)) {
					skippedIndices.push(index);
				} else {
					activeSteps.push(step);
				}
			});

			// Immediately resolve skipped optional steps
			for (const idx of skippedIndices) {
				const s = steps[idx];
				const skipResult: GateSignalStep = {
					name: s.name, type: s.type as GateSignalStep["type"],
					passed: true, output: "Skipped — not enabled for this goal", duration_ms: 0,
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
			if (cachedSteps.size >= activeSteps.length && activeSteps.every(s => cachedSteps.has(s.name))) {
				console.log(`[verification] All ${activeSteps.length} active step(s) cached for commit ${signal.commitSha!.slice(0, 8)} — skipping agent spawn`);
				const results: GateSignalStep[] = steps.map((s, i) => {
					if (allResults[i]) return allResults[i]!; // skipped optional step
					const cached = cachedSteps.get(s.name)!;
					return { ...cached, output: `[cached from prior signal] ${cached.output}` };
				});
				const allPassed = results.every(r => r.passed);
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
			const phaseGroups = new Map<number, Array<{ step: VerifyStep; index: number }>>();
			activeSteps.forEach((step) => {
				const originalIndex = steps.indexOf(step);
				const phase = step.phase ?? 0;
				if (!phaseGroups.has(phase)) phaseGroups.set(phase, []);
				phaseGroups.get(phase)!.push({ step, index: originalIndex });
			});
			const sortedPhases = [...phaseGroups.keys()].sort((a, b) => a - b);

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

				// Broadcast phase started
				active.currentPhase = phase;
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

							result = await this.runCommandStep(cmd, cwd, step.timeout || 300, expectFailure, {
								goalId: signal.goalId, gateId: signal.gateId,
								signalId: signal.id, stepIndex: index,
							}, errorPattern);
						} else if (step.type === "agent-qa") {
							// agent-qa — spawn a one-shot test-engineer sub-agent
							if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
								result = { passed: true, output: "Agent QA skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								const maxAttempts = 3;
								for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
									const isTransient = isTransientReviewError(qaResult.output);
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

			const allPassed = results.every(r => r.passed);
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
			`Perform a code review for the gate verification step: "${step.name}".`,
			"",
			`Your working directory is already on branch \`${builtinVars.branch}\` at commit \`${builtinVars.commit || "HEAD"}\`. Do NOT run git checkout/pull/fetch. Just read files and diffs directly.`,
			"",
			step.prompt || "",
			"",
			"## Required Output Format",
			"",
			"Produce your review, then end with a <verdict> tag. Example:",
			"",
			"```",
			"## Summary",
			"Brief overview of what was reviewed and the outcome.",
			"",
			"## Findings",
			"[critical] file.ts:line — Description",
			"[high] file.ts:line — Description",
			"[medium] file.ts:line — Description",
			"[low] file.ts:line — Description",
			"",
			"## Verdict",
			"Explanation of pass/fail decision.",
			"",
			"<verdict>pass</verdict>",
			"```",
			"",
			"## Rules",
			"- **<verdict>fail</verdict>** if any critical or high severity findings exist",
			"- **<verdict>pass</verdict>** if no critical or high severity findings",
			"- **You MUST include exactly one `<verdict>pass</verdict>` or `<verdict>fail</verdict>` tag — if you omit it, the review fails automatically regardless of your findings**",
			"- **Do NOT call `gate_signal`.** The verification system handles gate signaling automatically based on your `<verdict>` tag. Just produce your review findings and verdict, then stop.",
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
			"\n## CRITICAL: Verdict Tag Requirement",
			"",
			"Every review you produce MUST end with exactly one `<verdict>` XML tag:",
			"- `<verdict>pass</verdict>` — if no critical or high severity findings exist",
			"- `<verdict>fail</verdict>` — if any critical or high severity findings exist",
			"",
			"If you omit this tag, the verification system cannot parse your output and the review FAILS automatically.",
			"This is the single most important formatting requirement. Never omit it.",
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
			`- \`git diff ${builtinVars.master || "master"}...HEAD -- . ':!package-lock.json'\` — branch diff vs ${builtinVars.master || "master"}`,
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
		let sessionId: string | undefined;
		try {
			// Create session via SessionManager — no worktree created (direct createSession, not spawnRole)
			const roleName = role.name || step.role || "reviewer";
			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName,
				sandboxed: (goalId
				? (this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId)?.sandboxed
					?? this.sessionManager!.goalManager.getGoal(goalId)?.sandboxed)
				: undefined) ?? this.sessionManager!.isSandboxEnabled,
				sessionId: preGeneratedSessionId,
			});
			sessionId = session.id;

			// Set title and metadata
			const roleLabel = role.name ? (role.name.charAt(0).toUpperCase() + role.name.slice(1).replace(/-/g, " ")) : "Reviewer";
			this.sessionManager!.setTitle(sessionId, `${roleLabel}: ${step.name}`);
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

			// Send kickoff prompt and wait for idle
			await session.rpcClient.prompt(kickoff);
			await this.sessionManager!.waitForIdle(sessionId, timeoutMs);

			// Get output from the session
			const output = await this.sessionManager!.getSessionOutput(sessionId);

			const verdict = parseVerdict(output);
			if (verdict === null) {
				// Follow-up: ask the agent to emit the verdict tag
				console.log(`[verification] No verdict tag found, sending follow-up prompt to ${sessionId}`);
				await session.rpcClient.prompt(VERDICT_FOLLOWUP_PROMPT);
				await this.sessionManager!.waitForIdle(sessionId!, timeoutMs);
				const fullOutput = await this.sessionManager!.getSessionOutput(sessionId!);
				const retryVerdict = parseVerdict(fullOutput);
				if (retryVerdict === null) {
					return { passed: false, output: fullOutput || "LLM review failed: no <verdict> tag found in sub-agent output.", sessionId };
				}
				return { passed: retryVerdict, output: fullOutput, sessionId };
			}

			return { passed: verdict, output, sessionId };
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
			// Always terminate and unregister, even on error/timeout
			if (sessionId) {
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

		// Build system prompt (dedicated QA prompt, not buildReviewPrompt)
		const sections: string[] = ["You are a QA test engineer performing automated testing."];
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
			"## Required Output Format",
			"After completing testing, you MUST emit:",
			"1. A <verdict>pass</verdict> or <verdict>fail</verdict> tag",
			"2. A <qa_report>...your HTML report...</qa_report> tag wrapping the full HTML report",
			"",
			"The verdict and report tags are REQUIRED. The verification system parses them automatically.",
		].join("\n");

		let qaSessionId: string | undefined;
		try {
			// Create session via SessionManager
			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName: "test-engineer",
				sandboxed: (goalId
					? (this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId)?.sandboxed
						?? this.sessionManager!.goalManager.getGoal(goalId)?.sandboxed)
					: undefined) ?? this.sessionManager!.isSandboxEnabled,
				sessionId,
			});
			qaSessionId = session.id;

			// Set title and metadata
			this.sessionManager!.setTitle(qaSessionId, `QA: ${step.name}`);
			this.sessionManager!.updateSessionMeta(qaSessionId, {
				role: "test-engineer",
				teamGoalId: goalId,
				accessory: "test-tube",
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

			// Send kickoff prompt and wait for idle
			await session.rpcClient.prompt(kickoff);
			await this.sessionManager!.waitForIdle(qaSessionId, timeoutMs);

			// Get output from the session
			const output = await this.sessionManager!.getSessionOutput(qaSessionId);

			let verdict = parseVerdict(output);
			if (verdict === null) {
				// Follow-up: ask the agent to emit the verdict tag
				console.log(`[verification] No verdict tag from QA agent, sending follow-up to ${qaSessionId}`);
				await session.rpcClient.prompt(VERDICT_FOLLOWUP_PROMPT);
				await this.sessionManager!.waitForIdle(qaSessionId, timeoutMs);
				const fullOutput = await this.sessionManager!.getSessionOutput(qaSessionId);
				verdict = parseVerdict(fullOutput);
				if (verdict === null) {
					const reportHtml = parseQaReport(fullOutput);
					const artifact = reportHtml ? { content: reportHtml.length > QA_MAX_ARTIFACT ? reportHtml.slice(0, QA_MAX_ARTIFACT) : reportHtml, contentType: "text/html" } : undefined;
					return { passed: false, output: fullOutput || "Agent QA failed: no <verdict> tag found.", sessionId: qaSessionId, artifact };
				}
				const reportHtml = parseQaReport(fullOutput);
				const artifact = reportHtml ? { content: reportHtml.length > QA_MAX_ARTIFACT ? reportHtml.slice(0, QA_MAX_ARTIFACT) : reportHtml, contentType: "text/html" } : undefined;
				return { passed: verdict, output: fullOutput, sessionId: qaSessionId, artifact };
			}

			const reportHtml = parseQaReport(output);
			const artifact = reportHtml ? { content: reportHtml.length > QA_MAX_ARTIFACT ? reportHtml.slice(0, QA_MAX_ARTIFACT) : reportHtml, contentType: "text/html" } : undefined;
			return { passed: verdict, output, sessionId: qaSessionId, artifact };
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
			if (qaSessionId) {
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
			args: allowedTools.length > 0 ? ["--tools", allowedTools.join(",")] : [],
		};
		if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

		const rpc = new RpcBridge(bridgeOptions);
		let unregisterSession: (() => void) | undefined;

		try {
			await rpc.start();

			// Register as a viewable session so users can watch the review live
			if (this.sessionManager) {
				unregisterSession = this.sessionManager.registerExternalSession(subSessionId, rpc, {
					title: `LLM Review: ${step.name}`,
					cwd,
					role: "reviewer",
				});
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

			// Collect assistant text from streaming events as a fallback
			let streamedAssistantText = "";

			const completionPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`LLM review sub-agent timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs);

				const eventUnsub = rpc.onEvent((event: any) => {
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const msg = event.message;
						if (Array.isArray(msg.content)) {
							const text = msg.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
							if (text) streamedAssistantText = text;
						} else if (typeof msg.content === "string" && msg.content) {
							streamedAssistantText = msg.content;
						}
					}
					if (event.type === "agent_end") {
						clearTimeout(timer);
						eventUnsub();
						resolve();
					}
				});
			});

			await rpc.prompt(kickoff);
			await completionPromise;

			let output = "";
			try {
				const msgsResp = await rpc.getMessages();
				if (msgsResp.success && Array.isArray(msgsResp.data)) {
					output = extractLastAssistantOutput(msgsResp.data);
				}
			} catch {
				// Non-fatal
			}
			if (!output && streamedAssistantText) {
				output = streamedAssistantText;
			}

			const verdict = parseVerdict(output);
			if (verdict === null) {
				// Follow-up: ask the agent to emit the verdict tag
				console.log(`[verification] No verdict tag found, sending follow-up prompt to ${subSessionId}`);

				const followupPromise = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						reject(new Error(`Follow-up timed out after ${timeoutMs / 1000}s`));
					}, timeoutMs);
					const eventUnsub = rpc.onEvent((event: any) => {
						if (event.type === "agent_end") {
							clearTimeout(timer);
							eventUnsub();
							resolve();
						}
					});
				});

				await rpc.prompt(VERDICT_FOLLOWUP_PROMPT);
				await followupPromise;

				let fullOutput = "";
				try {
					const msgsResp = await rpc.getMessages();
					if (msgsResp.success && Array.isArray(msgsResp.data)) {
						fullOutput = extractAllAssistantOutput(msgsResp.data);
					}
				} catch {}
				if (!fullOutput) fullOutput = output; // fallback to original

				const retryVerdict = parseVerdict(fullOutput);
				if (retryVerdict === null) {
					return { passed: false, output: fullOutput || "LLM review failed: no <verdict> tag found in sub-agent output.", sessionId: subSessionId };
				}
				return { passed: retryVerdict, output: fullOutput, sessionId: subSessionId };
			}

			return { passed: verdict, output, sessionId: subSessionId };
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
		return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
			const trimmed = key.trim();

			// {{project.key}} — project config
			if (trimmed.startsWith("project.")) {
				const field = trimmed.slice("project.".length);
				if (field in projectVars) return projectVars[field];
				return match;
			}

			// {{agent.key}} — signal metadata from the agent
			if (trimmed.startsWith("agent.")) {
				const field = trimmed.slice("agent.".length);
				if (field in agentVars) return agentVars[field];
				return match;
			}

			// {{gate_id.meta.key}} — upstream gate metadata
			const metaMatch = trimmed.match(/^([^.]+)\.meta\.(.+)$/);
			if (metaMatch && allGateStates) {
				const [, gateId, field] = metaMatch;
				const gateState = allGateStates.get(gateId);
				if (gateState?.metadata && field in gateState.metadata) {
					return gateState.metadata[field];
				}
				return match;
			}

			// Bare variables — builtins only (branch, master, cwd, goal_spec)
			if (trimmed in builtinVars) return builtinVars[trimmed];

			return match; // Leave unresolved
		});
	}

	private runCommandStep(
		command: string,
		cwd: string,
		timeoutSec: number,
		expectFailure: boolean,
		streamCtx?: { goalId: string; gateId: string; signalId: string; stepIndex: number },
		errorPattern?: string,
	): Promise<{ passed: boolean; output: string }> {
		return new Promise((resolve) => {
			const normalizedCwd = cwd.replace(/\\/g, "/");
			// Use the shared shell config — prefers Git Bash on Windows (login shell
			// for full PATH) so bash syntax works, falls back to cmd.exe / /bin/sh.
			const { shell: shellBin, args: shellArgs } = process.platform === "win32" && GIT_BASH
				? { shell: GIT_BASH, args: ["--login", "-c"] }
				: getShellConfig();
			const child = spawn(shellBin, [...shellArgs, command], {
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
				const exitedNonZero = code !== 0;
				if (expectFailure) {
					if (!exitedNonZero) {
						resolve({ passed: false, output: `Command succeeded (exit code 0) but was expected to fail.\n\n${output}` });
					} else if (!errorPattern) {
						resolve({ passed: false, output: `Command failed as expected (exit code ${code}), but no error_pattern metadata was provided. Gates with expect: failure verification require error_pattern metadata containing a regex that matches the expected error output.\n\nActual output (first 500 chars):\n${(output || '').slice(0, 500)}` });
					} else {
						try {
							const regex = new RegExp(errorPattern, 'i');
							if (regex.test(output)) {
								resolve({ passed: true, output: output || `exit code ${code}` });
							} else {
								resolve({ passed: false, output: `Command failed (exit code ${code}) but output did not match expected error pattern.\n\nExpected pattern: /${errorPattern}/i\n\nActual output (first 500 chars):\n${(output || '').slice(0, 500)}` });
							}
						} catch (regexErr: any) {
							resolve({ passed: false, output: `Invalid error_pattern regex: ${regexErr.message}\n\nPattern was: ${errorPattern}` });
						}
					}
					return;
				}
				resolve({ passed: !exitedNonZero, output: output || `exit code ${code}` });
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

/**
 * Extract ALL assistant message text from agent messages (concatenated).
 * Used after follow-up prompts to find the verdict anywhere in the full conversation.
 */
function extractAllAssistantOutput(messages: any[]): string {
	return messages
		.filter((m: any) => m?.role === "assistant")
		.map((m: any) => {
			if (Array.isArray(m.content)) {
				return m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			}
			return typeof m.content === "string" ? m.content : "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Extract the last assistant message text from agent messages.
 */
function extractLastAssistantOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;

		const text = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: typeof msg.content === "string" ? msg.content : "";

		if (text) return text;
	}
	return "";
}
