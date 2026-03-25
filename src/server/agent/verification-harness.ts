import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { statSync } from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { GateStore, GateSignal } from "./gate-store.js";
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

export class VerificationHarness {
	private notifyTeamLeadFn?: (goalId: string, message: string) => void;

	constructor(
		private gateStore: GateStore,
		private broadcastFn: (goalId: string, event: any) => void,
		private roleStore: RoleStore,
		private preferencesStore?: PreferencesStore,
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
		});

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

			// Run all verification steps in parallel
			const indexedResults = await Promise.all(
				steps.map(async (step, index) => {
					let result: { passed: boolean; output: string };
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
							result = await this.runLlmReviewStep(
								{ name: step.name, prompt, timeout: step.timeout },
								cwd,
								builtinVars,
								signal.content,
								signal.metadata,
								goalSpec,
								allGateStates,
							);
						}
					}

					const duration_ms = Date.now() - startTime;
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
	): Promise<{ passed: boolean; output: string }> {
		const role = this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: "LLM review failed: 'reviewer' role not found in role store." };
		}

		const subSessionId = `llm-review-${randomUUID().slice(0, 12)}`;
		const timeoutMs = (step.timeout || 300) * 1000;

		// Build system prompt from reviewer role template + step prompt + signal context
		let rolePrompt = role.promptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, builtinVars.branch || "HEAD")
			.replace(/\{\{AGENT_ID\}\}/g, subSessionId);

		const sections: string[] = [rolePrompt];

		if (step.prompt) {
			sections.push(`\n## Review Step Instructions\n\n${step.prompt}`);
		}

		// Reinforce verdict requirement in system prompt (LLMs prioritise system prompt over user messages)
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

		// Goal specification context
		if (goalSpec) {
			sections.push(`\n## Goal Specification\n\n${goalSpec}`);
		}

		// Upstream gate content (from passed gates with injectDownstream)
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

		// Signal context
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

		const combinedPrompt = sections.join("\n");

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
				const reviewModelPref = this.preferencesStore.get("default.reviewModel");
				if (reviewModelPref && typeof reviewModelPref === "string") {
					const slash = reviewModelPref.indexOf("/");
					if (slash > 0) {
						const provider = reviewModelPref.slice(0, slash);
						const modelId = reviewModelPref.slice(slash + 1);
						await rpc.setModel(provider, modelId);
					}
				}
			}

			// Collect assistant text from streaming events as a fallback
			// in case getMessages() fails after agent_end (race with process exit).
			let streamedAssistantText = "";

			// Wait for agent_end event with timeout
			const completionPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`LLM review sub-agent timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs);

				const eventUnsub = rpc.onEvent((event: any) => {
					// Capture assistant text from message_end events as they arrive.
					// This serves as a fallback if getMessages() fails after agent_end.
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

			// Send kickoff prompt
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

			await rpc.prompt(kickoff);
			await completionPromise;

			// Extract last assistant message — try getMessages() first, fall back to streamed text
			let output = "";
			try {
				const msgsResp = await rpc.getMessages();
				if (msgsResp.success && Array.isArray(msgsResp.data)) {
					output = extractLastAssistantOutput(msgsResp.data);
				}
			} catch {
				// Non-fatal — we may still have partial output from streaming
			}
			// If getMessages() returned nothing (race with process exit), use streamed text
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
			// Clean up temporary system prompt
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
