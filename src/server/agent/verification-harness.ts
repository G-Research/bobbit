import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { statSync } from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { GateStore, GateSignal, GateSignalStep } from "./gate-store.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { RoleStore } from "./role-store.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { WorkflowGate, Workflow } from "./workflow-store.js";

/** Resolve Git Bash path on Windows for commands needing Unix tools. */
function findGitBash(): string | null {
	if (process.platform !== "win32") return null;
	const candidates = [
		"C:/Program Files/Git/bin/bash.exe",
		"C:/Program Files/Git/usr/bin/bash.exe",
		"C:/Program Files (x86)/Git/bin/bash.exe",
	];
	try {
		const gitExe = execSync("where.exe git", { encoding: "utf-8", shell: process.env.ComSpec || "cmd.exe" }).split("\n")[0].trim();
		if (gitExe) {
			let dir = path.dirname(gitExe);
			for (let i = 0; i < 4; i++) {
				candidates.unshift(path.join(dir, "bin", "bash.exe").replace(/\\/g, "/"));
				candidates.unshift(path.join(dir, "usr", "bin", "bash.exe").replace(/\\/g, "/"));
				dir = path.dirname(dir);
			}
		}
	} catch {}
	for (const c of candidates) {
		try { statSync(c); return c; } catch {}
	}
	return null;
}

const GIT_BASH = findGitBash();

/** Extract pass/fail verdict from sub-agent output. Exported for unit testing. */
export function parseVerdict(output: string): boolean | null {
	const match = output.match(/<verdict>\s*(pass|fail)\s*<\/verdict>/i);
	if (!match) return null;
	return match[1].toLowerCase() === "pass";
}

/** In-flight verification state for REST bootstrapping */
export interface ActiveVerification {
	goalId: string;
	gateId: string;
	signalId: string;
	steps: Array<{ name: string; type: string; status: "running" | "passed" | "failed"; durationMs?: number; output?: string; startedAt: number }>;
	overallStatus: "running" | "passed" | "failed";
	startedAt: number;
}

export class VerificationHarness {
	private notifyTeamLeadFn?: (goalId: string, message: string) => void;
	private activeVerifications = new Map<string, ActiveVerification>();

	/** Get all active (in-flight) verifications, optionally filtered by goalId */
	getActiveVerifications(goalId?: string): ActiveVerification[] {
		const all = [...this.activeVerifications.values()];
		return goalId ? all.filter(v => v.goalId === goalId) : all;
	}

	constructor(
		private gateStore: GateStore,
		private broadcastFn: (goalId: string, event: any) => void,
		private roleStore: RoleStore,
		private preferencesStore?: PreferencesStore,
		private sessionManager?: import("./session-manager.js").SessionManager,
		private teamManager?: import("./team-manager.js").TeamManager,
	) {}

	/** Register a callback to notify the team lead agent when verification completes. */
	setTeamLeadNotifier(fn: (goalId: string, message: string) => void): void {
		this.notifyTeamLeadFn = fn;
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
			this.gateStore.updateSignalVerification(signal.id, { status: "passed", steps: [] });
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, "passed");
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
		this.broadcastFn(signal.goalId, {
			type: "gate_verification_started",
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			steps: steps.map(s => ({ name: s.name, type: s.type })),
		});

		// Track active verification for REST bootstrapping
		const active: ActiveVerification = {
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			steps: steps.map(s => ({ name: s.name, type: s.type, status: "running" as const, startedAt: Date.now() })),
			overallStatus: "running",
			startedAt: Date.now(),
		};
		this.activeVerifications.set(signal.id, active);

		try {
			const builtinVars: Record<string, string> = {
				branch: goalBranch || "HEAD",
				master: primaryBranch || "master",
				cwd,
				goal_spec: goalSpec || "",
			};

			// Also include the current signal's metadata as bare variables
			if (signal.metadata) {
				for (const [k, v] of Object.entries(signal.metadata)) {
					builtinVars[k] = v;
				}
			}

			// Build cache of previously-passed step results for the same commit SHA.
			// This avoids re-running expensive LLM reviews that already passed on a prior signal.
			const cachedSteps = new Map<string, GateSignalStep>();
			if (signal.commitSha) {
				const gateState = this.gateStore.getGate(signal.goalId, signal.gateId);
				if (gateState) {
					for (const prev of gateState.signals) {
						if (prev.id === signal.id) continue;
						if (prev.commitSha !== signal.commitSha) continue;
						if (prev.verification?.status !== "failed") continue;
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

			// Run all verification steps in parallel (skipping cached passes)
			const indexedResults = await Promise.all(
				steps.map(async (step, index) => {
					const cached = cachedSteps.get(step.name);
					if (cached) {
						const cachedResult = { ...cached, output: `[cached from prior signal] ${cached.output}` };
						this.broadcastFn(signal.goalId, {
							type: "gate_verification_step_complete",
							goalId: signal.goalId,
							gateId: signal.gateId,
							signalId: signal.id,
							stepIndex: index,
							stepName: step.name,
							status: cachedResult.passed ? "passed" : "failed",
							durationMs: cachedResult.duration_ms || 0,
							output: cachedResult.output,
						});
						const av = this.activeVerifications.get(signal.id);
						if (av && av.steps[index]) {
							av.steps[index] = { ...av.steps[index], status: cachedResult.passed ? "passed" : "failed", durationMs: cachedResult.duration_ms || 0, output: cachedResult.output };
						}
						return { index, stepResult: cachedResult };
					}

					let result: { passed: boolean; output: string } = { passed: false, output: "No verification result." };
					const startTime = Date.now();

					if (step.type === "command") {
						const cmd = this.substituteVars(step.run || "", builtinVars, allGateStates);
						const expectFailure = step.expect === "failure";
						result = await this.runCommandStep(cmd, cwd, step.timeout || 300, expectFailure);
					} else {
						// llm-review — spawn a one-shot reviewer sub-agent
						if (process.env.BOBBIT_LLM_REVIEW_SKIP) {
							// Fast path for test environments without API keys
							result = { passed: true, output: "LLM review skipped (BOBBIT_LLM_REVIEW_SKIP is set)." };
						} else {
							const prompt = this.substituteVars(step.prompt || "", builtinVars, allGateStates);
							const maxAttempts = 2;
							for (let attempt = 1; attempt <= maxAttempts; attempt++) {
								result = await this.runLlmReviewStep(
									{ name: step.name, prompt, timeout: step.timeout },
									cwd,
									builtinVars,
									signal.content,
									signal.metadata,
									goalSpec,
									allGateStates,
									signal.goalId,
								);
								const isTransient = result.output.includes("timed out") || result.output.includes("no <verdict> tag");
								if (result.passed || !isTransient || attempt === maxAttempts) break;
								console.log(`[verification] LLM review "${step.name}" failed transiently (attempt ${attempt}/${maxAttempts}), retrying...`);
							}
						}
					}

					const duration_ms = Date.now() - startTime;
					this.broadcastFn(signal.goalId, {
						type: "gate_verification_step_complete",
						goalId: signal.goalId,
						gateId: signal.gateId,
						signalId: signal.id,
						stepIndex: index,
						stepName: step.name,
						status: result.passed ? "passed" : "failed",
						durationMs: duration_ms,
						output: result.output || "",
					});
					const av = this.activeVerifications.get(signal.id);
					if (av && av.steps[index]) {
						av.steps[index] = { ...av.steps[index], status: result.passed ? "passed" : "failed", durationMs: duration_ms, output: result.output || "" };
					}
					return {
						index,
						stepResult: {
							name: step.name,
							type: step.type,
							passed: result.passed,
							output: result.output,
							duration_ms,
							expect: step.expect,
						},
					};
				})
			);

			// Sort by original YAML order for deterministic results
			const results = indexedResults
				.sort((a, b) => a.index - b.index)
				.map(r => r.stepResult);

			const allPassed = results.every(r => r.passed);
			const status = allPassed ? "passed" : "failed";

			this.gateStore.updateSignalVerification(signal.id, { status, steps: results });
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, status);
			this.activeVerifications.delete(signal.id);

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
			this.gateStore.updateSignalVerification(signal.id, {
				status: "failed",
				steps: [{ name: "Error", type: "command", passed: false, output: err.message, duration_ms: 0 }],
			});
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, "failed");
			this.activeVerifications.delete(signal.id);

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
		step: { name: string; prompt?: string; timeout?: number },
		cwd: string,
		builtinVars: Record<string, string>,
		signalContent?: string,
		signalMetadata?: Record<string, string>,
		goalSpec?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
		goalId?: string,
	): Promise<{ passed: boolean; output: string }> {
		const role = this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: "LLM review failed: 'reviewer' role not found in role store." };
		}

		const timeoutMs = (step.timeout || 600) * 1000;

		// Build the combined prompt sections (shared between session-based and direct-RpcBridge paths)
		const combinedPrompt = this.buildReviewPrompt(role, step, cwd, builtinVars, signalContent, signalMetadata, goalSpec, allGateStates);

		// Build the kickoff message (shared between both paths)
		const kickoff = [
			`Perform a code review for the gate verification step: "${step.name}".`,
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
		].join("\n");

		// ── Session-based path (visible in UI) ──
		if (this.sessionManager && goalId) {
			return this.runLlmReviewViaSession(step, cwd, goalId, role, combinedPrompt, kickoff, timeoutMs);
		}

		// ── Legacy direct-RpcBridge path (fallback when SessionManager unavailable) ──
		return this.runLlmReviewDirect(step, cwd, role, combinedPrompt, kickoff, timeoutMs);
	}

	/**
	 * Build the combined system prompt for a review step.
	 */
	private buildReviewPrompt(
		role: { promptTemplate: string; allowedTools: string[] },
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
			.replace(/\{\{AGENT_ID\}\}/g, "reviewer");

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
			"\n## Signal Context",
			`- Branch: ${builtinVars.branch || "HEAD"}`,
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
		step: { name: string; prompt?: string; timeout?: number },
		cwd: string,
		goalId: string,
		role: { promptTemplate: string; allowedTools: string[]; accessory?: string },
		combinedPrompt: string,
		kickoff: string,
		timeoutMs: number,
	): Promise<{ passed: boolean; output: string }> {
		let sessionId: string | undefined;
		try {
			// Create session via SessionManager — no worktree created (direct createSession, not spawnRole)
			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				allowedTools: role.allowedTools,
			});
			sessionId = session.id;

			// Set title and metadata
			this.sessionManager!.setTitle(sessionId, `Reviewer: ${step.name}`);
			this.sessionManager!.updateSessionMeta(sessionId, {
				role: "reviewer",
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
							console.log(`[verification] Set review model "${reviewModelPref}" for ${sessionId}`);
						} catch (err) {
							console.warn(`[verification] Failed to set review model "${reviewModelPref}", using default:`, err);
						}
					} else {
						console.warn(`[verification] Malformed default.reviewModel preference: "${reviewModelPref}", ignoring`);
					}
				}
			}

			// Send kickoff prompt and wait for idle
			await session.rpcClient.prompt(kickoff);
			await this.sessionManager!.waitForIdle(sessionId, timeoutMs);

			// Get output from the session
			const output = await this.sessionManager!.getSessionOutput(sessionId);

			const verdict = parseVerdict(output);
			if (verdict === null) {
				return { passed: false, output: output || "LLM review failed: no <verdict> tag found in sub-agent output." };
			}

			return { passed: verdict, output };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out") || err.message?.includes("Timeout");
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.`
				: `LLM review failed: ${err.message}`;
			return { passed: false, output: errOutput };
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
	 * Legacy direct-RpcBridge path for LLM review (invisible to UI).
	 * Used when SessionManager is not available.
	 */
	private async runLlmReviewDirect(
		step: { name: string; prompt?: string; timeout?: number },
		cwd: string,
		role: { promptTemplate: string; allowedTools: string[] },
		combinedPrompt: string,
		kickoff: string,
		timeoutMs: number,
	): Promise<{ passed: boolean; output: string }> {
		const subSessionId = `llm-review-${randomUUID().slice(0, 12)}`;

		// Assemble system prompt to temp file
		const systemPromptPath = assembleSystemPrompt(subSessionId, {
			cwd,
			goalSpec: combinedPrompt,
			goalTitle: `LLM Review: ${step.name}`,
			goalState: "active",
		});

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: ["--tools", role.allowedTools.join(",")],
		};
		if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

		const rpc = new RpcBridge(bridgeOptions);

		try {
			await rpc.start();

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
				return { passed: false, output: output || "LLM review failed: no <verdict> tag found in sub-agent output." };
			}

			return { passed: verdict, output };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out");
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.`
				: `LLM review failed: ${err.message}`;
			return { passed: false, output: errOutput };
		} finally {
			await rpc.stop().catch(() => {});
			try {
				const promptDir = path.join(bobbitStateDir(), "session-prompts");
				const promptFile = path.join(promptDir, `${subSessionId}.md`);
				if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
			} catch { /* ignore */ }
		}
	}

	/**
	 * Substitute variables in a template string.
	 * Supports: {{var}}, {{gate_id.field}} (for upstream gate metadata)
	 */
	private substituteVars(
		template: string,
		builtinVars: Record<string, string>,
		allGateStates?: Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>,
	): string {
		return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
			const trimmed = key.trim();

			// Check builtin vars first
			if (trimmed in builtinVars) return builtinVars[trimmed];

			// Check for gate_id.field syntax
			const dotIndex = trimmed.indexOf(".");
			if (dotIndex > 0 && allGateStates) {
				const gateId = trimmed.slice(0, dotIndex);
				const field = trimmed.slice(dotIndex + 1);
				const gateState = allGateStates.get(gateId);
				if (gateState?.metadata && field in gateState.metadata) {
					return gateState.metadata[field];
				}
			}

			return match; // Leave unresolved
		});
	}

	private runCommandStep(
		command: string,
		cwd: string,
		timeoutSec: number,
		expectFailure: boolean,
	): Promise<{ passed: boolean; output: string }> {
		return new Promise((resolve) => {
			const normalizedCwd = cwd.replace(/\\/g, "/");
			// On Windows, use cmd.exe for npm/node commands, Git Bash for commands with Unix tools (grep, etc.)
			const needsUnixShell = /\b(grep|awk|sed|cat|head|tail|wc|sort|uniq|xargs|find\s)\b/.test(command);
			let child;
			if (process.platform === "win32" && needsUnixShell && GIT_BASH) {
				child = spawn(GIT_BASH, ["--login", "-c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else if (process.platform === "win32") {
				const shell = process.env.ComSpec || "cmd.exe";
				child = spawn(shell, ["/d", "/s", "/c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else {
				child = spawn("/bin/sh", ["-c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
				});
			}
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024); });
			child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024); });
			child.on("close", (code) => {
				const output = (stdout + "\n" + stderr).trim().slice(-5000);
				const exitedNonZero = code !== 0;
				if (expectFailure) {
					resolve({ passed: exitedNonZero, output: output || `exit code ${code}` });
				} else {
					resolve({ passed: !exitedNonZero, output: output || `exit code ${code}` });
				}
			});
			child.on("error", (err) => {
				resolve({ passed: expectFailure, output: err.message });
			});
		});
	}
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
