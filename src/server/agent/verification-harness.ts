import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { spawnTracked, killAllTracked, killTreeByPid, type TrackedChild } from "./spawn-tree.js";
import { realClock, realCommandRunner, type Clock, type CommandRunner, type TimerHandle } from "../gateway-deps.js";
import { broadcastGateStatusChanged } from "../gate-status-broadcast.js";
import { realVerificationCommandRunner, type VerificationCommandRunner } from "./verification-command-runner.js";

/** Check whether a process is still running (Layer 1 liveness check). */
function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

const COMMAND_IDENTITY_HEARTBEAT_STALE_MS = 10_000;
const COMMAND_IDENTITY_PIDFILE_RETRY_MS = 2_000;
const COMMAND_IDENTITY_PIDFILE_RETRY_INTERVAL_MS = 100;
const COMMAND_LOG_FINAL_OUTPUT_TAIL_BYTES = Math.min(MAX_RETAINED_LOG_BYTES, 1024 * 1024);
const COMMAND_EXIT_CLOSE_GRACE_MS = Math.max(
	500,
	Number.parseInt(process.env.BOBBIT_VERIFICATION_EXIT_CLOSE_GRACE_MS || "2000", 10) || 2_000,
);

class PendingCommandCleanupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PendingCommandCleanupError";
	}
}

function isPendingCommandCleanupError(err: unknown): err is PendingCommandCleanupError {
	return err instanceof PendingCommandCleanupError || (err as any)?.name === "PendingCommandCleanupError";
}

function readProcessStartToken(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = raw.lastIndexOf(")");
		if (end < 0) return undefined;
		const rest = raw.slice(end + 2).trim().split(/\s+/);
		// /proc/<pid>/stat field 22 is starttime. `rest[0]` is field 3.
		return rest[19] || undefined;
	} catch {
		return undefined;
	}
}

function shellSingleQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function readCommandLogTail(filePath: string | undefined, maxBytes = COMMAND_LOG_FINAL_OUTPUT_TAIL_BYTES): string {
	if (!filePath || maxBytes <= 0) return "";
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return "";
		const len = Math.min(stat.size, maxBytes);
		const start = Math.max(0, stat.size - len);
		fd = fs.openSync(filePath, "r");
		const buf = Buffer.allocUnsafe(len);
		const bytesRead = fs.readSync(fd, buf, 0, len, start);
		return buf.subarray(0, bytesRead).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

function tailRetainCommandLogFile(filePath: string | undefined, keepBytes = MAX_RETAINED_LOG_BYTES): { truncated: boolean; bytes: number } {
	if (!filePath || keepBytes <= 0) return { truncated: false, bytes: 0 };
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return { truncated: false, bytes: 0 };
		if (stat.size <= keepBytes) return { truncated: false, bytes: stat.size };
		const start = Math.max(0, stat.size - keepBytes);
		const len = stat.size - start;
		fd = fs.openSync(filePath, "r+");
		const buf = Buffer.allocUnsafe(len);
		const bytesRead = fs.readSync(fd, buf, 0, len, start);
		const retained = buf.subarray(0, bytesRead);
		fs.ftruncateSync(fd, 0);
		if (retained.length > 0) fs.writeSync(fd, retained, 0, retained.length, 0);
		fs.ftruncateSync(fd, retained.length);
		return { truncated: true, bytes: retained.length };
	} catch {
		return { truncated: false, bytes: 0 };
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

function tailRetainCommandLogs(outFile?: string, errFile?: string): void {
	tailRetainCommandLogFile(outFile);
	tailRetainCommandLogFile(errFile);
}

function retainedCommandOutputTail(outFile?: string, errFile?: string): string {
	const out = readCommandLogTail(outFile);
	const err = readCommandLogTail(errFile);
	return (out + "\n" + err).trim().slice(-5000);
}
import fs from "node:fs";
import path from "node:path";
import type { GateStore, GateSignal, GateSignalStep } from "./gate-store.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { RoleStore } from "./role-store.js";
import { resolveRole as resolveRoleFromGoal, listAvailableRoles } from "./resolve-role.js";
import { GoalPausedError } from "./goal-paused-guard.js";
import type { PersistedGoal } from "./goal-store.js";
import { detectPrimaryBranch, parseBaseRef } from "../skills/git.js";
import { type WorkflowGate, type VerifyStep } from "./workflow-store.js";
import { resolveChildWorkflow } from "./spawn-child-workflow.js";
import { resolveSpawnedBySessionId } from "./spawn-child-spawnedby.js";
import {
	readSubgoalNestingPrefs,
	checkCanSpawnChild,
	inheritedChildOverrides,
} from "./subgoal-nesting-limit.js";
import { adaptReadyToMergeVerify, adaptReadyToMergeForChild } from "./child-ready-to-merge.js";
import type { ProjectConfigStore, Component } from "./project-config-store.js";
import type { ToolManager } from "./tool-manager.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { GrantPolicy } from "./role-store.js";
import { computeEffectiveAllowedTools, computeToolActivationArgs, tagAllowedTool, writeMcpProxyExtensions, writeToolGuardExtension, type GroupPolicyProvider } from "./tool-activation.js";
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
	readyToMergeUnresolvedBuiltinFailure,
	partitionOptionalSteps,
	buildStepCache,
	computeAllPassed,
	canSkipAllSteps,
	detectJsonValidationError,
	describeProviderBackoff,
	isPreImplementationGate,
	isProviderBackoffError,
	isRetryableGenericAgentError,
	TRANSIENT_INFRA_ERROR_REGEXES,
	shouldRetryVerificationStep,
	isRestartInterruptError,
	isRestartInterruptedStep,
	decideCommandRecoveryMode,
	shouldRerunSessionStepOnResume,
	type CommandRecoveryMode,
} from "./verification-logic.js";
import { nextBackoffDelay } from "./session-setup.js";
import { dispatchTrackedSystemPrompt } from "./session-manager.js";
import { Semaphore } from "./semaphore.js";
import { ChildTeamScheduler } from "./child-team-scheduler.js";
import { applyReviewModelOverrides, applyModelString } from "./review-model-override.js";
import { buildVerificationFailureMessage } from "./notify-team-lead-failure.js";

import { buildVerificationReviewerMeta } from "./verification-reviewer-meta.js";
import { THINKING_LEVELS } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import { sanitizeModelErrorForLog } from "./model-error-sanitizer.js";
import { validateSpawnChildSpec } from "./spawn-child-spec-validation.js";
import {
	appendRetainedLogChunk,
	finalizeGateStepDiagnostics,
	MAX_RETAINED_LOG_BYTES,
	prepareGateStepDiagnosticsPaths,
	type GateStepDiagnostics,
	type GateStepDiagnosticsPaths,
} from "../gate-diagnostics.js";

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
	return clampThinkingLevelForModel(level, provider, modelId);
}

function controlledSessionModelFallback(prefs: PreferencesStore | undefined): { enabled: boolean; model?: string } | undefined {
	if (!prefs) return undefined;
	return {
		enabled: prefs.get("allowSessionModelFallback") === true,
		model: prefs.get("default.sessionModel") as string | undefined,
	};
}

export interface VerificationToolActivationDeps {
	toolManager?: ToolManager;
	groupPolicyStore?: GroupPolicyProvider;
	mcpManager?: McpManager | null;
}

export interface VerificationToolActivationResult {
	args: string[];
	env: Record<string, string>;
	toolManager?: ToolManager;
	allowedTools?: string[];
}

/**
 * Build Pi CLI flags for legacy direct verification sub-sessions using the
 * same post-Pi-0.70 contract as normal sessions: no unified `--tools`, file
 * builtins re-registered via `_builtins/extension.ts`, Bobbit extensions kept
 * active, and policy enforcement delegated to the guard extension.
 */
export function buildVerificationToolActivation(
	subSessionId: string,
	cwd: string,
	role: { toolPolicies?: Record<string, string | GrantPolicy> } | undefined,
	deps: VerificationToolActivationDeps = {},
): VerificationToolActivationResult {
	const roleForPolicies = role as { toolPolicies?: Record<string, GrantPolicy> } | undefined;
	if (!deps.toolManager) {
		// Without a ToolManager we cannot resolve Bobbit extension paths or emit
		// the _builtins shim safely. Return no explicit activation flags so
		// RpcBridge.start() applies its baseline fallback without reintroducing
		// Pi's unified `--tools` allowlist.
		return {
			args: [],
			env: {},
			allowedTools: role?.toolPolicies
				? Object.entries(role.toolPolicies).filter(([, policy]) => policy !== "never").map(([name]) => tagAllowedTool(name).name)
				: undefined,
		};
	}

	const effectiveAllowedTools = computeEffectiveAllowedTools(deps.toolManager, roleForPolicies, deps.groupPolicyStore, deps.mcpManager ?? undefined);
	const allowedToolNames = effectiveAllowedTools.map(tool => tool.name);
	const mcpExtensionPaths = deps.mcpManager
		? writeMcpProxyExtensions(deps.mcpManager, allowedToolNames, roleForPolicies, deps.toolManager, deps.groupPolicyStore)
		: undefined;
	const activation = computeToolActivationArgs(effectiveAllowedTools, deps.toolManager, cwd, mcpExtensionPaths);
	const args = [...activation.args];

	const guardPath = deps.toolManager
		? writeToolGuardExtension(subSessionId, deps.toolManager, deps.mcpManager ?? undefined, roleForPolicies, deps.groupPolicyStore)
		: undefined;
	if (guardPath) args.push("--extension", guardPath);

	return {
		args,
		env: activation.env,
		toolManager: deps.toolManager,
		allowedTools: allowedToolNames,
	};
}

/**
 * Resolve a component's cwd within `branchContainer`. Multi-repo:
 * `<branchContainer>/<repo>/<relativePath>`. Single-repo collapses to
 * `branchContainer`.
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
/** Return the un-offset branch container for a goal. `goal.worktreePath` is
 * always the worktree root; `goal.cwd` may carry a monorepo sub-path offset.
 * resolveStep() layers repo + relativePath itself, so we pass the unoffset
 * root to avoid applying the offset twice. */
export function goalBranchContainer(goal: { worktreePath?: string; cwd: string }): string {
	return goal.worktreePath ?? goal.cwd;
}

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

const DEFAULT_COMMAND_STEP_TIMEOUT_SEC = 300;
const DEFAULT_UNIT_COMMAND_STEP_TIMEOUT_SEC = 1200;

/** Review-agent active-turn allowance. Command/build defaults are intentionally separate. */
export const DEFAULT_LLM_REVIEW_TIMEOUT_S = 1200;
export const MIN_LLM_REVIEW_TIMEOUT_S = 1;

/**
 * Resolve the fresh per-active-turn allowance for review-agent steps.
 * Explicit positive values are authoritative (including values below the
 * default); malformed values fall back instead of becoming accidental 1s
 * kill windows. Agent-QA's omitted default retains its component duration
 * buffer while sharing the 1200s review floor.
 */
export function resolveReviewStepTimeoutSec(
	step: Pick<VerifyStep, "type" | "timeout">,
	qaMaxDurationMinutes = 10,
): number {
	if (typeof step.timeout === "number" && Number.isFinite(step.timeout) && step.timeout > 0) {
		return Math.max(MIN_LLM_REVIEW_TIMEOUT_S, Math.floor(step.timeout));
	}
	if (step.type === "agent-qa") {
		const qaMinutes = Number.isFinite(qaMaxDurationMinutes) && qaMaxDurationMinutes > 0
			? qaMaxDurationMinutes
			: 10;
		return Math.max(DEFAULT_LLM_REVIEW_TIMEOUT_S, Math.floor((qaMinutes + 5) * 60));
	}
	return DEFAULT_LLM_REVIEW_TIMEOUT_S;
}

type VerificationTimeoutInfo = GateSignalStep extends { timeout?: infer T }
	? NonNullable<T>
	: { configuredSeconds: number; elapsedMs: number };

type ReviewStepExecutionResult = {
	passed: boolean;
	output: string;
	sessionId?: string;
	status?: "timeout";
	timeout?: VerificationTimeoutInfo;
};

function execOutputToString(value: unknown): string {
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return typeof value === "string" ? value : "";
}

function execErrorCode(err: unknown): number | string | undefined {
	return (err as { code?: number | string } | null | undefined)?.code;
}

function isMissingRemoteHeadLsRemoteError(err: unknown): boolean {
	const code = execErrorCode(err);
	if (code !== 2 && code !== "2") return false;
	const stdout = execOutputToString((err as { stdout?: unknown } | null | undefined)?.stdout).trim();
	const stderr = execOutputToString((err as { stderr?: unknown } | null | undefined)?.stderr);
	if (stdout) return false;
	return !/\bfatal:|could not|unable|authentication|permission denied/i.test(stderr);
}

function lsRemoteOutputHasHead(stdout: unknown, branch: string): boolean {
	const headRef = `refs/heads/${branch}`;
	return execOutputToString(stdout)
		.split(/\r?\n/)
		.some(line => line.trimEnd().endsWith(`\t${headRef}`));
}

/**
 * Frozen workflows may omit `timeout:` for component command steps. The full
 * unit suite is resource-sensitive on developer machines/CI and can exceed the
 * generic 5-minute shell default under contention, so give `command: unit` a
 * durable default while preserving explicit workflow timeouts.
 */
export function resolveCommandStepTimeoutSec(step: Pick<VerifyStep, "type" | "component" | "command" | "timeout">): number {
	if (typeof step.timeout === "number" && Number.isFinite(step.timeout) && step.timeout > 0) return step.timeout;
	const isComponentUnitCommand = step.type === "command"
		&& typeof step.component === "string"
		&& step.component.length > 0
		&& typeof step.command === "string"
		&& step.command.toLowerCase() === "unit";
	return isComponentUnitCommand ? DEFAULT_UNIT_COMMAND_STEP_TIMEOUT_SEC : DEFAULT_COMMAND_STEP_TIMEOUT_SEC;
}

export async function runVerificationPhaseSteps<T, R>(
	phaseSteps: readonly T[],
	runStep: (phaseStep: T) => Promise<R>,
): Promise<R[]> {
	return Promise.all(phaseSteps.map(phaseStep => runStep(phaseStep)));
}

export interface VerificationPushSafetyVars {
	branch?: string;
	baseBranch?: string;
	master?: string;
}

export type VerificationPushSafetyResult = { ok: true } | { ok: false; reason: string };

const SHELL_COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|"]);

function shellTokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;

	const flush = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < command.length && ['"', "\\", "$", "`", "\n"].includes(command[i + 1])) current += command[++i];
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i];
			continue;
		}
		if (ch === "\n" || ch === ";") {
			flush();
			tokens.push(";");
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		const next = command[i + 1];
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			flush();
			tokens.push(ch + next);
			i++;
			continue;
		}
		if (ch === "|") {
			flush();
			tokens.push("|");
			continue;
		}
		current += ch;
	}
	flush();
	return tokens;
}

function isShellSeparator(token: string): boolean {
	return SHELL_COMMAND_SEPARATORS.has(token);
}

function commandEnd(tokens: string[], start: number): number {
	let end = start;
	while (end < tokens.length && !isShellSeparator(tokens[end])) end++;
	return end;
}

function skipGitGlobalOption(tokens: string[], index: number, end: number): number {
	const token = tokens[index];
	if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree" || token === "--namespace" || token === "--config-env") {
		return Math.min(index + 2, end);
	}
	return index + 1;
}

function normalizeBranchRef(ref: string | undefined): string {
	let value = (ref || "").trim();
	while (value.startsWith("+")) value = value.slice(1);
	if (value.startsWith("refs/remotes/origin/")) value = value.slice("refs/remotes/origin/".length);
	if (value.startsWith("origin/")) value = value.slice("origin/".length);
	if (value.startsWith("refs/heads/")) value = value.slice("refs/heads/".length);
	return value;
}

function normalizePushedSource(src: string, currentBranch: string): string {
	const normalized = normalizeBranchRef(src);
	if (normalized === "HEAD" || normalized === "@") return currentBranch;
	return normalized;
}

function protectedBranchSet(vars: VerificationPushSafetyVars): Set<string> {
	const branches = [vars.baseBranch, vars.master, "master"]
		.map(normalizeBranchRef)
		.filter((b) => b.length > 0);
	return new Set(branches);
}

function protectedBranchLabel(branches: Set<string>): string {
	return [...branches].map((b) => `refs/heads/${b}`).join(" or ") || "the primary branch";
}

function executableBasename(token: string): string {
	const normalized = token.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isGitExecutableToken(token: string): boolean {
	const base = executableBasename(token);
	return base === "git" || base === "git.exe" || base === "git.cmd" || base === "git.bat";
}

function findGitPushes(tokens: string[]): Array<{ gitIndex: number; pushIndex: number; end: number }> {
	const pushes: Array<{ gitIndex: number; pushIndex: number; end: number }> = [];
	for (let i = 0; i < tokens.length; i++) {
		if (!isGitExecutableToken(tokens[i])) continue;
		const end = commandEnd(tokens, i + 1);
		let j = i + 1;
		while (j < end) {
			const token = tokens[j];
			if (token === "push") {
				pushes.push({ gitIndex: i, pushIndex: j, end });
				break;
			}
			if (token.startsWith("-")) {
				j = skipGitGlobalOption(tokens, j, end);
				continue;
			}
			break;
		}
		i = end;
	}
	return pushes;
}

function pushOptionConsumesValue(token: string): boolean {
	return token === "--repo" || token === "--receive-pack" || token === "--exec" || token === "--push-option" || token === "-o";
}

function parsePushArgs(tokens: string[], pushIndex: number, end: number): { remote?: string; refspecs: string[]; pushesAllBranches: boolean; tagsOnly: boolean } {
	let remote: string | undefined;
	const refspecs: string[] = [];
	let pushesAllBranches = false;
	let tagsOnly = false;

	for (let i = pushIndex + 1; i < end; i++) {
		const token = tokens[i];
		if (token === "--repo") {
			remote = tokens[i + 1] || remote;
			i++;
			continue;
		}
		if (token.startsWith("--repo=")) {
			remote = token.slice("--repo=".length);
			continue;
		}
		if (token === "--all" || token === "--mirror") {
			pushesAllBranches = true;
			continue;
		}
		if (token === "--tags") {
			tagsOnly = true;
			continue;
		}
		if (token.startsWith("-") && token !== "-") {
			if (pushOptionConsumesValue(token)) i++;
			continue;
		}
		if (!remote) {
			remote = token;
			continue;
		}
		refspecs.push(token);
	}

	return { remote, refspecs, pushesAllBranches, tagsOnly };
}

function unsafePushReason(pushCommand: string, detail: string, vars: VerificationPushSafetyVars, protectedBranches: Set<string>): VerificationPushSafetyResult {
	const branch = normalizeBranchRef(vars.branch) || "HEAD";
	return {
		ok: false,
		reason: `[verification] Refusing unsafe git push in verification command: ${pushCommand}\n${detail}\nCurrent branch: ${branch}; protected destination: ${protectedBranchLabel(protectedBranches)}. Use an explicit destination refspec such as \`git push origin ${branch}:refs/heads/${branch}\` for branch publication checks.`,
	};
}

function inspectPushRefspec(pushCommand: string, refspec: string, currentBranch: string, vars: VerificationPushSafetyVars, protectedBranches: Set<string>): VerificationPushSafetyResult | null {
	const clean = refspec.replace(/^\+/, "");
	if (!clean || clean.startsWith("refs/tags/")) return null;

	if (clean.includes(":")) {
		const colon = clean.indexOf(":");
		const src = clean.slice(0, colon);
		const dst = clean.slice(colon + 1);
		const dstBranch = normalizeBranchRef(dst);
		if (dstBranch && protectedBranches.has(dstBranch)) {
			const srcBranch = normalizePushedSource(src, currentBranch);
			if (currentBranch !== dstBranch || srcBranch !== dstBranch) {
				return unsafePushReason(
					pushCommand,
					`Refspec \`${refspec}\` targets \`refs/heads/${dstBranch}\` from \`${srcBranch || "(delete/empty source)"}\`. Verification must not update a protected base branch from a different branch.`,
					vars,
					protectedBranches,
				);
			}
		}
		return null;
	}

	const branch = normalizeBranchRef(clean);
	if (!branch) return null;
	if (protectedBranches.has(branch)) {
		if (currentBranch === branch) return null;
		return unsafePushReason(
			pushCommand,
			`Bare ref \`${refspec}\` can update protected branch \`refs/heads/${branch}\` while verification is running on \`${currentBranch || "HEAD"}\`.`,
			vars,
			protectedBranches,
		);
	}

	return unsafePushReason(
		pushCommand,
		`Bare ref \`${refspec}\` has no destination ref. With inherited upstream configuration (for example \`push.default=upstream\`), Git can push it to a protected branch instead of \`refs/heads/${branch}\`.`,
		vars,
		protectedBranches,
	);
}

export function validateVerificationPushSafety(command: string, vars: VerificationPushSafetyVars): VerificationPushSafetyResult {
	const tokens = shellTokenize(command);
	const protectedBranches = protectedBranchSet(vars);
	const currentBranch = normalizeBranchRef(vars.branch);
	const currentIsProtected = currentBranch.length > 0 && protectedBranches.has(currentBranch);

	for (const push of findGitPushes(tokens)) {
		const parsed = parsePushArgs(tokens, push.pushIndex, push.end);
		const pushCommand = tokens.slice(push.gitIndex, push.end).join(" ");

		if (parsed.pushesAllBranches && !currentIsProtected) {
			return unsafePushReason(pushCommand, "Pushing all branches from a non-primary verification branch can update the protected base branch.", vars, protectedBranches);
		}
		if (parsed.refspecs.length === 0) {
			if (!currentIsProtected && !parsed.tagsOnly) {
				return unsafePushReason(pushCommand, "A push with no explicit refspec can use inherited upstream configuration and update the protected base branch.", vars, protectedBranches);
			}
			continue;
		}

		for (const refspec of parsed.refspecs) {
			const result = inspectPushRefspec(pushCommand, refspec, currentBranch, vars, protectedBranches);
			if (result) return result;
		}
	}

	return { ok: true };
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

/**
 * Outcome of a `human-signoff` step. The verification harness parks an
 * awaiter in `pendingSignoffs` until either the REST handler resolves it
 * with a decision (pass/fail + optional feedback) or `cancelStaleVerifications`
 * drains it with `{ cancelled: true }`.
 */
export type SignoffOutcome =
	| { decision: "pass" | "fail"; feedback?: string }
	| { cancelled: true };

/** Reminder prompt sent when an agent goes idle without calling verification_result. */
export const VERIFICATION_RESULT_REMINDER =
	"You went idle without submitting your results. " +
	"Call the `verification_result` tool now with your verdict and summary. " +
	"This is REQUIRED — the verification system only receives results through this tool.";

/** Prompt sent to verifier sessions whose turn was interrupted by a server restart. */
export const VERIFICATION_RESTART_RESUME_PROMPT =
	"The Bobbit server/infrastructure restarted while your verification turn was in progress. " +
	"Your transcript and verification context were preserved. Review the recent context, continue the interrupted review/QA analysis from where you left off, " +
	"and call `verification_result` only when your analysis is complete.";

/**
 * Build a context-rich reminder for live (not resumed) reviewers
 * who emit their verdict as chat-text and end the turn instead of calling
 * `verification_result`.
 *
 * The two-sentence legacy `VERIFICATION_RESULT_REMINDER` consistently failed
 * to elicit a tool call: with no kickoff context attached, the model treats
 * the reminder as a continuation of its previous (chat-text) reply. The
 * context-rich version:
 *
 *   1. Leads with `## STOP — verification_result not called` so the agent
 *      treats it as a hard correction, not a continuation.
 *   2. States explicitly that any chat-text verdict is INVISIBLE to the gate.
 *   3. Tells the agent to call the tool with whatever opinion it ALREADY
 *      formed — no re-investigation.
 *   4. Re-attaches the FULL original kickoff after a `---` separator, so the
 *      agent has the original task spec back in context.
 *
 * Wire this into BOTH the LLM-review reminder path and the agent-QA reminder
 * path. The resume path (`_tryResumeFromSession`) uses either the legacy terse
 * reminder or a restart-aware continuation prompt because it doesn't have
 * access to rebuild the kickoff.
 */
export function buildContextRichReminder(originalKickoff: string): string {
	return `## STOP — verification_result not called

Your previous turn ended without calling \`verification_result\`. Any chat-text verdict is INVISIBLE to the gate.

Call \`verification_result\` now with whatever opinion you ALREADY FORMED — do not re-investigate. Use status="pass" if your investigation was satisfactory, "fail" otherwise.

---

${originalKickoff}`;
}

/** Restart-aware continuation prompt for a resurrected agent-qa process. */
export function buildQaRestartContinuationPrompt(originalKickoff: string): string {
	return `## QA verification process restarted

The Bobbit server/infrastructure or QA agent process restarted while your QA verification turn was in progress. Your transcript and verification context were preserved.

Continue the QA verification from where you left off. Use the preserved transcript together with the original QA test plan/context below, complete any remaining QA work, and call \`verification_result\` only when QA is complete.

---

${originalKickoff}`;
}

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
	steps: Array<{
		name: string;
		type: string;
		status: NonNullable<GateSignalStep["status"]>;
		phase?: number;
		durationMs?: number;
		output?: string;
		startedAt: number;
		sessionId?: string;
		/** Subgoal-step cache — Tier-1.5 lookup reads `childGoalId` to short-circuit tier resolution. */
		subgoal?: { childGoalId?: string; planId?: string; };
		/** True while a `human-signoff` step is parked waiting on the user. */
		awaitingHuman?: boolean;
		/** Already-substituted markdown prompt shown to the user (human-signoff). */
		humanPrompt?: string;
		/** Human-readable label rendered on the sign-off card (human-signoff). */
		humanLabel?: string;
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
		/** Absolute path to durable process-identity file written by the detached wrapper. */
		pidFile?: string;
		/** Random nonce expected in the durable process-identity and heartbeat files. */
		pidNonce?: string;
		/** Compatibility alias used by bash_bg-style pidfile records and older tests. */
		nonce?: string;
		/** Container id for attached docker exec command paths (not restart-recoverable). */
		containerId?: string;
		/** Absolute path to the detached wrapper's periodically-refreshed heartbeat file. */
		heartbeatFile?: string;
		/** OS-specific process start token captured after spawn, used to reject PID reuse. */
		processStartToken?: string;
		/** Original command deadline in epoch milliseconds. */
		deadlineMs?: number;
		/** Restart recovery support mode for this command execution path. */
		restartRecoveryMode?: CommandRecoveryMode;
		/** Clear diagnostic when the command path cannot be recovered after restart. */
		restartRecoveryUnsupportedReason?: string;
		/** bootEpoch of the harness that started this step (Layer 2). */
		bootEpoch?: string;
		/** Resolved command deadline or fresh review-agent active-turn allowance, in seconds. */
		timeoutSec?: number;
		/** Terminal review-agent timeout marker and timing for the turn that expired. */
		timeout?: VerificationTimeoutInfo;
		/** Whether the step expects a non-zero exit. */
		expectFailure?: boolean;
		/** Optional error-pattern regex for expectFailure matching. */
		errorPattern?: string;
		/** Host cwd used for targeted artifact retention after a command finishes. */
		commandCwd?: string;
		/** Durable kill/cancel intent for restart-safe cleanup of detached command trees. */
		killRequestedAt?: number;
		killReason?: "cancelled" | "timeout";
		killSignal?: NodeJS.Signals;
		killAttempts?: number;
		killLastAttemptAt?: number;
		killCompletedAt?: number;
		killUnsafeReason?: string;
	}>;
	currentPhase?: number;
	overallStatus: "running" | "passed" | "failed" | "cancelled";
	startedAt: number;
	cancelled?: boolean;
	cancelRequestedAt?: number;
	cancelReason?: string;
}

type TerminalGateSignalStepStatus = "passed" | "failed" | "timeout" | "skipped";
type PersistedGateSignalStepStatus = GateSignalStep["status"] | "timeout";

type ResumedVerificationStep = {
	name: string;
	type: string;
	passed: boolean;
	skipped?: boolean;
	status?: PersistedGateSignalStepStatus;
	phase?: number;
	output: string;
	duration_ms: number;
	timeout?: VerificationTimeoutInfo;
	diagnostics?: GateStepDiagnostics;
};

function terminalStatusForStep(step: { passed: boolean; skipped?: boolean; status?: PersistedGateSignalStepStatus }): TerminalGateSignalStepStatus {
	if (step.skipped || step.status === "skipped") return "skipped";
	if (step.status === "timeout") return "timeout";
	if (step.status === "passed" || step.status === "failed") return step.status;
	return step.passed ? "passed" : "failed";
}

function persistedStatusForStep(step: { passed: boolean; skipped?: boolean; status?: PersistedGateSignalStepStatus }): PersistedGateSignalStepStatus {
	if (step.skipped || step.status === "skipped") return "skipped";
	if (step.status === "waiting" || step.status === "running") return step.status;
	if (step.status === "timeout") return "timeout";
	if (step.status === "passed" || step.status === "failed") return step.status;
	return step.passed ? "passed" : "failed";
}

function isExplicitRestartInterruptedStep(step: { passed: boolean; skipped?: boolean; status?: PersistedGateSignalStepStatus; output: string; type: string }): boolean {
	if (step.passed || step.skipped) return false;
	if (step.type === "command") return step.status === "waiting";
	return isRestartInterruptedStep(step);
}

function shouldSuppressExplicitRestartInterrupt(steps: ReadonlyArray<{ passed: boolean; skipped?: boolean; status?: PersistedGateSignalStepStatus; output: string; type: string }>): boolean {
	const failedSteps = steps.filter(s => !s.passed && !s.skipped);
	if (failedSteps.length === 0) return false;
	return failedSteps.every(isExplicitRestartInterruptedStep);
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
 * - Implementation and later: `git diff origin/<base>...HEAD` forms; the
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
	commandRunner: CommandRunner = realCommandRunner,
): Promise<string> {
	const isDesignGate = gate ? isPreImplementationGate(gate) : false;
	const reviewBaselineBranch = builtinVars.baseBranch || builtinVars.master || "master";
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
			`- \`git diff --stat origin/${reviewBaselineBranch}...HEAD -- . ':!package-lock.json'\` — summary`,
			`- \`git diff origin/${reviewBaselineBranch}...HEAD -M -- . ':!package-lock.json'\` — with rename detection`,
			`- \`git log --oneline origin/${reviewBaselineBranch}..HEAD\` — commits on this branch`,
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
			const { stdout } = await commandRunner.execFile("git", ["rev-parse", `origin/${reviewBaselineBranch}`], { cwd, timeout: 5_000 });
			baselineSha = stdout.toString().trim().slice(0, 12);
		} catch {
			baselineSha = null;
		}
		baselineLine = baselineSha
			? `- Baseline: diffed against origin/${reviewBaselineBranch}@${baselineSha}`
			: `- Baseline: origin/${reviewBaselineBranch} (sha unresolved)`;
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
			`- \`git diff --stat origin/${reviewBaselineBranch}...HEAD -- . ':!package-lock.json'\` — summary of which files changed`,
			`- \`git diff origin/${reviewBaselineBranch}...HEAD -M -- . ':!package-lock.json'\` — branch diff with rename detection (collapses pure renames)`,
			`- For large diffs, review individual files with \`read\` instead of loading the full diff into context`,
			`- \`git log --oneline origin/${reviewBaselineBranch}..HEAD\` — commits on this branch`,
			"- Use `read` to view files directly — they are already at the correct version",
			"",
			"## Signal Context",
			`- Branch: ${branch}`,
			`- Commit: ${commit}`,
			`- Base branch: ${reviewBaselineBranch}`,
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

/**
 * Cap on the longest delay between verification-step retries when the
 * failure is a provider rate-limit / overload. The retry loop itself runs
 * indefinitely for those — only the gap between attempts is bounded.
 */
const PROVIDER_BACKOFF_RETRY_MAX_MS = 15 * 60 * 1000;

/**
 * Inter-attempt delay for verification-step retries. Reuses `nextBackoffDelay`
 * from session-setup so we share one exponential-backoff implementation.
 *
 * - `isBackoff=true` (provider rate-limit / overload): exponential growth
 *   capped at 15 min with ±20% jitter, paired with an unbounded retry loop
 *   in the caller. This delay is deliberately outside the per-active-turn
 *   review allowance; never fold provider waiting into a whole-step deadline.
 * - `isBackoff=false`: legacy 2s/4s/8s schedule (`nextBackoffDelay` with no
 *   cap and no jitter), paired with the legacy 3-attempt bound in the caller.
 */
function verificationRetryDelayMs(attempt: number, isBackoff: boolean): number {
	return isBackoff
		? nextBackoffDelay(attempt, { baseMs: 2000, maxMs: PROVIDER_BACKOFF_RETRY_MAX_MS, jitterRatio: 0.2 })
		: nextBackoffDelay(attempt, { baseMs: 2000 });
}

export const VERIFICATION_WS_STEP_OUTPUT_PREVIEW_BYTES = 16 * 1024;
export const VERIFICATION_WS_STEP_COMPLETE_OUTPUT_PREVIEW_BYTES = 32 * 1024;

function formatByteCount(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function utf8Suffix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(value, "utf8");
	if (buf.byteLength <= maxBytes) return value;
	let start = Math.max(0, buf.byteLength - maxBytes);
	while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) start++;
	return buf.subarray(start).toString("utf8");
}

function truncateVerificationWsText(value: string, maxBytes: number, fieldLabel: string): { text: string; originalBytes: number; truncated: boolean } {
	const originalBytes = Buffer.byteLength(value, "utf8");
	if (originalBytes <= maxBytes) return { text: value, originalBytes, truncated: false };
	const marker = `\n\n[Bobbit: ${fieldLabel} truncated for live WebSocket delivery from ${formatByteCount(originalBytes)} to a bounded preview. Full output remains available via gate inspection/retained diagnostics.]`;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const previewBudget = Math.max(0, maxBytes - markerBytes);
	const text = previewBudget > 0
		? `${utf8Suffix(value, previewBudget)}${marker}`
		: utf8Suffix(marker, maxBytes);
	return { text, originalBytes, truncated: true };
}

export function sanitizeVerificationWsEvent<T>(event: T): T {
	if (!event || typeof event !== "object") return event;
	const e = event as any;
	if (e.type === "gate_verification_step_output" && typeof e.text === "string") {
		const preview = truncateVerificationWsText(e.text, VERIFICATION_WS_STEP_OUTPUT_PREVIEW_BYTES, "verification step output");
		if (!preview.truncated) return event;
		return {
			...e,
			text: preview.text,
			textTruncated: true,
			originalTextBytes: preview.originalBytes,
			previewTextBytes: Buffer.byteLength(preview.text, "utf8"),
		};
	}
	if (e.type === "gate_verification_step_complete" && typeof e.output === "string") {
		const preview = truncateVerificationWsText(e.output, VERIFICATION_WS_STEP_COMPLETE_OUTPUT_PREVIEW_BYTES, "verification step completion output");
		if (!preview.truncated) return event;
		return {
			...e,
			output: preview.text,
			outputTruncated: true,
			originalOutputBytes: preview.originalBytes,
			previewOutputBytes: Buffer.byteLength(preview.text, "utf8"),
		};
	}
	return event;
}

// These fixed start-of-retry grace windows are outside the per-active-turn
// review allowance. They only bound how long a retry turn may take to begin;
// once streaming starts, the retry receives its full resolved allowance.
const REVIEWER_ERRORED_TURN_GRACE_MS = 75_000;
const REVIEWER_PROVIDER_BACKOFF_GRACE_MS = 330_000;
// Reminder-path fairness (see runLlmReviewViaSession). A reviewer that went
// idle without calling verification_result is nudged up to MAX_REVIEWER_REMINDERS
// times. Each nudge gets a fair turn: we wait REVIEWER_REMINDER_STREAM_SETTLE_MS
// for the agent to actually start streaming before racing waitForIdle, and —
// if it did stream this turn — a further REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS
// for an in-flight verdict POST to land before giving up. This restores the
// pre-regression behavior where a reviewer that completed its analysis but
// missed the tool call is re-nudged on the SAME session (preserving its
// context) instead of being torn down after a single under-graced reminder.
const MAX_REVIEWER_REMINDERS = 2;
const REVIEWER_REMINDER_STREAM_SETTLE_MS = 15_000;
const REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS = 20_000;
const MAX_VERIFIER_SAME_SESSION_RESURRECTIONS = 3;

function isRetryableLlmReviewRecovery(output: string): boolean {
	return isTransientReviewError(output) || isRetryableGenericAgentError(output);
}

function isVerifierInfrastructureDisconnectError(output: string): boolean {
	if (!output) return false;
	if (TRANSIENT_INFRA_ERROR_REGEXES.some(re => re.test(output))) return true;
	return /\b(?:ECONNRESET|ENOTCONN|EPIPE|WebSocket error|socket error|socket hang up|connect ECONNREFUSED)\b/i.test(output)
		|| /\b(?:network|internet|connection|wifi|wi-fi)\b.{0,80}\b(?:lost|reset|closed|dropped|disconnected|unavailable|timeout|timed out|failed|error)\b/i.test(output)
		|| /\b(?:lost|reset|closed|dropped|disconnected|unavailable|timeout|timed out|failed|error)\b.{0,80}\b(?:network|internet|connection|wifi|wi-fi)\b/i.test(output);
}

function classifyLlmReviewRecoveryError(output: string): string {
	if (isProviderBackoffError(output)) return "provider-backoff";
	if (isTransientReviewError(output)) return "transient";
	if (isRetryableGenericAgentError(output)) return "generic-runtime";
	if (output.includes("Agent did not call verification_result")) return "missing-verification-result";
	return "deterministic";
}

function reviewerIgnoredReminder(output: string): boolean {
	return output.includes("Agent did not call verification_result after reminder")
		|| output.includes("Agent did not call verification_result after server restart and reminder");
}

function isVerifierProcessDeathMessage(message: string | undefined): boolean {
	if (!message) return false;
	return /\b(?:agent )?process (?:exited|not running|died|terminated)\b/i.test(message)
		|| /\bsession .*terminated\b/i.test(message);
}

async function raceResultWithLateVerdictGrace(
	clock: Clock,
	resultPromise: Promise<VerificationResult>,
	graceMs: number,
): Promise<({ type: "result" } & VerificationResult) | { type: "timeout" }> {
	let timer: ReturnType<Clock["setTimeout"]> | undefined;
	try {
		const timeoutPromise = new Promise<{ type: "timeout" }>(resolve => {
			timer = clock.setTimeout(() => {
				timer = undefined;
				resolve({ type: "timeout" });
			}, graceMs);
			(timer as any)?.unref?.();
		});
		return await Promise.race([
			resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
			timeoutPromise,
		]);
	} finally {
		if (timer) clock.clearTimeout(timer);
	}
}

function appendLlmReviewRecoveryDiagnostics(
	output: string,
	args: { attempts: number; maxBoundedAttempts: number },
): string {
	if (!output || output.includes("## Recovery diagnostics")) return output;
	const retryable = isRetryableLlmReviewRecovery(output);
	const ignoredReminder = reviewerIgnoredReminder(output);
	const exhaustedBoundedRecovery = retryable
		&& !isProviderBackoffError(output)
		&& args.attempts >= args.maxBoundedAttempts;
	if (!exhaustedBoundedRecovery && !ignoredReminder) return output;
	const attemptedRetries = Math.max(0, args.attempts - 1);
	return [
		output,
		"",
		"## Recovery diagnostics",
		`- Attempted retries: ${attemptedRetries}`,
		`- Final error class: ${classifyLlmReviewRecoveryError(output)}`,
		`- Reviewer ignored reminder: ${ignoredReminder ? "yes" : "no"}`,
	].join("\n");
}

export class VerificationHarness {
	private static _warnedCmdExeDetached = false;
	private notifyTeamLeadFn?: (goalId: string, message: string) => void;
	private activeVerifications = new Map<string, ActiveVerification>();
	/** Random UUID generated once per server process. Steps stamped with this bootEpoch were started by this process. */
	private readonly bootEpoch: string = randomUUID();
	private readonly _persistPath: string;
	private projectContextManager: ProjectContextManager | null;
	private surfacedOrphanedNonInteractiveSessionIds = new Set<string>();

	/** Limits concurrent command steps (type-check, tests) across all goals. */
	private commandSemaphore = new Semaphore(4);

	/**
	 * Unified per-root child-team scheduler — THE single authority for the
	 * per-tree concurrency cap across ALL child-team start paths (harness
	 * `runSubgoalStep`, REST `spawn-child`, `POST /api/goals` child creation,
	 * and `integrate-child` dependency auto-unblock). Owns the per-rootGoalId
	 * semaphores (lazy-created via `resolveRootMaxConcurrentChildren`) plus the
	 * capacity-blocked queue. See `child-team-scheduler.ts`. Initialised in the
	 * constructor once `projectContextManager` is wired.
	 */
	private childScheduler!: ChildTeamScheduler;

	/** Override hook for tests so they can stub the spawn/wait/merge sub-steps. */
	_subgoalHooks?: {
		waitForReadyToMerge?: (childGoalId: string, signal: { aborted: boolean }) => Promise<"passed" | "archived-complete" | "archived-other" | "cancelled" | "timeout">;
		setupChildAndStartTeam?: (childGoalId: string) => Promise<void>;
	};


	/** Pending verification_result resolvers keyed by sessionId. */
	public pendingResults = new Map<string, (result: VerificationResult) => void>();

	/**
	 * Pending human-signoff resolvers keyed by `${signalId}::${stepName}`.
	 * Populated when a `human-signoff` step parks and `await`s the user;
	 * drained by `resolveSignoff()` (user decision) or `cancelStaleVerifications()`
	 * (gate re-signaled / goal completed).
	 */
	public pendingSignoffs = new Map<string, (outcome: SignoffOutcome) => void>();

	/**
	 * Resolve a pending human-signoff. Returns `true` if the resolver was
	 * found and invoked, `false` if the step is no longer parked (idempotent
	 * for callers that race with cancellation or a prior resolve).
	 *
	 * The verification harness's own `verifyGateSignal` branch builds the
	 * step result + artifact from the outcome — callers do not write to the
	 * gate store directly.
	 */
	resolveSignoff(signalId: string, stepName: string, outcome: SignoffOutcome): boolean {
		const key = `${signalId}::${stepName}`;
		const resolver = this.pendingSignoffs.get(key);
		if (!resolver) return false;
		this.pendingSignoffs.delete(key);
		const active = this.activeVerifications.get(signalId);
		const step = active?.steps.find(s => s.name === stepName);
		if (step?.awaitingHuman) {
			step.awaitingHuman = false;
			this._persistActive();
		}
		try { resolver(outcome); } catch (err) {
			console.error(`[verification] resolveSignoff resolver threw for ${key}:`, err);
		}
		return true;
	}

	/**
	 * @deprecated The verification_result tool is now registered via the standard
	 * goal tools extension. No generated extension file needed.
	 */

	/** Get all active (in-flight) verifications, optionally filtered by goalId */
	getActiveVerifications(goalId?: string): ActiveVerification[] {
		const all = [...this.activeVerifications.values()].filter(v => !v.cancelled && v.overallStatus !== "cancelled");
		return goalId ? all.filter(v => v.goalId === goalId) : all;
	}

	/**
	 * Look up the active verification entry for a single signal id. Used by
	 * the gate_signal REST handler to read back the `startedAt` stamped by
	 * `beginVerification` so it can emit `gate_verification_started` AFTER
	 * its own `gate_signal_received` broadcast. See goal
	 * "Fix WS event ordering: signal_received must precede verification_started".
	 */
	getActiveVerification(signalId: string): ActiveVerification | undefined {
		const active = this.activeVerifications.get(signalId);
		return active && !active.cancelled && active.overallStatus !== "cancelled" ? active : undefined;
	}

	/**
	 * Synchronously enumerate verification steps and seed the activeVerifications
	 * map for `signal.id`. Returns the `GateSignalStep[]` shaped exactly for the
	 * caller to write into `signal.verification.steps` *before* invoking
	 * `gateStore.recordSignal(signal)`.
	 *
	 * Why this exists: the gate_signal REST handler used to create the signal
	 * with `steps: []`, record it, and then fire-and-forget `verifyGateSignal()`
	 * which built the active entry several `await`s later. Between `recordSignal`
	 * and that async write, any consumer reading the gate-store or
	 * `getActiveVerifications()` saw an empty step list — a race window of
	 * 15-30s on multi-step gates with verification-harness setup cost. By
	 * splitting enumeration (synchronous, cheap) from execution (async,
	 * expensive) and inlining the enumeration into the REST handler before
	 * `recordSignal`, both stores agree from the very first persisted state.
	 *
	 * Returns an empty array for gates with no `verify[]` steps — the caller
	 * should still record the signal and `verifyGateSignal` will auto-pass it.
	 *
	 * Idempotent: calling twice for the same signal returns the same enumeration
	 * without re-stamping `startedAt`.
	 *
	 * Does NOT broadcast `gate_verification_started` — the caller must emit
	 * that event AFTER its own `gate_signal_received` broadcast to preserve
	 * WS event ordering. See goal "Fix WS event ordering: signal_received
	 * must precede verification_started".
	 */
	beginVerification(signal: GateSignal, gate: WorkflowGate): GateSignalStep[] {
		const steps = gate.verify;
		if (!steps || steps.length === 0) return [];

		const existing = this.activeVerifications.get(signal.id);
		if (existing) {
			return existing.steps.map(s => ({
				name: s.name,
				type: s.type as GateSignalStep["type"],
				passed: false,
				output: "",
				duration_ms: 0,
				status: s.status,
				phase: s.phase,
			}));
		}

		const verificationStartedAt = Date.now();
		const minPhase = Math.min(...steps.map(s => s.phase ?? 0));
		const active: ActiveVerification = {
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
			steps: steps.map(s => {
				const phase = s.phase ?? 0;
				return {
					name: s.name,
					type: s.type,
					status: (phase === minPhase ? "running" : "waiting") as "running" | "waiting",
					phase,
					startedAt: verificationStartedAt,
				};
			}),
			overallStatus: "running",
			startedAt: verificationStartedAt,
		};
		this.activeVerifications.set(signal.id, active);
		this._persistActive();

		return steps.map(s => {
			const phase = s.phase ?? 0;
			const status: "running" | "waiting" = phase === minPhase ? "running" : "waiting";
			return {
				name: s.name,
				type: s.type as GateSignalStep["type"],
				passed: false,
				output: "",
				duration_ms: 0,
				status,
				phase,
			};
		});
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
		if (!active || active.cancelled || active.overallStatus === "cancelled") return false;
		// If any step is still waiting to start, the verification is not a zombie
		if (active.steps.some(s => s.status === "waiting")) return true;
		for (const step of active.steps) {
			if (step.status !== "running") continue;
			// human-signoff steps are alive while parked on user input — they have
			// no session/pid but are legitimately running, not a zombie.
			if (step.awaitingHuman) return true;
			if (step.sessionId) {
				// LLM/agent steps — check if session is still alive
				const session = this.sessionManager?.getSession(step.sessionId);
				if (session) return true;
				continue;
			}
			// Command step: alive when THIS process started it (bootEpoch match).
			// A just-started step may not have stamped its pid yet — that startup
			// window is not a zombie, so a current-boot running step is treated as
			// alive until its pid is known dead. Persisted-running steps from a
			// previous server lifetime have no bootEpoch match and are treated as
			// dead so duplicate-detection / stale-reconcile can reclaim the gate.
			if (step.bootEpoch === this.bootEpoch) {
				if (typeof step.pid !== "number") return true; // pid not yet stamped — starting, not dead
				if (isPidAlive(step.pid)) return true;
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
			// When there is nothing active, remove the persist file entirely rather
			// than writing an empty `{ verifications: [] }`. This unifies the "clear"
			// semantics with resumeInterruptedVerifications() (which unlinks) so two
			// concurrent harnesses sharing a stateDir cannot race between unlink and
			// empty-file-write. Best-effort unlink so concurrent unlinks don't throw.
			if (this.activeVerifications.size === 0) {
				try { fs.unlinkSync(this._persistPath); } catch {}
				return;
			}
			const data = { verifications: [...this.activeVerifications.values()] };
			// Defensive: ensure parent dir exists. It is created at startup but may
			// be removed mid-run by external cleanup (test teardown, maintenance,
			// AV quirks). Recreating on demand keeps persistence robust.
			const dir = path.dirname(this._persistPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const tmp = path.join(dir, `${path.basename(this._persistPath)}.${process.pid}.${Date.now()}.tmp`);
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
			try {
				const fd = fs.openSync(tmp, "r");
				try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			} catch { /* best-effort durability; rename still prevents torn JSON */ }
			fs.renameSync(tmp, this._persistPath);
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
		// Surface orphaned reviewers before resuming unrelated active verifications.
		// A resumed reviewer can wait minutes for a busy turn to settle; reviewers
		// absent from active verification context should not be hidden behind that
		// sequential recovery path.
		await this._surfaceOrphanedNonInteractiveReviewers();
		if (persisted.length === 0) {
			return;
		}

		const cancelled = persisted.filter(v => v.cancelled || v.overallStatus === "cancelled");
		for (const v of cancelled) {
			const active = this.activeVerifications.get(v.signalId) ?? v;
			active.cancelled = true;
			active.overallStatus = "cancelled";
			this.activeVerifications.set(active.signalId, active);
			const settled = await this._killPersistedCommandSteps(active, "SIGKILL", { waitForIdentity: true, markIntent: true, reason: "cancelled" });
			if (settled) {
				if (this.activeVerifications.get(active.signalId) === active) this.activeVerifications.delete(active.signalId);
			} else {
				this._scheduleCommandKillCleanupRetry(active.signalId);
			}
			this._persistActive();
		}

		const running = persisted.filter(v => v.overallStatus === "running" && !v.cancelled);
		if (running.length === 0) {
			// Clean up stale file only after cancelled kill intents are settled.
			if (this.activeVerifications.size === 0) {
				try { fs.unlinkSync(this._persistPath); } catch {}
			} else {
				this._persistActive();
			}
			return;
		}

		if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resuming ${running.length} interrupted verification(s)...`);

		for (const v of running) {
			this.activeVerifications.set(v.signalId, v);
			this._persistActive();
			try {
				// Skip verifications for goals that completed/shelved while we were down
				const goal = this.projectContextManager?.getContextForGoal(v.goalId)?.goalStore.get(v.goalId);
				if (goal && (goal.state === "complete" || goal.state === "shelved")) {
					if (process.env.BOBBIT_DEBUG) console.log(`[verification] Skipping resume for ${v.signalId} — goal ${v.goalId} is ${goal.state}`);
					this.activeVerifications.delete(v.signalId);
					this._persistActive();
					continue;
				}
				await this._resumeOneVerification(v);
			} catch (err) {
				const errMsg = (err as Error).message;
				if (!this._isResumeStillActive(v)) {
					if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resume of ${v.signalId} stopped after cancellation/supersession: ${errMsg}`);
					continue;
				}
				if (isPendingCommandCleanupError(err)) {
					console.warn(`[verification] Resume of ${v.signalId} is waiting for command cleanup before finalizing: ${errMsg}`);
					this._scheduleCommandKillCleanupRetry(v.signalId);
				} else if (isRestartInterruptError(errMsg)) {
					// A restart-induced resume error (cold-agent RPC timeout, agent
					// process not yet up) must NEVER surface as a hard gate failure.
					// Leave the gate `pending` so the team-lead re-signals, and send
					// the benign nudge (mirrors the suppression path in
					// `_resumeOneVerification`). Persist an honest audit record but keep
					// the GATE status `pending`.
					console.warn(`[verification] Resume of ${v.signalId} hit a restart-interrupt error (gate left pending): ${errMsg}`);
					try {
						this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
							status: "failed",
							steps: [{ name: "Resume Interrupted", type: "command", passed: false, status: "failed", phase: 0, output: `Reviewer agent was not ready / timed out while resuming after server restart: ${errMsg}`, duration_ms: 0 }],
						});
						this.resolveGateStore(v.goalId).updateGateStatus(v.goalId, v.gateId, "pending");
					} catch (storeErr) {
						console.error(`[verification] Failed to update gate store for ${v.signalId} during restart-interrupt cleanup:`, storeErr);
					}
					try {
						broadcastGateStatusChanged(this.broadcastFn, v.goalId, v.gateId, "pending");
						this.notifyTeamLeadFn?.(
							v.goalId,
							`Gate verification on "${v.gateId}" was interrupted by a server restart and could not be recovered. Please re-signal the gate to run a fresh verification — no real failure was observed.`,
						);
					} catch (bcastErr) {
						console.error(`[verification] Failed to broadcast restart-interrupt for ${v.signalId}:`, bcastErr);
					}
				} else {
					console.error(`[verification] Failed to resume verification ${v.signalId}:`, err);
					// Best-effort: mark as failed. Wrap each external store call in
					// try/catch so a missing goal/gate doesn't stop us from cleaning
					// up the in-memory entry below (HTTP 409 lock-after-restart bug).
					try {
						this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
							status: "failed",
							steps: [{ name: "Resume Error", type: "command", passed: false, status: "failed", phase: 0, output: `Failed to resume after restart: ${errMsg}`, duration_ms: 0 }],
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
						broadcastGateStatusChanged(this.broadcastFn, v.goalId, v.gateId, "failed");
						this.notifyTeamLead(v.goalId, v.gateId, "failed");
					} catch (bcastErr) {
						console.error(`[verification] Failed to broadcast failure for ${v.signalId} during resume cleanup:`, bcastErr);
					}
				}
			} finally {
				// Drop only the entry this resume owns. If a cancellation/re-signal
				// already removed it (or a future path replaced it), do not clobber
				// that newer active state. A timeout/cancel kill intent that has not
				// been verified complete must remain durable for retry after restart.
				if (this.activeVerifications.get(v.signalId) === v && !this._hasPendingCommandKillCleanup(v)) {
					this.activeVerifications.delete(v.signalId);
				}
				this._persistActive();
			}
		}

		if (this.activeVerifications.size === 0) {
			try { fs.unlinkSync(this._persistPath); } catch {}
		} else {
			this._persistActive();
		}
		await this._surfaceOrphanedNonInteractiveReviewers();
		if (process.env.BOBBIT_DEBUG) console.log("[verification] Finished resuming interrupted verifications.");
	}

	/**
	 * Surface live nonInteractive reviewer sessions that are not covered by any
	 * active verification context. They cannot accept user prompts, and any late
	 * `verification_result` would be ignored because no pending result resolver
	 * exists, so boot must make them visible deterministically instead of leaving
	 * them to a long timeout path.
	 */
	private async _surfaceOrphanedNonInteractiveReviewers(): Promise<void> {
		const sm = this.sessionManager as any;
		if (!sm?.listOrphanedNonInteractiveSessions) return;
		let orphans: Array<{ id: string; title: string; createdAt: number }> = [];
		try {
			orphans = await sm.listOrphanedNonInteractiveSessions();
		} catch (err) {
			console.warn("[verification] Failed to inspect orphaned nonInteractive reviewer sessions:", err);
			return;
		}
		orphans = orphans.filter(o => !this.surfacedOrphanedNonInteractiveSessionIds.has(o.id));
		if (orphans.length === 0) return;
		for (const orphan of orphans) this.surfacedOrphanedNonInteractiveSessionIds.add(orphan.id);
		const summary = orphans
			.map(o => `${o.title || "Untitled"} (${o.id}, created ${new Date(o.createdAt).toISOString()})`)
			.join("; ");
		console.warn(
			`[verification] Found ${orphans.length} live nonInteractive reviewer session(s) without active verification context: ${summary}. ` +
			"They are not harness-resumable; use maintenance orphan cleanup to terminate them if they are stale.",
		);
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
		goalBranch?: string;
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
		const [baseBranch, legacyMasterBranch] = await Promise.all([
			this.resolveVerificationBaseBranch(goalId, cwd),
			this.resolveLegacyMasterBranch(cwd),
		]);
		const builtinVars: Record<string, string> = {
			branch: goal.branch || "HEAD",
			baseBranch,
			master: legacyMasterBranch,
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

		return { signal, cwd, builtinVars, goalSpec: goal.spec, goalBranch: goal.branch, allGateStates, gate: rerunGate };
	}

	private _updateActiveStepFromResumedResult(v: ActiveVerification, step: ActiveVerification["steps"][number], result: ResumedVerificationStep): void {
		const stepIndex = v.steps.indexOf(step);
		if (stepIndex < 0) return;
		const status = persistedStatusForStep(result);
		Object.assign(v.steps[stepIndex], {
			status,
			phase: result.phase ?? step.phase ?? 0,
			durationMs: result.duration_ms,
			output: result.output,
			timeout: result.timeout,
			sessionId: step.sessionId,
		});
		if (status === "skipped") v.steps[stepIndex].output = result.output || "Skipped — earlier phase failed";
		this._persistActive();
		if (status === "waiting" || status === "running") return;
		this.broadcastFn(v.goalId, {
			type: "gate_verification_step_complete",
			goalId: v.goalId,
			gateId: v.gateId,
			signalId: v.signalId,
			stepIndex,
			stepName: result.name,
			status,
			durationMs: result.duration_ms,
			output: result.output,
			timeout: result.timeout,
			phase: result.phase ?? step.phase ?? 0,
		});
	}

	private async _continueResumeWithRemainingPhases(v: ActiveVerification): Promise<boolean> {
		const ctx = await this._gatherRerunContext(v.goalId, v.gateId, v.signalId);
		if (!ctx?.signal || !ctx.gate) return false;
		if (!this._isResumeStillActive(v)) return true;
		await this.verifyGateSignal(ctx.signal, ctx.gate, ctx.cwd, ctx.goalBranch, undefined, ctx.allGateStates, ctx.goalSpec);
		return true;
	}

	private async _resumeOneVerification(v: ActiveVerification): Promise<void> {
		if (!this._isResumeStillActive(v)) return;
		const resolvedSteps: ResumedVerificationStep[] = [];

		for (const step of v.steps) {
			if (!this._isResumeStillActive(v)) return;
			if (step.status !== "running") {
				// Already completed before restart — keep result
				// Skipped steps (optional or phase-skipped) count as passed for overall verdict
				resolvedSteps.push({
					name: step.name,
					type: step.type,
					passed: step.status === "passed" || step.status === "skipped",
					...(step.status === "skipped" ? { skipped: true } : {}),
					status: step.status,
					phase: step.phase ?? 0,
					output: step.output || "",
					duration_ms: step.durationMs || 0,
					timeout: step.timeout,
				});
				continue;
			}

			// human-signoff resume — the verification was parked waiting on a
			// human decision when the server restarted. Re-create the resolver,
			// re-broadcast `gate_verification_awaiting_human` so any connected UI
			// rehydrates the pending request, and await the user's decision
			// inline. The persisted humanPrompt / humanLabel survive the restart.
			if (step.type === "human-signoff" && step.awaitingHuman) {
				const stepIndex = v.steps.indexOf(step);
				const prompt = step.humanPrompt || "";
				const label = step.humanLabel || step.name;
				this.broadcastFn(v.goalId, {
					type: "gate_verification_awaiting_human",
					goalId: v.goalId, gateId: v.gateId, signalId: v.signalId,
					stepIndex, stepName: step.name,
					label, prompt,
				});
				const key = `${v.signalId}::${step.name}`;
				const { promise, resolve: resolver } = deferred<SignoffOutcome>();
				this.pendingSignoffs.set(key, resolver);
				const outcome = await promise;
				this.pendingSignoffs.delete(key);
				if (!this._isResumeStillActive(v)) return;
				let passed: boolean;
				let output: string;
				if ("decision" in outcome) {
					const fb = outcome.feedback?.trim();
					passed = outcome.decision === "pass";
					output = passed
						? (fb ? `Approved.\n\n${fb}` : "Approved.")
						: (fb ? `Rejected.\n\n${fb}` : "Rejected.");
				} else {
					passed = false; output = "Sign-off cancelled.";
				}
				const av = this.activeVerifications.get(v.signalId);
				if (av && av.steps[stepIndex]) {
					av.steps[stepIndex].awaitingHuman = false;
					this._persistActive();
				}
				const signedOffStep: ResumedVerificationStep = {
					name: step.name, type: step.type,
					passed,
					status: passed ? "passed" : "failed",
					phase: step.phase ?? 0,
					output,
					duration_ms: Date.now() - step.startedAt,
				};
				resolvedSteps.push(signedOffStep);
				this._updateActiveStepFromResumedResult(v, step, signedOffStep);
				continue;
			}

			// Step was running — for command-type steps, try the file-based
			// (Layer 1) resume path; for session-backed steps, re-attach to the
			// restored reviewer session as before.
			let resumeResult = step.type === "command"
				? await this._resumeCommandStep(v, step)
				: await this._tryResumeFromSession(v, step);
			if (!this._isResumeStillActive(v)) return;

			// If resume failed with a transient error and this is an llm-review or agent-qa step,
			// re-run from scratch rather than giving up. A COLD reviewer that missed
			// the readiness window after a restart (session lost / not-ready / RPC
			// timeout) is also re-runnable — deterministically re-run it from
			// scratch instead of leaving it a terminal "could not be recovered"
			// restart-interrupt (shouldRerunSessionStepOnResume).
			const isTransient = step.type === "agent-qa"
					? isTransientQaError(resumeResult?.output || "")
					: isRetryableLlmReviewRecovery(resumeResult?.output || "");
			const rerunnable = resumeResult?.status !== "timeout"
				&& (isTransient || shouldRerunSessionStepOnResume(resumeResult?.output || ""));
			if (resumeResult && !resumeResult.passed && (step.type === "llm-review" || step.type === "agent-qa") && rerunnable) {
				console.log(`[verification] Resume failed transiently for "${step.name}", re-running from scratch...`);
				let rerunResult: typeof resumeResult | null = null;
				if (step.type === "agent-qa") {
					rerunResult = await this._rerunAgentQaStep(v.goalId, v.gateId, v.signalId, step.name);
				} else {
					rerunResult = await this._rerunLlmReviewStep(v.goalId, v.gateId, v.signalId, step.name);
				}
				if (!this._isResumeStillActive(v)) return;
				if (rerunResult) {
					resumeResult = rerunResult;
				}
				// If rerun context unavailable, fall through with the original transient failure
			}

			if (resumeResult) {
				const resumedStep = { ...resumeResult, status: persistedStatusForStep(resumeResult), phase: step.phase ?? 0 };
				resolvedSteps.push(resumedStep);
				this._updateActiveStepFromResumedResult(v, step, resumedStep);
			} else {
				// No session and not an llm-review — cannot recover
				resolvedSteps.push({
					name: step.name,
					type: step.type,
					passed: false,
					status: "failed",
					phase: step.phase ?? 0,
					output: "Step was running but had no session ID — cannot resume after restart.",
					duration_ms: Date.now() - step.startedAt,
				});
			}
		}

		const firstRealFailedPhase = resolvedSteps.reduce<number | undefined>((earliest, step) => {
			if (step.passed || step.skipped) return earliest;
			const status = persistedStatusForStep(step);
			if (status !== "failed" && status !== "timeout") return earliest;
			if (isExplicitRestartInterruptedStep(step)) return earliest;
			const phase = step.phase ?? 0;
			return earliest === undefined || phase < earliest ? phase : earliest;
		}, undefined);
		const firstRestartInterruptedPhase = firstRealFailedPhase === undefined
			? resolvedSteps.reduce<number | undefined>((earliest, step) => {
				// Empty waiting rows are never-run downstream placeholders. They are
				// not themselves restart interruptions; after recovered success they
				// must execute via normal phase semantics.
				if (step.status === "waiting" && !step.output.trim()) return earliest;
				if (step.passed || step.skipped || !isExplicitRestartInterruptedStep(step)) return earliest;
				const phase = step.phase ?? 0;
				return earliest === undefined || phase < earliest ? phase : earliest;
			}, undefined)
			: undefined;

		if (firstRealFailedPhase !== undefined) {
			for (const step of resolvedSteps) {
				const phase = step.phase ?? 0;
				if (step.status === "waiting" && phase > firstRealFailedPhase) {
					step.passed = true;
					step.skipped = true;
					step.status = "skipped";
					step.output = "Skipped — earlier phase failed";
					step.duration_ms = 0;
				}
			}
		} else if (firstRestartInterruptedPhase !== undefined) {
			for (const step of resolvedSteps) {
				const phase = step.phase ?? 0;
				if (step.status === "waiting" && phase > firstRestartInterruptedPhase && !step.output.trim()) {
					step.output = "Step was interrupted by server restart before this phase could run.";
				}
			}
		} else if (resolvedSteps.some(step => step.status === "waiting")) {
			if (await this._continueResumeWithRemainingPhases(v)) return;
		}

		if (!this._isResumeStillActive(v)) return;

		// Compute overall result
		const allPassed = computeAllPassed(resolvedSteps as GateSignalStep[]);

		// Restart-interrupt suppression. If every failed step is an explicit
		// command no-verdict row or a reviewer/QA restart interruption, don't mark
		// the gate failed — the work being verified hasn't actually been judged.
		// Persist the verification record honestly
		// (so `gate_status` reflects what really happened) but leave the gate
		// `pending` so a re-signal will run a fresh verification.
		//
		// Predicate is conjunctive: a single real failure poisons the gate
		// (real failures should still surface as failed even if some sibling
		// steps got restart-interrupted).
		const suppressedByRestart = !allPassed && shouldSuppressExplicitRestartInterrupt(resolvedSteps);
		const persistedStatus = allPassed ? "passed" as const : "failed" as const;
		const gateStatus = suppressedByRestart ? "pending" as const : persistedStatus;

		if (!this._isResumeStillActive(v)) return;

		this.resolveGateStore(v.goalId).updateSignalVerification(v.signalId, {
			status: persistedStatus,
			steps: resolvedSteps.map(r => {
				const status = persistedStatusForStep(r);
				const stepResult = {
					name: r.name,
					type: r.type as "command" | "llm-review" | "agent-qa" | "human-signoff",
					passed: r.passed,
					...(status === "skipped" ? { skipped: true } : {}),
					status,
					phase: r.phase ?? 0,
					output: r.output,
					duration_ms: r.duration_ms,
					...(r.timeout ? { timeout: r.timeout } : {}),
				} as GateSignalStep;
				if (r.diagnostics) stepResult.diagnostics = r.diagnostics;
				return stepResult;
			}),
		});
		this.resolveGateStore(v.goalId).updateGateStatus(v.goalId, v.gateId, gateStatus);

		this.broadcastFn(v.goalId, {
			type: "gate_verification_complete",
			goalId: v.goalId, gateId: v.gateId, signalId: v.signalId, status: persistedStatus,
		});
		broadcastGateStatusChanged(this.broadcastFn, v.goalId, v.gateId, gateStatus);
		if (suppressedByRestart) {
			// Benign nudge — the team-lead should re-signal, not investigate a
			// phantom regression. notifyTeamLead is keyed off the gate status
			// string so we send a custom message rather than the standard one.
			if (this.notifyTeamLeadFn) {
				this.notifyTeamLeadFn(
					v.goalId,
					`Gate verification on "${v.gateId}" was interrupted by a server restart and could not be recovered. Please re-signal the gate to run a fresh verification — no real failure was observed.`,
				);
			}
			if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resumed verification ${v.signalId}: failed steps were all restart-interrupts; gate left pending.`);
		} else {
			const goalBranch = this.projectContextManager?.getContextForGoal(v.goalId)?.goalStore.get(v.goalId)?.branch;
			this.notifyTeamLead(v.goalId, v.gateId, persistedStatus, { steps: resolvedSteps, goalBranch });
			if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resumed verification ${v.signalId}: ${persistedStatus}`);
		}
	}

	/**
	 * Try to resume an llm-review step from its existing session.
	 * Returns the step result, or null if no session exists.
	 */
	private async _tryResumeFromSession(
		v: ActiveVerification,
		step: ActiveVerification["steps"][number],
	): Promise<ResumedVerificationStep | null> {
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

		const frozenStep = this._findStepDefinition(v.goalId, v.gateId, step.name);
		const timeoutSec = typeof step.timeoutSec === "number" && Number.isFinite(step.timeoutSec) && step.timeoutSec > 0
			? Math.max(MIN_LLM_REVIEW_TIMEOUT_S, Math.floor(step.timeoutSec))
			: frozenStep && (frozenStep.type === "llm-review" || frozenStep.type === "agent-qa")
				? this._resolveReviewStepTimeoutSec(v.goalId, frozenStep)
				: DEFAULT_LLM_REVIEW_TIMEOUT_S;
		const timeoutMs = timeoutSec * 1000;
		step.timeoutSec = timeoutSec;
		this._persistActive();
		const timeoutStep = (elapsedMs: number): ResumedVerificationStep => ({
			name: step.name,
			type: step.type,
			passed: false,
			status: "timeout",
			timeout: { configuredSeconds: timeoutSec, elapsedMs },
			output: `${step.type === "agent-qa" ? "Agent QA" : "LLM review"} timed out after ${timeoutSec}s.`,
			duration_ms: Date.now() - step.startedAt,
		});

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
			const restartInterruptedTurn = session.restoreStartupWasStreaming === true;
			// If restoreSession already revived the reviewer to idle, prompt it
			// immediately. Otherwise wait for the active turn to finish before sending
			// a prompt, so the harness remains the only driver for nonInteractive
			// reviewers and never races the generic restoreSession boot prompt. A
			// restart-interrupted reviewer gets continuation instructions as its first
			// post-restart prompt; the generic idle-without-result reminder remains for
			// ordinary resumed sessions.
			const idleResult = session.status === "idle"
				? ({ type: "idle" as const })
				: await this.waitForReviewTurn(step.sessionId, resultPromise, timeoutMs);

			if (idleResult.type === "result") {
				await this.sessionManager!.waitForIdle(step.sessionId, 30_000).catch(() => {});
				return {
					name: step.name, type: step.type,
					passed: idleResult.verdict,
					output: idleResult.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}
			if (idleResult.type === "timeout") return timeoutStep(idleResult.elapsedMs);

			const recoveryResult = await this.waitForReviewerErroredTurnRecovery(step.sessionId, resultPromise, timeoutMs, step.name);
			if (recoveryResult.type === "result") {
				await this.sessionManager!.waitForIdle(step.sessionId, 30_000).catch(() => {});
				return {
					name: step.name, type: step.type,
					passed: recoveryResult.verdict,
					output: recoveryResult.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}
			if (recoveryResult.type === "timeout") return timeoutStep(recoveryResult.elapsedMs);
			if (recoveryResult.type === "errored") {
				return {
					name: step.name, type: step.type,
					passed: false,
					output: recoveryResult.output,
					duration_ms: Date.now() - step.startedAt,
				};
			}

			// Agent went idle without calling verification_result — inspect whether
			// the previous turn hit a JSON / tool-argument validation glitch, and
			// send a targeted nudge if so. If this was the first post-restart prompt
			// after an interrupted turn, send restart-aware continuation instructions
			// instead of the generic idle-without-result reminder.
			const jsonErr = lastErroredToolOutput ? detectJsonValidationError(lastErroredToolOutput) : null;
			const useRestartContinuationPrompt = restartInterruptedTurn && !jsonErr;
			const reminderPrompt = jsonErr
				? buildJsonRetryPrompt(jsonErr)
				: useRestartContinuationPrompt
					? VERIFICATION_RESTART_RESUME_PROMPT
					: VERIFICATION_RESULT_REMINDER;
			const reminderKind = jsonErr ? "JSON-retry" : useRestartContinuationPrompt ? "restart-resume" : "generic";
			console.log(`[verification] No verification_result from resumed session ${step.sessionId}, sending ${reminderKind} reminder...`);
			// A freshly-revived reviewer is COLD (model init + MCP extension load),
			// often needing 30-90s to first respond — worse under 5-way parallel
			// session restore. So (1) wait for the agent to become ready before
			// prompting and (2) use a generous prompt timeout, instead of letting
			// `prompt()` reject with the 30s-default `Command timed out: prompt`.
			//
			// If the agent can't be reached (still cold / process gone / RPC
			// timeout), DO NOT throw: a restart-interrupt must never surface as a
			// hard gate failure. Return a step whose output is BOTH transient (so
			// `_resumeOneVerification` routes it into `_rerunLlmReviewStep`) AND a
			// restart-interrupt marker (so resume suppression leaves the gate
			// `pending` when the rerun context is unavailable).
			let reminderStarted = false;
			try {
				await dispatchTrackedSystemPrompt(session, reminderPrompt, {
					source: "verification",
					whenReady: true,
					now: () => this.clock.now(),
				});
				// Reminder dispatch is fire-and-forget on the RPC channel; the session
				// stays `idle` for a tick before transitioning to `streaming`. This fixed
				// settle is outside the fresh active-turn allowance.
				reminderStarted = await this.sessionManager!.waitForStreaming(step.sessionId, 10_000).then(() => true).catch(() => false);
			} catch (resumeErr) {
				const msg = (resumeErr as Error)?.message || String(resumeErr);
				console.warn(`[verification] Resume reminder for ${step.sessionId} could not reach the revived reviewer (treating as restart-interrupt): ${msg}`);
				return {
					name: step.name, type: step.type, passed: false,
					output: `Reviewer agent was not ready / timed out while resuming after server restart: ${msg}`,
					duration_ms: Date.now() - step.startedAt,
				};
			}

			const result2 = reminderStarted
				? await this.waitForReviewTurn(step.sessionId, resultPromise, timeoutMs)
				: ({ type: "idle" as const });

			if (result2.type === "result") {
				return {
					name: step.name, type: step.type,
					passed: result2.verdict,
					output: result2.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}
			if (result2.type === "timeout") return timeoutStep(result2.elapsedMs);

			const postReminderRecovery = await this.waitForReviewerErroredTurnRecovery(step.sessionId, resultPromise, timeoutMs, step.name);
			if (postReminderRecovery.type === "result") {
				return {
					name: step.name, type: step.type,
					passed: postReminderRecovery.verdict,
					output: postReminderRecovery.summary,
					duration_ms: Date.now() - step.startedAt,
				};
			}
			if (postReminderRecovery.type === "timeout") return timeoutStep(postReminderRecovery.elapsedMs);
			if (postReminderRecovery.type === "errored") {
				return {
					name: step.name, type: step.type,
					passed: false,
					output: postReminderRecovery.output,
					duration_ms: Date.now() - step.startedAt,
				};
			}

			// The restart-aware continuation prompt is only the first post-restart
			// prompt. If that continuation turn ends without verification_result,
			// fall back to the normal idle-without-result reminder (or JSON retry if
			// the continuation turn exposed a tool-argument validation error) and give
			// that reminder the same fair start/idle window before hard failure.
			if (useRestartContinuationPrompt) {
				const fallbackJsonErr = lastErroredToolOutput ? detectJsonValidationError(lastErroredToolOutput) : null;
				const fallbackPrompt = fallbackJsonErr ? buildJsonRetryPrompt(fallbackJsonErr) : VERIFICATION_RESULT_REMINDER;
				const fallbackKind = fallbackJsonErr ? "JSON-retry" : "generic";
				console.log(`[verification] Restart continuation for resumed session ${step.sessionId} ended without verification_result, sending ${fallbackKind} fallback reminder...`);
				let fallbackStarted = false;
				try {
					await dispatchTrackedSystemPrompt(session, fallbackPrompt, {
						source: "verification",
						whenReady: true,
						now: () => this.clock.now(),
					});
					fallbackStarted = await this.sessionManager!.waitForStreaming(step.sessionId, 10_000).then(() => true).catch(() => false);
				} catch (resumeErr) {
					const msg = (resumeErr as Error)?.message || String(resumeErr);
					console.warn(`[verification] Post-continuation fallback reminder for ${step.sessionId} could not reach the revived reviewer: ${msg}`);
					return {
						name: step.name, type: step.type, passed: false,
						output: `Reviewer agent was not ready / timed out while sending post-continuation reminder after server restart: ${msg}`,
						duration_ms: Date.now() - step.startedAt,
					};
				}

				const fallbackResult = fallbackStarted
					? await this.waitForReviewTurn(step.sessionId, resultPromise, timeoutMs)
					: ({ type: "idle" as const });

				if (fallbackResult.type === "result") {
					return {
						name: step.name, type: step.type,
						passed: fallbackResult.verdict,
						output: fallbackResult.summary,
						duration_ms: Date.now() - step.startedAt,
					};
				}
				if (fallbackResult.type === "timeout") return timeoutStep(fallbackResult.elapsedMs);

				const postFallbackRecovery = await this.waitForReviewerErroredTurnRecovery(step.sessionId, resultPromise, timeoutMs, step.name);
				if (postFallbackRecovery.type === "result") {
					return {
						name: step.name, type: step.type,
						passed: postFallbackRecovery.verdict,
						output: postFallbackRecovery.summary,
						duration_ms: Date.now() - step.startedAt,
					};
				}
				if (postFallbackRecovery.type === "timeout") return timeoutStep(postFallbackRecovery.elapsedMs);
				if (postFallbackRecovery.type === "errored") {
					return {
						name: step.name, type: step.type,
						passed: false,
						output: postFallbackRecovery.output,
						duration_ms: Date.now() - step.startedAt,
					};
				}
			}

			return {
				name: step.name, type: step.type,
				passed: false,
				output: "Agent did not call verification_result after server restart and reminder.",
				duration_ms: Date.now() - step.startedAt,
			};
		} finally {
			try { errListenerUnsub(); } catch { /* ignore */ }
			// Terminate BEFORE deleting the pending resolver so a verdict POST
			// racing teardown is still captured, not 404-dropped (see the
			// delete-vs-late-POST fix in runLlmReviewViaSession).
			try { await this.sessionManager!.terminateSession(step.sessionId); } catch { /* ignore */ }
			this.pendingResults.delete(step.sessionId);
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
	): Promise<ResumedVerificationStep | null> {
		if (this.skipLlmReview) {
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
		// Mirror the main verification loop: bounded 3 attempts for ordinary
		// transient errors, unbounded retry for provider rate-limit / overload.
		const maxBoundedAttempts = 3;
		let result: ReviewStepExecutionResult = { passed: false, output: "Re-run failed." };
		let finalAttempt = 0;

		// Resolve project vars and substitute the prompt template
		const projectConfigStore = this.resolveProjectConfigStore(goalId);
		const projectVars: Record<string, string> = projectConfigStore
			? projectConfigStore.getWithDefaults()
			: {};
		const agentVars: Record<string, string> = ctx.signal.metadata || {};
		const prompt = this.substituteVars(stepDef.prompt || "", ctx.builtinVars, projectVars, agentVars, ctx.allGateStates);

		for (let attempt = 1; ; attempt++) {
			finalAttempt = attempt;
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
			if (result.status === "timeout") break;
			const decision = shouldRetryVerificationStep({
				passed: result.passed, output: result.output,
				attempt, maxBoundedAttempts,
				isTransient: isTransientReviewError,
			});
			if (decision === "break") break;
			const isBackoff = isProviderBackoffError(result.output);
			const delayMs = verificationRetryDelayMs(attempt, isBackoff);
			const attemptLabel = isBackoff ? `attempt ${attempt}, provider backoff — unbounded` : `attempt ${attempt}/${maxBoundedAttempts}`;
			console.log(`[verification] Re-run "${stepName}" failed transiently (${attemptLabel}), retrying in ${Math.round(delayMs / 1000)}s...`);
			await this._sleepCancellable(delayMs, () => {
				const g = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
				return !!(g && (g.state === "complete" || g.state === "shelved"));
			});
		}

		return {
			name: stepName, type: "llm-review",
			passed: result.passed,
			status: result.status,
			timeout: result.timeout,
			output: result.passed || result.status === "timeout" ? result.output : appendLlmReviewRecoveryDiagnostics(result.output, { attempts: finalAttempt, maxBoundedAttempts }),
			duration_ms: Date.now() - startedAt,
		};
	}

	/**
	 * Re-run an agent-qa step from scratch — used when resume fails transiently.
	 */
	private async _rerunAgentQaStep(
		goalId: string, gateId: string, signalId: string, stepName: string,
	): Promise<ResumedVerificationStep | null> {
		if (this.skipLlmReview) {
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

		// QA agents are expensive (5-15 min each) — for ordinary transient
		// infrastructure failures only retry once. Provider rate-limit /
		// overload errors still retry indefinitely with exponential backoff
		// (cap 15 min), matching the main verification loop.
		const maxBoundedAttempts = 2;
		let result: ReviewStepExecutionResult & { artifact?: any } = { passed: false, output: "Re-run failed." };
		for (let attempt = 1; ; attempt++) {
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
			if (result.status === "timeout") break;
			const decision = shouldRetryVerificationStep({
				passed: result.passed, output: result.output,
				attempt, maxBoundedAttempts,
				isTransient: isTransientQaError,
			});
			if (decision === "break") break;
			const isBackoff = isProviderBackoffError(result.output);
			const delayMs = verificationRetryDelayMs(attempt, isBackoff);
			const attemptLabel = isBackoff ? `attempt ${attempt}, provider backoff — unbounded` : `attempt ${attempt}/${maxBoundedAttempts}`;
			console.log(`[verification] Re-run QA "${stepName}" failed transiently (${attemptLabel}), retrying in ${Math.round(delayMs / 1000)}s...`);
			await this._sleepCancellable(delayMs, () => {
				const g = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
				return !!(g && (g.state === "complete" || g.state === "shelved"));
			});
		}

		return { name: stepName, type: "agent-qa", passed: result.passed, status: result.status, timeout: result.timeout, output: result.output, duration_ms: Date.now() - startedAt };
	}

	private readonly _stateDir: string;

	private configCascade?: import("./config-cascade.js").ConfigCascade;

	/** Monotonic counter used to stamp `seq` on every broadcast event. */
	private _verifSeqCounter = 0;

	/**
	 * Tracked subprocess for each live command-step, keyed by
	 * `${signalId}:${stepIndex}`. Used by `cancelVerification` /
	 * `cancelStaleVerifications` to tree-kill the running shell on cancel,
	 * and by `shutdown()` for graceful gateway exit.
	 */
	private _trackedCommandChildren = new Map<string, TrackedChild>();

	/**
	 * Tracked-child keys that were killed by an explicit cancellation rather
	 * than a timeout or natural exit. Read in `runCommandStep`'s close
	 * handler so the resolved output carries the cancellation marker even
	 * after the parent `ActiveVerification` entry has been purged.
	 */
	private _cancelledTrackedKeys = new Set<string>();

	private readonly broadcastFn: (goalId: string, event: any) => void;
	private readonly commandRunner: CommandRunner;
	/** Executor for verification command STEPS (default = real durable spawn). */
	private readonly commandStepRunner: VerificationCommandRunner;
	private readonly clock: Clock;
	private readonly skipLlmReview: boolean;

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
		deps: { commandRunner?: CommandRunner; commandStepRunner?: VerificationCommandRunner; clock?: Clock; skipLlmReview?: boolean } = {},
	) {
		this.commandRunner = deps.commandRunner ?? realCommandRunner;
		this.commandStepRunner = deps.commandStepRunner ?? realVerificationCommandRunner;
		this.clock = deps.clock ?? realClock;
		this.skipLlmReview = !!deps.skipLlmReview;
		this.configCascade = configCascade;
		// Wrap the broadcast fn so every gate_verification_* event carries a
		// monotonic `seq`. The UI uses (type, signalId, stepIndex, seq) to
		// dedupe payloads delivered via per-session WS fan-out (see
		// src/app/verification-event-bus.ts). The seq is global per harness
		// instance — simpler than scoping per (goal,gate,signal) and equally
		// effective since the dedupe key includes signalId.
		this.broadcastFn = (goalId: string, event: any) => {
			if (event && typeof event === "object" && typeof event.type === "string" && event.type.startsWith("gate_verification_")) {
				if (event.seq == null) event.seq = ++this._verifSeqCounter;
				if (event.type !== "gate_verification_step_output") {
					this.projectContextManager?.getContextForGoal(goalId)?.goalStore.bumpGeneration?.();
				}
			}
			this._rawBroadcastFn(goalId, sanitizeVerificationWsEvent(event));
		};
		this._stateDir = stateDir;
		this._persistPath = path.join(stateDir, "active-verifications.json");
		this.projectContextManager = projectContextManager ?? null;
		// Unified child-team scheduler — closures read `this.*` lazily at call
		// time so they pick up the projectContextManager/teamManager wired above.
		this.childScheduler = new ChildTeamScheduler({
			resolveCap: (rootGoalId) =>
				this.projectContextManager?.getContextForGoal(rootGoalId)?.goalManager
					.resolveRootMaxConcurrentChildren(rootGoalId) ?? 3,
			getChild: (childGoalId) =>
				this.projectContextManager?.getContextForGoal(childGoalId)?.goalStore.get(childGoalId),
			startChildTeam: (childGoalId) => this._startScheduledChildTeam(childGoalId),
		});
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
		// Goal-scoped inline roles win over the project/server/builtin cascade.
		// This lets a goal-bound ephemeral reviewer's `model` / `thinkingLevel`
		// override the cascade for sessions of that role.
		const goal = goalId ? this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId) : undefined;
		const inline = goal?.inlineRoles?.[roleName];
		if (inline) return { model: inline.model, thinkingLevel: inline.thinkingLevel };

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

	private resolveConfiguredBaseBranch(goalId: string): string | undefined {
		const configured = this.resolveProjectConfigStore(goalId)?.get("base_ref") ?? "";
		const parsed = parseBaseRef(configured);
		return parsed.branch || undefined;
	}

	private async resolveVerificationBaseBranch(goalId: string, cwd: string, fallback?: string): Promise<string> {
		return this.resolveConfiguredBaseBranch(goalId)
			|| fallback
			|| (await detectPrimaryBranch(cwd, this.commandRunner).catch(() => "master"));
	}

	private async resolveLegacyMasterBranch(cwd: string): Promise<string> {
		return detectPrimaryBranch(cwd, this.commandRunner).catch(() => "master");
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
	 * Sleep that can be aborted between chunks. Used between verification-step
	 * retry attempts so a 15-minute provider-backoff wait still observes
	 * goal-state changes (cancel, shelve, complete) within a few seconds
	 * rather than blocking the loop.
	 */
	private async _sleepCancellable(totalMs: number, isCancelled: () => boolean): Promise<void> {
		const CHUNK_MS = 2000;
		const deadline = this.clock.now() + totalMs;
		while (this.clock.now() < deadline) {
			if (isCancelled()) return;
			const remaining = deadline - this.clock.now();
			await new Promise<void>(r => this.clock.setTimeout(() => r(), Math.min(CHUNK_MS, remaining)));
		}
	}

	private _isResumeStillActive(v: ActiveVerification): boolean {
		return this.activeVerifications.get(v.signalId) === v && !v.cancelled;
	}

	private _commandIdentityNonce(step: ActiveVerification["steps"][number]): string | undefined {
		return step.pidNonce ?? step.nonce;
	}

	private _readCommandIdentityFile(step: ActiveVerification["steps"][number]): { pid?: number; ok: boolean; reason: string; retryable?: boolean; mtimeMs?: number } {
		const expectedNonce = this._commandIdentityNonce(step);
		if (!step.pidFile || !expectedNonce) {
			return { ok: false, reason: "no durable command identity was recorded", retryable: false };
		}
		let parsed: any;
		let mtimeMs: number | undefined;
		try {
			const stat = fs.statSync(step.pidFile);
			mtimeMs = stat.mtimeMs;
			const raw = fs.readFileSync(step.pidFile, "utf8").trim();
			try {
				parsed = JSON.parse(raw);
			} catch {
				const [pidLine, nonceLine] = raw.split(/\r?\n/);
				parsed = { pid: pidLine, nonce: nonceLine };
			}
		} catch (err) {
			return { ok: false, reason: `command identity file is unavailable or unreadable: ${(err as Error).message}`, retryable: true };
		}
		const fileNonce = typeof parsed?.nonce === "string" ? parsed.nonce : undefined;
		if (fileNonce !== expectedNonce) {
			return { ok: false, reason: "command identity nonce did not match persisted metadata", retryable: false, mtimeMs };
		}
		const filePid = Number(parsed?.pid);
		const validFilePid = Number.isFinite(filePid) && filePid > 0 ? filePid : undefined;
		const pid = process.platform === "win32" && typeof step.pid === "number"
			? step.pid
			: (validFilePid ?? step.pid);
		if (!pid || !Number.isFinite(pid) || pid <= 0) {
			return { ok: false, reason: "command identity file did not contain a valid process id", retryable: true, mtimeMs };
		}
		if (process.platform !== "win32" && typeof step.pid === "number" && validFilePid !== undefined && step.pid !== validFilePid) {
			return { pid, ok: false, reason: "command identity process id did not match persisted metadata", retryable: false, mtimeMs };
		}
		return { pid, ok: true, reason: "verified", retryable: false, mtimeMs };
	}

	private async _waitForCommandIdentityFile(step: ActiveVerification["steps"][number], isStillActive: () => boolean): Promise<{ pid?: number; ok: boolean; reason: string; retryable?: boolean; mtimeMs?: number }> {
		let identity = this._readCommandIdentityFile(step);
		if (identity.ok || !identity.retryable) return identity;
		const deadline = this.clock.now() + COMMAND_IDENTITY_PIDFILE_RETRY_MS;
		while (this.clock.now() < deadline && isStillActive()) {
			await new Promise<void>(r => this.clock.setTimeout(() => r(), COMMAND_IDENTITY_PIDFILE_RETRY_INTERVAL_MS));
			identity = this._readCommandIdentityFile(step);
			if (identity.ok || !identity.retryable) return identity;
		}
		return identity;
	}

	private _heartbeatMatchesCommandIdentity(step: ActiveVerification["steps"][number], pid: number): boolean {
		const expectedNonce = this._commandIdentityNonce(step);
		if (!step.heartbeatFile || !expectedNonce) return false;
		try {
			const stat = fs.statSync(step.heartbeatFile);
			if (Date.now() - stat.mtimeMs > COMMAND_IDENTITY_HEARTBEAT_STALE_MS) return false;
			const parsed = JSON.parse(fs.readFileSync(step.heartbeatFile, "utf8"));
			return parsed?.nonce === expectedNonce && (process.platform === "win32" || Number(parsed?.pid) === pid);
		} catch {
			return false;
		}
	}

	private _verifyPersistedCommandIdentity(
		step: ActiveVerification["steps"][number],
		preReadIdentity?: { pid?: number; ok: boolean; reason: string; mtimeMs?: number },
	): { verified: boolean; pid?: number; reason: string } {
		const identity = preReadIdentity ?? this._readCommandIdentityFile(step);
		if (!identity.ok || !identity.pid) return { verified: false, pid: identity.pid, reason: identity.reason };
		const pid = identity.pid;
		if (!isPidAlive(pid)) return { verified: false, pid, reason: "command process is no longer alive" };

		const currentStartToken = readProcessStartToken(pid);
		if (step.processStartToken && currentStartToken) {
			if (step.processStartToken !== currentStartToken) {
				return { verified: false, pid, reason: "command process start token did not match; PID may have been reused" };
			}
			return { verified: true, pid, reason: "pidfile nonce and process start token matched" };
		}

		if (this._heartbeatMatchesCommandIdentity(step, pid)) {
			return { verified: true, pid, reason: "pidfile nonce and live heartbeat matched" };
		}

		// Bounded create-window proof: immediately after restart the wrapper may
		// have published the pidfile before its first heartbeat. Treat only a
		// freshly-written pidfile as current identity evidence; stale nonce-only
		// records remain unverified to avoid PID-reuse kills.
		if (identity.mtimeMs !== undefined && Date.now() - identity.mtimeMs <= COMMAND_IDENTITY_HEARTBEAT_STALE_MS) {
			return { verified: true, pid, reason: "pidfile nonce matched and identity file was freshly written" };
		}

		return {
			verified: false,
			pid,
			reason: "pidfile nonce matched, but no process start token or fresh heartbeat was available; refusing to trust a possibly reused PID",
		};
	}

	private _mergePersistedActiveVerifications(predicate: (v: ActiveVerification) => boolean): void {
		for (const persisted of this._loadActive()) {
			if (!predicate(persisted)) continue;
			if (!this.activeVerifications.has(persisted.signalId)) {
				this.activeVerifications.set(persisted.signalId, persisted);
			}
		}
	}

	private _hasPendingCommandKillCleanup(active: ActiveVerification): boolean {
		return active.steps.some(step =>
			step.type === "command" &&
			!!step.killRequestedAt &&
			!step.killCompletedAt,
		);
	}

	private _commandStepRequiresKillCleanup(step: ActiveVerification["steps"][number]): boolean {
		return step.type === "command" && (step.status === "running" || (!!step.killRequestedAt && !step.killCompletedAt));
	}

	private _markPersistedCommandKillIntent(active: ActiveVerification, signal: NodeJS.Signals, reason: "cancelled" | "timeout"): void {
		const now = Date.now();
		active.cancelRequestedAt ??= now;
		active.cancelReason ??= reason;
		for (const step of active.steps) {
			if (step.type !== "command") continue;
			if (step.status !== "running" && !step.killRequestedAt) continue;
			step.killRequestedAt ??= now;
			step.killReason = reason;
			step.killSignal = signal;
		}
	}

	private async _waitForPidToExit(pid: number, timeoutMs = 1_500): Promise<boolean> {
		const deadline = this.clock.now() + timeoutMs;
		while (this.clock.now() < deadline) {
			if (!isPidAlive(pid)) return true;
			await new Promise<void>(r => this.clock.setTimeout(() => r(), 50));
		}
		return !isPidAlive(pid);
	}

	private _commandKillRetryTimers = new Map<string, NodeJS.Timeout>();

	private _scheduleCommandKillCleanupRetry(signalId: string): void {
		if (this._commandKillRetryTimers.has(signalId)) return;
		const timer = this.clock.setTimeout(async () => {
			this._commandKillRetryTimers.delete(signalId);
			const active = this.activeVerifications.get(signalId);
			if (!active || !this._hasPendingCommandKillCleanup(active)) return;
			try {
				const pendingStep = active.steps.find(step => step.type === "command" && !!step.killRequestedAt && !step.killCompletedAt);
				const signal = pendingStep?.killSignal ?? "SIGKILL";
				const settled = await this._killPersistedCommandSteps(active, signal, { waitForIdentity: true, markIntent: false });
				if (!settled) {
					this._persistActive();
					this._scheduleCommandKillCleanupRetry(signalId);
					return;
				}

				if (active.cancelled || active.overallStatus === "cancelled") {
					if (this.activeVerifications.get(signalId) === active) this.activeVerifications.delete(signalId);
					this._persistActive();
					return;
				}

				if (this.activeVerifications.get(signalId) === active) {
					await this._resumeOneVerification(active);
					if (this.activeVerifications.get(signalId) === active && !this._hasPendingCommandKillCleanup(active)) {
						this.activeVerifications.delete(signalId);
					}
					this._persistActive();
				}
			} catch (err) {
				console.warn(`[verification] Command cleanup retry for ${signalId} did not settle: ${(err as Error).message}`);
				this._persistActive();
				if (this.activeVerifications.has(signalId)) this._scheduleCommandKillCleanupRetry(signalId);
			}
		}, 1_000);
		timer.unref?.();
		this._commandKillRetryTimers.set(signalId, timer);
	}

	private async _killPersistedCommandSteps(
		active: ActiveVerification,
		signal: NodeJS.Signals = "SIGKILL",
		options: { waitForIdentity?: boolean; markIntent?: boolean; reason?: "cancelled" | "timeout" } = {},
	): Promise<boolean> {
		if (options.markIntent !== false) {
			this._markPersistedCommandKillIntent(active, signal, options.reason ?? "cancelled");
			this._persistActive();
		}

		let allSettled = true;
		for (const step of active.steps) {
			if (!this._commandStepRequiresKillCleanup(step)) continue;
			if (step.exitFile && fs.existsSync(step.exitFile)) {
				step.killCompletedAt ??= Date.now();
				continue;
			}
			if (step.restartRecoveryMode === "unsupported" || step.containerId || (!step.pidFile && !step.pid)) {
				step.killUnsafeReason = step.restartRecoveryUnsupportedReason ?? "command path has no restart-safe persisted process identity";
				allSettled = false;
				continue;
			}

			const identityFile = options.waitForIdentity
				? await this._waitForCommandIdentityFile(step, () => this.activeVerifications.get(active.signalId) === active && this._hasPendingCommandKillCleanup(active))
				: this._readCommandIdentityFile(step);
			let identity = this._verifyPersistedCommandIdentity(step, identityFile);
			if (!identity.verified || !identity.pid) {
				step.killUnsafeReason = identity.reason;
				if (identity.reason === "command process is no longer alive") {
					if (step.killReason === "timeout" && (step.killAttempts ?? 0) === 0 && !step.killLastAttemptAt) {
						step.killUnsafeReason = "command process exited before Bobbit could verify a timeout kill; no command verdict was obtained";
						delete step.killRequestedAt;
						delete step.killReason;
						delete step.killSignal;
					} else {
						step.killCompletedAt ??= Date.now();
					}
					continue;
				}
				allSettled = false;
				if (process.env.BOBBIT_DEBUG && (step.pidFile || step.pid)) {
					console.warn(`[verification] Not killing persisted command "${step.name}" for ${active.signalId}: ${identity.reason}`);
				}
				continue;
			}

			step.killAttempts = (step.killAttempts ?? 0) + 1;
			step.killLastAttemptAt = Date.now();
			try { killTreeByPid(identity.pid, signal); } catch { /* best-effort */ }
			const exited = await this._waitForPidToExit(identity.pid);
			if (exited) {
				step.killCompletedAt = Date.now();
				continue;
			}

			identity = this._verifyPersistedCommandIdentity(step);
			if (identity.reason === "command process is no longer alive") {
				step.killCompletedAt = Date.now();
			} else {
				allSettled = false;
				step.killUnsafeReason = identity.verified && identity.pid
					? "verified command process was still alive after kill attempt; will retry"
					: `command cleanup could not be verified after kill attempt: ${identity.reason}`;
			}
		}
		this._persistActive();
		return allSettled;
	}

	private async _killVerifiedCommandStepForTimeout(
		active: ActiveVerification,
		step: ActiveVerification["steps"][number],
	): Promise<{ status: "settled" | "pending" | "unverifiable"; reason?: string }> {
		const hadPriorKillAttempt = (step.killAttempts ?? 0) > 0 || !!step.killLastAttemptAt || !!step.killCompletedAt;
		let identity = this._verifyPersistedCommandIdentity(step);

		if (!identity.verified || !identity.pid) {
			step.killUnsafeReason = identity.reason;
			if (identity.reason === "command process is no longer alive") {
				step.killCompletedAt ??= Date.now();
				this._persistActive();
				return hadPriorKillAttempt
					? { status: "settled" }
					: {
						status: "unverifiable",
						reason: "The command process was no longer alive at its timeout deadline before Bobbit could verify cleanup, and no durable exit status was recorded.",
					};
			}

			this._markPersistedCommandKillIntent(active, "SIGKILL", "timeout");
			step.killUnsafeReason = `timeout cleanup is pending until command identity can be verified safely: ${identity.reason}`;
			this._persistActive();
			return { status: "pending", reason: step.killUnsafeReason };
		}

		this._markPersistedCommandKillIntent(active, "SIGKILL", "timeout");
		step.killAttempts = (step.killAttempts ?? 0) + 1;
		step.killLastAttemptAt = Date.now();
		try { killTreeByPid(identity.pid, "SIGKILL"); } catch { /* best-effort */ }
		const exited = await this._waitForPidToExit(identity.pid);
		if (exited) {
			step.killCompletedAt = Date.now();
			delete step.killUnsafeReason;
			this._persistActive();
			return { status: "settled" };
		}

		identity = this._verifyPersistedCommandIdentity(step);
		if (identity.reason === "command process is no longer alive") {
			step.killCompletedAt = Date.now();
			delete step.killUnsafeReason;
			this._persistActive();
			return { status: "settled" };
		}

		step.killUnsafeReason = identity.verified && identity.pid
			? "verified command process was still alive after timeout kill attempt; will retry before finalizing the timeout"
			: `timeout cleanup could not be verified after kill attempt: ${identity.reason}`;
		this._persistActive();
		return { status: "pending", reason: step.killUnsafeReason };
	}

	/**
	 * Tree-kill any tracked command-step subprocess registered under the given
	 * signalId. Uses SIGTERM with a 1s SIGKILL escalation so cancellation is
	 * observable within ~1s (single-timer path, no setInterval poll).
	 */
	private _killTrackedForSignal(signalId: string): void {
		for (const key of Array.from(this._trackedCommandChildren.keys())) {
			if (key.startsWith(signalId + ":")) {
				const t = this._trackedCommandChildren.get(key);
				this._trackedCommandChildren.delete(key);
				this._cancelledTrackedKeys.add(key);
				try { t?.killTree("SIGTERM", 1000); } catch { /* best-effort */ }
			}
		}
	}

	/**
	 * Drain every pending human-signoff resolver whose key matches the given
	 * signalId. Used by `cancelStaleVerifications` / `cancelAllVerifications`
	 * so a re-signal or goal-complete unblocks any parked `await promise`
	 * inside `verifyGateSignal`'s human-signoff branch — the awaited promise
	 * resolves with `{ cancelled: true }` and the outer `active.cancelled`
	 * short-circuit handles the rest of the cleanup.
	 */
	private _drainPendingSignoffsForSignal(signalId: string): void {
		const prefix = `${signalId}::`;
		for (const key of Array.from(this.pendingSignoffs.keys())) {
			if (!key.startsWith(prefix)) continue;
			const resolver = this.pendingSignoffs.get(key);
			this.pendingSignoffs.delete(key);
			try { resolver?.({ cancelled: true }); } catch (err) {
				console.error(`[verification] Failed to drain pending signoff ${key}:`, err);
			}
		}
	}

	/**
	 * Graceful shutdown — kill every in-flight tracked subprocess tree so
	 * orphan chromium / playwright descendants don't survive the gateway exit.
	 */
	shutdown(): void {
		try { killAllTracked("SIGKILL"); } catch { /* best-effort */ }
	}

	/**
	 * Cancel ALL in-flight verifications for a goal (all gates).
	 * Called when a goal completes, a team is torn down, or the goal is shelved.
	 */
	async cancelAllVerifications(goalId: string): Promise<void> {
		this._mergePersistedActiveVerifications(v => v.goalId === goalId);
		for (const [signalId, active] of Array.from(this.activeVerifications)) {
			if (active.goalId !== goalId) continue;
			active.cancelled = true;
			active.overallStatus = "cancelled";
			active.cancelRequestedAt ??= Date.now();

			this._markPersistedCommandKillIntent(active, "SIGKILL", "cancelled");
			this._persistActive();
			this._killTrackedForSignal(signalId);
			const commandKillsSettled = await this._killPersistedCommandSteps(active, "SIGKILL", { waitForIdentity: true, markIntent: false });
			this._drainPendingSignoffsForSignal(signalId);

			for (const step of active.steps) {
				if (step.sessionId && step.status === "running") {
					try { await this.sessionManager?.terminateSession(step.sessionId); } catch { /* ignore */ }
					if (this.teamManager) {
						try { await this.teamManager.unregisterReviewerSession(goalId, step.sessionId); } catch { /* ignore */ }
					}
				}
			}

			if (commandKillsSettled) {
				this.activeVerifications.delete(signalId);
			} else {
				this._scheduleCommandKillCleanupRetry(signalId);
			}
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
		await this.cancelStaleVerificationsForGates(goalId, [gateId]);
	}

	/**
	 * Cancel in-flight verifications for any matching gate in one synchronous
	 * marking pass before awaiting reviewer-session cleanup. This lets callers
	 * invalidate several gates without a later verification completing between
	 * per-gate awaits and re-marking a reset gate.
	 */
	async cancelStaleVerificationsForGates(goalId: string, gateIds: string[]): Promise<void> {
		const gateIdSet = new Set(gateIds);
		this._mergePersistedActiveVerifications(v => v.goalId === goalId && gateIdSet.has(v.gateId));
		const cancellations: Array<{ signalId: string; gateId: string; runningSessionIds: string[] }> = [];

		for (const [signalId, active] of Array.from(this.activeVerifications)) {
			if (active.goalId !== goalId || !gateIdSet.has(active.gateId)) continue;

			active.cancelled = true;
			active.overallStatus = "cancelled";
			active.cancelRequestedAt ??= Date.now();

			this._markPersistedCommandKillIntent(active, "SIGKILL", "cancelled");
			this._persistActive();
			this._killTrackedForSignal(signalId);
			const commandKillsSettled = await this._killPersistedCommandSteps(active, "SIGKILL", { waitForIdentity: true, markIntent: false });
			this._drainPendingSignoffsForSignal(signalId);
			if (commandKillsSettled) {
				this.activeVerifications.delete(signalId);
			} else {
				this._scheduleCommandKillCleanupRetry(signalId);
			}

			cancellations.push({
				signalId,
				gateId: active.gateId,
				runningSessionIds: active.steps
					.filter(step => step.sessionId && step.status === "running")
					.map(step => step.sessionId!),
			});
		}

		if (cancellations.length > 0) this._persistActive();

		for (const { signalId, gateId, runningSessionIds } of cancellations) {
			// Terminate all running reviewer sessions after every affected active
			// verification has already been marked cancelled and removed.
			for (const sessionId of runningSessionIds) {
				try {
					await this.sessionManager?.terminateSession(sessionId);
				} catch { /* ignore — may already be terminated */ }
				if (this.teamManager) {
					try {
						await this.teamManager.unregisterReviewerSession(goalId, sessionId);
					} catch { /* ignore */ }
				}
			}

			// Persist cancellation to gate store so UI sees "failed" instead of stale "running"
			this.resolveGateStore(goalId).updateSignalVerification(signalId, {
				status: "failed",
				steps: [{ name: "Cancelled", type: "command", passed: false, status: "failed", phase: 0, output: "Verification cancelled.", duration_ms: 0 }],
			});
			// Note: gate status is NOT updated here — the caller decides whether to set it
			// (e.g. explicit user cancel sets it to "failed", but re-signal lets the new verification decide)

			this.broadcastFn(goalId, {
				type: "gate_verification_complete",
				goalId, gateId, signalId,
				status: "cancelled",
			});

			console.log(`[verification] Cancelled stale verification ${signalId} for gate ${gateId}`);
		}
	}

	private notifyTeamLead(
		goalId: string,
		gateId: string,
		status: string,
		failureContext?: { steps?: ReadonlyArray<{ name: string; type: string; passed: boolean; output?: string }>; goalBranch?: string },
	): void {
		if (!this.notifyTeamLeadFn) return;
		// Notify the goal's OWN team-lead first (intra-team signal).
		if (status === "passed") {
			this.notifyTeamLeadFn(goalId, `Gate verification PASSED: "${gateId}". Downstream work for this gate can now proceed.`);
		} else {
			const steps = failureContext?.steps ?? [];
			const message = buildVerificationFailureMessage(gateId, steps);
			this.notifyTeamLeadFn(goalId, message);
		}
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
		// Runtime safety net for in-flight child goals whose workflow snapshots
		// predate the spawn-time rewrite. If this is a child's `ready-to-merge`,
		// transparently rewrite the verify[] for child semantics (merges into
		// parent's branch locally; no PR). See child-ready-to-merge.ts.
		let effectiveGate = gate;
		if (gate.id === "ready-to-merge" && Array.isArray(gate.verify) && gate.verify.length > 0) {
			const rtmGoal = this.projectContextManager?.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
			if (rtmGoal?.mergeTarget === "parent" && rtmGoal.parentGoalId) {
				const rtmParent = this.projectContextManager?.getContextForGoal(rtmGoal.parentGoalId)?.goalStore.get(rtmGoal.parentGoalId);
				if (rtmParent?.branch) {
					const adaptedVerify = adaptReadyToMergeVerify(gate.verify, { parentBranch: rtmParent.branch });
					effectiveGate = { ...gate, verify: adaptedVerify };
				}
			}
		}
		const steps = effectiveGate.verify;
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
			broadcastGateStatusChanged(this.broadcastFn, signal.goalId, signal.gateId, "passed");
			this.notifyTeamLead(signal.goalId, signal.gateId, "passed");
			return;
		}

		// Reuse the active verification entry that the REST handler seeded
		// via `beginVerification` (the synchronous-enumeration fix for the
		// gate-store ↔ activeVerifications race). When the entry isn't there
		// — callers that bypass the REST handler, or tests — fall back to
		// the legacy inline construction so this method remains usable
		// standalone.
		let active = this.activeVerifications.get(signal.id);
		let verificationStartedAt: number;
		if (active) {
			verificationStartedAt = active.startedAt;
		} else {
			verificationStartedAt = Date.now();
			this.broadcastFn(signal.goalId, {
				type: "gate_verification_started",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				startedAt: verificationStartedAt,
				steps: steps.map(s => ({ name: s.name, type: s.type, phase: s.phase ?? 0 })),
			});
			const minPhase = Math.min(...steps.map(s => s.phase ?? 0));
			active = {
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
		}

		try {
			const [baseBranch, legacyMasterBranch] = await Promise.all([
				this.resolveVerificationBaseBranch(signal.goalId, cwd, primaryBranch || "master"),
				this.resolveLegacyMasterBranch(cwd),
			]);
			const builtinVars: Record<string, string> = {
				branch: goalBranch || "HEAD",
				baseBranch,
				master: legacyMasterBranch,
				cwd,
				goal_spec: goalSpec || "",
				commit: signal.commitSha || "HEAD",
			};

			// Project config — resolved via {{project.key}}
			const projectConfigStore = this.resolveProjectConfigStore(signal.goalId);
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
			const cachedSteps = buildStepCache(
				gateState?.signals ?? [],
				signal.id,
				signal.commitSha,
				gateState?.verificationCacheInvalidatedAt,
			);
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
					passed: true, skipped: true, status: "skipped", phase: s.phase ?? 0,
					output: "Skipped — not enabled for this goal", duration_ms: 0,
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

			// A restart-resumed verification can re-enter this normal execution path
			// with earlier phases already recovered as terminal rows. Preserve those
			// results and execute only the still-waiting downstream phases.
			for (let i = 0; i < steps.length; i++) {
				if (allResults[i]) continue;
				const activeStep = active.steps[i];
				if (!activeStep) continue;
				const activeStatus = activeStep.status as PersistedGateSignalStepStatus;
				if (activeStatus !== "passed" && activeStatus !== "failed" && activeStatus !== "timeout" && activeStatus !== "skipped") continue;
				const status = activeStatus;
				allResults[i] = {
					name: steps[i].name,
					type: steps[i].type as GateSignalStep["type"],
					passed: status === "passed" || status === "skipped",
					...(status === "skipped" ? { skipped: true } : {}),
					status,
					phase: activeStep.phase ?? steps[i].phase ?? 0,
					output: activeStep.output || "",
					duration_ms: activeStep.durationMs || 0,
					...(activeStep.timeout ? { timeout: activeStep.timeout } : {}),
					expect: steps[i].expect,
				} as GateSignalStep;
			}
			const remainingActiveSteps = activeSteps.filter(step => {
				const index = steps.indexOf(step);
				return index < 0 || !allResults[index];
			});

			// If ALL remaining active steps can be served from cache, skip spawning agents entirely
			if (canSkipAllSteps(cachedSteps, remainingActiveSteps)) {
				console.log(`[verification] All ${remainingActiveSteps.length} remaining active step(s) cached for commit ${signal.commitSha!.slice(0, 8)} — skipping agent spawn`);
				const results: GateSignalStep[] = steps.map((s, i) => {
					if (allResults[i]) return allResults[i]!; // skipped optional step
					const cached = cachedSteps.get(s.name)!;
					const cachedStatus = terminalStatusForStep(cached);
					return { ...cached, status: cachedStatus as GateSignalStep["status"], ...(cachedStatus === "skipped" ? { skipped: true } : {}), phase: cached.phase ?? s.phase ?? 0, output: `[cached from prior signal] ${cached.output}` };
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
						status: terminalStatusForStep(r),
						durationMs: r.duration_ms || 0, output: r.output,
						phase: r.phase ?? steps[index].phase ?? 0,
					});
				});
				this.broadcastFn(signal.goalId, {
					type: "gate_verification_complete",
					goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id, status,
				});
				broadcastGateStatusChanged(this.broadcastFn, signal.goalId, signal.gateId, status);
				this.notifyTeamLead(signal.goalId, signal.gateId, status, { steps: results, goalBranch });
				return;
			}

			// --- Phased execution ---
			// Active steps are grouped by phase (default 0), and phases execute sequentially.
			// All steps within a phase run concurrently by default. Skipped optional steps
			// are excluded.
			const phaseGroups = groupStepsByPhase(remainingActiveSteps, steps);
			const sortedPhases = getSortedPhases(phaseGroups);

			// Sync the goal worktree with the latest commits before running verification.
			// Agents (sandbox or not) push to origin — fetch and reset to pick up their changes.
			if (goalBranch) {
				let hasOriginRemote = false;
				try {
					await this.commandRunner.execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 5_000 });
					hasOriginRemote = true;
				} catch {
					// Local-only repositories are valid verification targets; skip remote sync quietly.
				}

				if (hasOriginRemote) {
					let hasRemoteGoalBranch = false;
					try {
						const { stdout } = await this.commandRunner.execFile("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${goalBranch}`], { cwd, timeout: 15_000 });
						hasRemoteGoalBranch = lsRemoteOutputHasHead(stdout.toString(), goalBranch);
					} catch (err) {
						if (!isMissingRemoteHeadLsRemoteError(err)) {
							console.warn(`[verification] Failed to check origin/${goalBranch} (non-fatal):`, err);
						}
					}

					if (hasRemoteGoalBranch) {
						try {
							await this.commandRunner.execFile("git", ["fetch", "origin", goalBranch], { cwd, timeout: 30_000 });

							// Ancestry-aware, NON-DESTRUCTIVE sync. `git reset --hard` here would
							// silently discard un-pushed local commits when the worktree is ahead
							// of origin — the normal state under the team-lead local-merge model.
							// `git merge-base --is-ancestor <a> <b>` exits 0 when <a> is an ancestor
							// of <b>, exit 1 when it is not; any other exit is a real git error.
							const originRef = `origin/${goalBranch}`;
							const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
								try {
									await this.commandRunner.execFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, timeout: 15_000 });
									return true;
								} catch (err) {
									const code = execErrorCode(err);
									if (code === 1 || code === "1") return false;
									throw err; // real error (e.g. bad revision) → outer catch keeps local state
								}
							};

							if (await isAncestor(originRef, "HEAD")) {
								// origin is an ancestor of local HEAD → local is ahead of (or equal to)
								// origin. It already contains every origin commit plus local merges.
								console.log(`[verification] goal worktree ahead of ${originRef} — skipping reset (skipped-because-ahead)`);
							} else if (await isAncestor("HEAD", originRef)) {
								// local HEAD is an ancestor of origin → origin is strictly ahead, local
								// has nothing unique. Advance to pick up pushed work. Use `git reset
								// --hard` (NOT `git merge --ff-only`): a plain fast-forward via merge
								// runs repo-local hooks (e.g. `.git/hooks/post-merge`), which is a
								// local code-execution vector inside an agent-controlled worktree.
								// `reset --hard` does NOT run hooks and is safe here because HEAD is
								// already proven an ancestor of origin — no local commits are lost.
								await this.commandRunner.execFile("git", ["reset", "--hard", originRef], { cwd, timeout: 15_000 });
								console.log(`[verification] fast-forwarded goal worktree to ${originRef} (fast-forwarded)`);
							} else {
								// Diverged: each side has unique commits. Never hard-reset — that would
								// discard local commits. Keep local state and verify it, loudly.
								console.warn(`[verification] goal worktree diverged from ${originRef} — keeping local state, NOT resetting (diverged-kept-local)`);
							}
						} catch (err) {
							console.warn(`[verification] Failed to sync worktree from origin/${goalBranch}:`, err);
						}
					}

					// Also fetch the review baseline branch so origin/<base> is up-to-date for
					// implementation-gate diff baselines. Non-fatal on failure (offline / remote issue).
					const reviewBaselineBranch = builtinVars.baseBranch || builtinVars.master;
					if (reviewBaselineBranch) {
						try {
							await this.commandRunner.execFile("git", ["fetch", "origin", reviewBaselineBranch], { cwd, timeout: 30_000 });
						} catch (err) {
							console.warn(`[verification] Failed to fetch origin/${reviewBaselineBranch} (non-fatal):`, err);
						}
					}
				}
			}

			const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MB
			const earliestPreResolvedFailedPhase = allResults.reduce<number | undefined>((earliest, result) => {
				if (!result || result.passed || result.skipped) return earliest;
				const phase = result.phase ?? 0;
				return earliest === undefined || phase < earliest ? phase : earliest;
			}, undefined);
			let phaseFailed = false;

			for (const phase of sortedPhases) {
				if (earliestPreResolvedFailedPhase !== undefined && phase > earliestPreResolvedFailedPhase) phaseFailed = true;
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
							status: "skipped",
							phase,
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

				// Run every step in this phase concurrently. Sequencing is expressed
				// only by assigning steps to different phase numbers.
				const phaseResults = await runVerificationPhaseSteps(
					phaseSteps,
					async ({ step, index }) => {
						const cached = cachedSteps.get(step.name);
						if (cached) {
							const cachedStatus = terminalStatusForStep(cached);
							const cachedResult: GateSignalStep = { ...cached, status: cachedStatus as GateSignalStep["status"], ...(cachedStatus === "skipped" ? { skipped: true } : {}), phase: cached.phase ?? phase, output: `[cached from prior signal] ${cached.output}` };
							if (!active.cancelled) this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_complete",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								status: cachedResult.status ?? terminalStatusForStep(cachedResult),
								durationMs: cachedResult.duration_ms || 0, output: cachedResult.output,
								phase: cachedResult.phase ?? phase,
							});
							const av = this.activeVerifications.get(signal.id);
							if (av && av.steps[index]) {
								av.steps[index] = { ...av.steps[index], status: (cachedResult.status ?? terminalStatusForStep(cachedResult)) as NonNullable<GateSignalStep["status"]>, phase: cachedResult.phase ?? phase, durationMs: cachedResult.duration_ms || 0, output: cachedResult.output };
								this._persistActive();
							}
							return { index, stepResult: cachedResult };
						}

						let result: ReviewStepExecutionResult & { skipped?: boolean; diagnostics?: GateStepDiagnostics } = { passed: false, output: "No verification result." };
						let artifact: GateSignalStep["artifact"];
						const startTime = Date.now();

						// Pre-generate sessionId for LLM review and agent-qa steps so we can broadcast it before the step starts
						let stepSessionId: string | undefined;
						const reviewTimeoutSec = step.type === "llm-review" || step.type === "agent-qa"
							? this._resolveReviewStepTimeoutSec(signal.goalId, step)
							: undefined;
						if (step.type === "llm-review" || step.type === "agent-qa") {
							const prefix = step.type === "agent-qa" ? "agent-qa" : "llm-review";
							stepSessionId = `${prefix}-${randomUUID().slice(0, 12)}`;
							active.steps[index].startedAt = Date.now();
							this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_started",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								startedAt: active.steps[index].startedAt,
								sessionId: stepSessionId, timeoutSec: reviewTimeoutSec, phase,
							});
							const av = this.activeVerifications.get(signal.id);
							if (av && av.steps[index]) {
								av.steps[index].sessionId = stepSessionId;
								av.steps[index].timeoutSec = reviewTimeoutSec;
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
								return { index, stepResult: { name: step.name, type: step.type, passed: false, status: "failed" as const, phase, output: msg, duration_ms, expect: step.expect } };
							}
							const cmd = this.substituteVars(resolvedRun, builtinVars, projectVars, agentVars, allGateStates);
							// Auto-skip command steps whose run string is empty or contains
							// unresolved template vars (e.g. {{project.build_command}} when the
							// project has no build_command configured). Skipped-as-passed so
							// optional infrastructure steps (build, custom commands) don't fail
							// the gate for projects that don't define them.
							const requiredBuiltinFailure = readyToMergeUnresolvedBuiltinFailure(signal.gateId, cmd);
							const skipReason = requiredBuiltinFailure ? null : isCommandStepSkippable(cmd);
							if (requiredBuiltinFailure) {
								result = { passed: false, output: requiredBuiltinFailure };
							} else if (skipReason) {
								result = { passed: true, skipped: true, output: skipReason };
							} else {
								const pushSafety = validateVerificationPushSafety(cmd, builtinVars);
								if (!pushSafety.ok) {
									result = { passed: false, output: pushSafety.reason };
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
										result = await this.runCommandStep(cmd, commandCwd, resolveCommandStepTimeoutSec(step), expectFailure, streamCtx, errorPattern, commandContainerId);
									} finally {
										this.commandSemaphore.release();
									}
								}
							}
						} else if (step.type === "subgoal") {
							active.steps[index].startedAt = Date.now();
							this.broadcastFn(signal.goalId, {
								type: "gate_verification_step_started",
								goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
								stepIndex: index, stepName: step.name,
								startedAt: active.steps[index].startedAt,
								phase,
							});
							result = await this.runSubgoalStep(step, signal, active, index);
						} else if (step.type === "agent-qa") {
							// agent-qa — spawn a one-shot test-engineer sub-agent
							if (this.skipLlmReview) {
								result = { passed: true, output: "Agent QA skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								// Non-backoff transients (JSON glitches, ECONNRESET, etc.) keep
								// the legacy 3-attempt cap. Provider rate-limit / overload
								// errors retry indefinitely with exponential backoff capped at
								// 15 min — user corporate-subscription quotas can exceed any
								// finite bound, and the right answer is to wait, not fail.
								const maxBoundedAttempts = 3;
								// Fresh reviewer/QA session id per from-scratch attempt (see the
								// llm-review branch below for rationale) so a retry never clobbers
								// the prior attempt's transcript.
								let attemptSessionId = stepSessionId;
								for (let attempt = 1; ; attempt++) {
									if (active.cancelled) break;
									if (attempt > 1) {
										const retiredSessionId = attemptSessionId;
										attemptSessionId = `agent-qa-${randomUUID().slice(0, 12)}`;
										console.log(`[verification][reviewer-lifecycle] agent-qa "${step.name}" from-scratch retry attempt ${attempt}/${maxBoundedAttempts}: retiring session ${retiredSessionId ?? "<none>"} → fresh session ${attemptSessionId} (goal=${signal.goalId}, timeout=${reviewTimeoutSec}s). Prior transcript preserved.`);
										active.steps[index].startedAt = Date.now();
										if (!active.cancelled) this.broadcastFn(signal.goalId, {
											type: "gate_verification_step_started",
											goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
											stepIndex: index, stepName: step.name,
											startedAt: active.steps[index].startedAt,
											sessionId: attemptSessionId, timeoutSec: reviewTimeoutSec, phase,
										});
										const avRetry = this.activeVerifications.get(signal.id);
										if (avRetry && avRetry.steps[index]) {
											avRetry.steps[index].sessionId = attemptSessionId;
											avRetry.steps[index].timeoutSec = reviewTimeoutSec;
											this._persistActive();
										}
									} else {
										console.log(`[verification][reviewer-lifecycle] agent-qa "${step.name}" attempt 1/${maxBoundedAttempts}: session ${attemptSessionId ?? "<none>"} (goal=${signal.goalId}, timeout=${reviewTimeoutSec}s).`);
									}
									const qaResult = await this.runAgentQaStep(
										{ name: step.name, prompt, timeout: step.timeout, role: step.role, component: (step as any).component },
										cwd, signal.goalId, builtinVars,
										signal.content, signal.metadata,
										goalSpec, allGateStates, attemptSessionId,
									);
									result = qaResult;
									if (qaResult.artifact) {
										artifact = qaResult.artifact;
									}
									if (qaResult.status === "timeout") break;
									const decision = shouldRetryVerificationStep({
										passed: qaResult.passed, output: qaResult.output,
										attempt, maxBoundedAttempts,
										isTransient: isTransientQaError,
									});
									if (decision === "break") break;
									const isBackoff = isProviderBackoffError(qaResult.output);
									const delayMs = verificationRetryDelayMs(attempt, isBackoff);
									const attemptLabel = isBackoff ? `attempt ${attempt}, provider backoff — unbounded` : `attempt ${attempt}/${maxBoundedAttempts}`;
									console.log(`[verification] Agent QA "${step.name}" failed transiently (${attemptLabel}), retrying in ${Math.round(delayMs / 1000)}s...`);
									await this._sleepCancellable(delayMs, () => !!active.cancelled);
								}
							}
						} else if (step.type === "human-signoff") {
							// human-signoff — park on a deferred resolver until the user
							// POSTs /signoff with a decision. No subprocess, no session.
							//
							// Bypass logic: ONLY `BOBBIT_HUMAN_SIGNOFF_SKIP=1` auto-passes a
							// human-signoff step. There is intentionally NO fallback to
							// BOBBIT_LLM_REVIEW_SKIP — a "human" gate must not share a
							// bypass with `agent-qa` / `llm-review`, otherwise the global
							// E2E harness (which sets BOBBIT_LLM_REVIEW_SKIP=1) would
							// silently auto-approve every human gate. Removing the
							// fallback was the Bug-1 defense-in-depth fix in the
							// "Re-attempt: Sign-Off Gates" goal.
							//
							// Both `BOBBIT_HUMAN_SIGNOFF_SKIP` unset and `=0` park.
							const skipHumanSignoff = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP === "1";
							if (skipHumanSignoff) {
								result = { passed: true, output: "Human sign-off skipped (BOBBIT_HUMAN_SIGNOFF_SKIP=1)." };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								const label = step.label || step.name;
								const startedAt = Date.now();
								active.steps[index].startedAt = startedAt;
								const av = this.activeVerifications.get(signal.id);
								if (av && av.steps[index]) {
									av.steps[index].awaitingHuman = true;
									av.steps[index].humanPrompt = prompt;
									av.steps[index].humanLabel = label;
									this._persistActive();
								}
								if (!active.cancelled) this.broadcastFn(signal.goalId, {
									type: "gate_verification_step_started",
									goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
									stepIndex: index, stepName: step.name,
									startedAt, phase,
								});
								if (!active.cancelled) this.broadcastFn(signal.goalId, {
									type: "gate_verification_awaiting_human",
									goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
									stepIndex: index, stepName: step.name,
									label, prompt,
								});
								const key = `${signal.id}::${step.name}`;
								const { promise, resolve: resolver } = deferred<SignoffOutcome>();
								this.pendingSignoffs.set(key, resolver);
								const outcome = await promise;
								this.pendingSignoffs.delete(key);
								if ("decision" in outcome) {
									const fb = outcome.feedback?.trim();
									result = {
										passed: outcome.decision === "pass",
										output: outcome.decision === "pass"
											? (fb ? `Approved.\n\n${fb}` : "Approved.")
											: (fb ? `Rejected.\n\n${fb}` : "Rejected."),
									};
								} else {
									result = { passed: false, output: "Sign-off cancelled." };
								}
								const av2 = this.activeVerifications.get(signal.id);
								if (av2 && av2.steps[index]) {
									av2.steps[index].awaitingHuman = false;
									this._persistActive();
								}
							}
						} else {
							// llm-review — spawn a one-shot reviewer sub-agent
							if (this.skipLlmReview) {
								result = { passed: true, output: "LLM review skipped (BOBBIT_LLM_REVIEW_SKIP is set).", sessionId: stepSessionId };
							} else {
								const prompt = this.substituteVars(step.prompt || "", builtinVars, projectVars, agentVars, allGateStates);
								// See agent-qa branch above for the bounded vs. unbounded
								// retry rationale — kept symmetric so both review paths
								// survive a long provider rate-limit / overload window.
								const maxBoundedAttempts = 3;
								let finalAttempt = 0;
								// Each from-scratch attempt gets a FRESH reviewer session id so a
								// prior attempt's transcript is never clobbered — it stays viewable
								// at its original /session/<id> URL. The FIRST attempt keeps the
								// pre-generated `stepSessionId` (already broadcast via
								// gate_verification_step_started); attempts 2..N mint a new id and
								// re-broadcast the lineage so the UI can follow retired→new.
								// See tests2/core/verification-harness-review-reliability.test.ts.
								let attemptSessionId = stepSessionId;
								for (let attempt = 1; ; attempt++) {
									finalAttempt = attempt;
									if (active.cancelled) break;
									if (attempt > 1) {
										const retiredSessionId = attemptSessionId;
										attemptSessionId = `llm-review-${randomUUID().slice(0, 12)}`;
										console.log(`[verification][reviewer-lifecycle] llm-review "${step.name}" from-scratch retry attempt ${attempt}/${maxBoundedAttempts}: retiring session ${retiredSessionId ?? "<none>"} → fresh session ${attemptSessionId} (goal=${signal.goalId}, timeout=${reviewTimeoutSec}s). Prior transcript preserved.`);
										active.steps[index].startedAt = Date.now();
										if (!active.cancelled) this.broadcastFn(signal.goalId, {
											type: "gate_verification_step_started",
											goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
											stepIndex: index, stepName: step.name,
											startedAt: active.steps[index].startedAt,
											sessionId: attemptSessionId, timeoutSec: reviewTimeoutSec, phase,
										});
										const avRetry = this.activeVerifications.get(signal.id);
										if (avRetry && avRetry.steps[index]) {
											avRetry.steps[index].sessionId = attemptSessionId;
											avRetry.steps[index].timeoutSec = reviewTimeoutSec;
											this._persistActive();
										}
									} else {
										console.log(`[verification][reviewer-lifecycle] llm-review "${step.name}" attempt 1/${maxBoundedAttempts}: session ${attemptSessionId ?? "<none>"} (goal=${signal.goalId}, timeout=${reviewTimeoutSec}s).`);
									}
									result = await this.runLlmReviewStep(
										{ name: step.name, prompt, timeout: step.timeout, role: step.role },
										cwd, builtinVars,
										signal.content, signal.metadata,
										goalSpec, allGateStates, signal.goalId, attemptSessionId,
										gate,
									);
									if (result.status === "timeout") break;
									const decision = shouldRetryVerificationStep({
										passed: result.passed, output: result.output,
										attempt, maxBoundedAttempts,
										isTransient: isTransientReviewError,
									});
									if (decision === "break") break;
									const isBackoff = isProviderBackoffError(result.output);
									const delayMs = verificationRetryDelayMs(attempt, isBackoff);
									const attemptLabel = isBackoff ? `attempt ${attempt}, provider backoff — unbounded` : `attempt ${attempt}/${maxBoundedAttempts}`;
									console.log(`[verification] LLM review "${step.name}" failed transiently (${attemptLabel}), retrying in ${Math.round(delayMs / 1000)}s...`);
									await this._sleepCancellable(delayMs, () => !!active.cancelled);
								}
								if (!result.passed && result.status !== "timeout" && !active.cancelled) {
									result = { ...result, output: appendLlmReviewRecoveryDiagnostics(result.output, { attempts: finalAttempt, maxBoundedAttempts }) };
								}
							}
						}

						const duration_ms = Date.now() - startTime;

						// Build artifact for llm-review and human-signoff steps (agent-qa artifacts are set during execution).
						// Failed sign-offs surface their feedback to the team lead via the same
						// markdown-artifact channel as failed reviews — no extra steer plumbing needed.
						if (!artifact && (step.type === "llm-review" || step.type === "human-signoff") && result.output && result.output.length > 0) {
							artifact = {
								content: result.output.length > MAX_ARTIFACT_SIZE ? result.output.slice(0, MAX_ARTIFACT_SIZE) : result.output,
								contentType: "text/markdown",
							};
						}

						const resultStatus: TerminalGateSignalStepStatus = result.skipped ? "skipped" : result.status === "timeout" ? "timeout" : result.passed ? "passed" : "failed";
						if (!active.cancelled) this.broadcastFn(signal.goalId, {
							type: "gate_verification_step_complete",
							goalId: signal.goalId, gateId: signal.gateId, signalId: signal.id,
							stepIndex: index, stepName: step.name,
							status: resultStatus,
							durationMs: duration_ms, output: result.output || "",
							sessionId: result.sessionId, timeout: result.timeout, phase,
						});
						const av = this.activeVerifications.get(signal.id);
						if (av && av.steps[index]) {
							av.steps[index] = { ...av.steps[index], status: resultStatus as NonNullable<GateSignalStep["status"]>, phase, durationMs: duration_ms, output: result.output || "", sessionId: result.sessionId, timeout: result.timeout };
							this._persistActive();
						}
						const stepResult = {
							name: step.name,
							type: step.type,
							passed: result.passed,
							...(result.skipped ? { skipped: true } : {}),
							status: resultStatus,
							phase,
							output: result.output,
							duration_ms,
							expect: step.expect,
							...(result.timeout ? { timeout: result.timeout } : {}),
						} as GateSignalStep;
						if (artifact) stepResult.artifact = artifact;
						if (result.diagnostics) stepResult.diagnostics = result.diagnostics;
						return { index, stepResult };
					},
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
				status: "failed" as const,
				phase: steps[i].phase ?? 0,
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
			broadcastGateStatusChanged(this.broadcastFn, signal.goalId, signal.gateId, status);
			this.notifyTeamLead(signal.goalId, signal.gateId, status, { steps: results, goalBranch });
		} catch (err: any) {
			if (active.cancelled) {
				this.activeVerifications.delete(signal.id);
				this._persistActive();
				return;
			}
			const errorStep = { name: "Error", type: "command" as const, passed: false, status: "failed" as const, phase: 0, output: err.message, duration_ms: 0 };
			this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, {
				status: "failed",
				steps: [errorStep],
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
			broadcastGateStatusChanged(this.broadcastFn, signal.goalId, signal.gateId, "failed");
			this.notifyTeamLead(signal.goalId, signal.gateId, "failed", { steps: [errorStep], goalBranch });
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
	): Promise<ReviewStepExecutionResult> {
		const roleName = step.role || "reviewer";
		// Goal-scoped inline roles win over the role store. The default
		// "reviewer" role is used when an `llm-review` step omits `role`.
		// Either name may resolve from inlineRoles.
		const goalForLookup: PersistedGoal | undefined = goalId
			? this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId)
			: undefined;
		const role =
			resolveRoleFromGoal(goalForLookup, roleName, this.roleStore)
			?? resolveRoleFromGoal(goalForLookup, "reviewer", this.roleStore);
		if (!role) {
			const available = listAvailableRoles(goalForLookup, this.roleStore).join(", ") || "none";
			return { passed: false, output: `LLM review failed: '${roleName}' role not found. Available roles (inline + store): ${available}`, sessionId };
		}

		const timeoutMs = resolveReviewStepTimeoutSec({ type: "llm-review", timeout: step.timeout }) * 1000;

		const combinedPrompt = await buildReviewPrompt(role, step, cwd, builtinVars, signalContent, signalMetadata, goalSpec, allGateStates, gate, this.commandRunner);

		// Build the kickoff message.
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

		if (!this.sessionManager || !goalId) {
			throw new Error("LLM review requires an active SessionManager and goalId");
		}
		return this.runLlmReviewViaSession(step, cwd, goalId, role, combinedPrompt, kickoff, timeoutMs, sessionId);
	}

	// buildReviewPrompt is exported at module scope (below) so unit tests can
	// import it directly without going through a class instance.

	private _resolveReviewStepTimeoutSec(
		goalId: string | undefined,
		step: Pick<VerifyStep, "type" | "timeout" | "component">,
	): number {
		if (step.type !== "agent-qa") return resolveReviewStepTimeoutSec(step);
		const componentName = step.component
			?? (goalId ? this.resolveDefaultQaComponentName(goalId) : undefined)
			?? "";
		const qaMinutes = goalId
			? (this.resolveProjectConfigStore(goalId)?.getQaMaxDurationMinutes(componentName) ?? 10)
			: 10;
		return resolveReviewStepTimeoutSec(step, qaMinutes);
	}

	/** Distinguish a real idle turn from expiry of its active-thinking allowance. */
	private async waitForReviewTurn(
		sessionId: string,
		resultPromise: Promise<VerificationResult>,
		timeoutMs: number,
	): Promise<
		| ({ type: "result" } & VerificationResult)
		| { type: "idle" }
		| { type: "timeout"; elapsedMs: number }
	> {
		const startedAt = this.clock.now();
		try {
			return await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForIdle(sessionId, timeoutMs).then(() => ({ type: "idle" as const })),
			]);
		} catch (err) {
			const message = (err as Error)?.message || String(err);
			if (!/Timeout waiting for session .* to become idle/i.test(message)) throw err;
			const latest = this.sessionManager?.getSession(sessionId);
			const retryError = latest?.lastTurnErrored ? (latest.lastTurnErrorMessage || "") : "";
			// Auto-retry/provider capacity waiting is outside the active allowance.
			// Hand it to waitForReviewerErroredTurnRecovery rather than converting
			// a 429/529 backoff into a terminal review timeout.
			if (retryError && (latest?.pendingAutoRetryTimer || isProviderBackoffError(retryError))) {
				return { type: "idle" };
			}
			return {
				type: "timeout",
				elapsedMs: Math.max(timeoutMs, this.clock.now() - startedAt),
			};
		}
	}

	private reviewTimeoutResult(
		label: "LLM review" | "Agent QA",
		timeoutMs: number,
		elapsedMs: number,
		sessionId?: string,
	): ReviewStepExecutionResult {
		return {
			passed: false,
			status: "timeout",
			timeout: {
				configuredSeconds: timeoutMs / 1000,
				elapsedMs,
			},
			output: `${label} timed out after ${timeoutMs / 1000}s.`,
			sessionId,
		};
	}

	private async waitForReviewerErroredTurnRecovery(
		sessionId: string,
		resultPromise: Promise<VerificationResult>,
		timeoutMs: number,
		stepName: string,
	): Promise<
		| ({ type: "result" } & VerificationResult)
		| { type: "idle" }
		| { type: "timeout"; elapsedMs: number }
		| { type: "errored"; output: string }
	> {
		let dispatchedInfrastructureRecovery = false;
		for (;;) {
			const session = this.sessionManager?.getSession(sessionId);
			const errMsg = session?.lastTurnErrored ? (session.lastTurnErrorMessage || "") : "";
			if (!errMsg) return { type: "idle" };

			const backoffSuffix = describeProviderBackoff(session);
			if (!isRetryableLlmReviewRecovery(errMsg)) {
				return { type: "errored", output: `LLM review failed: ${errMsg}${backoffSuffix}` };
			}

			if (!session?.pendingAutoRetryTimer) {
				if (!dispatchedInfrastructureRecovery && isVerifierInfrastructureDisconnectError(errMsg)) {
					dispatchedInfrastructureRecovery = true;
					console.log(`[verification] Reviewer ${sessionId} for "${stepName}" ended with infrastructure/network error and no pending auto-retry; dispatching one continuation retry before failing...`);
					try {
						await this.sessionManager!.retryLastPrompt(sessionId, { auto: true });
					} catch (retryErr) {
						const retryMsg = (retryErr as Error)?.message || String(retryErr);
						return { type: "errored", output: `LLM review failed to resume after infrastructure/network disconnect: ${retryMsg}${backoffSuffix}` };
					}
				} else {
					return { type: "errored", output: `LLM review failed: ${errMsg}${backoffSuffix}` };
				}
			}

			const graceMs = isProviderBackoffError(errMsg)
				? REVIEWER_PROVIDER_BACKOFF_GRACE_MS
				: REVIEWER_ERRORED_TURN_GRACE_MS;
			console.log(`[verification] Reviewer ${sessionId} for "${stepName}" ended with retryable runtime error; waiting up to ${Math.round(graceMs / 1000)}s for session auto-retry to start...`);

			const started = await Promise.race([
				resultPromise.then((r: VerificationResult) => ({ type: "result" as const, ...r })),
				this.sessionManager!.waitForStreaming(sessionId, graceMs)
					.then(() => ({ type: "streaming" as const }))
					.catch(() => ({ type: "no-stream" as const })),
			]);
			if (started.type === "result") return started;
			if (started.type === "no-stream") {
				const latest = this.sessionManager?.getSession(sessionId);
				if (latest && !latest.lastTurnErrored) return { type: "idle" };
				const latestErr = latest?.lastTurnErrored ? (latest.lastTurnErrorMessage || errMsg) : errMsg;
				if (latest?.pendingAutoRetryTimer && isRetryableLlmReviewRecovery(latestErr)) continue;
				return { type: "errored", output: `LLM review failed: ${latestErr}${describeProviderBackoff(latest)}` };
			}

			const finished = await this.waitForReviewTurn(sessionId, resultPromise, timeoutMs);
			if (finished.type === "result" || finished.type === "timeout") return finished;
			// The auto-retry turn ended idle. Loop once more: if it errored, wait for
			// the next scheduled auto-retry; if it ended cleanly without the tool,
			// the caller will send the normal reminder.
		}
	}

	private async recoverVerifierAfterProcessDeath(args: {
		sessionId: string;
		stepName: string;
		label: string;
		prompt: string;
		resultPromise: Promise<VerificationResult>;
		timeoutMs: number;
	}): Promise<
		| ({ type: "result" } & VerificationResult)
		| { type: "timeout"; elapsedMs: number }
		| { type: "failed"; output: string }
	> {
		let lastError = "process not running";
		const sessionManager = this.sessionManager!;
		let attempts = 0;

		for (let attempt = 1; attempt <= MAX_VERIFIER_SAME_SESSION_RESURRECTIONS; attempt++) {
			attempts = attempt;
			console.log(`[verification][verifier-lifecycle] resurrection ${attempt}/${MAX_VERIFIER_SAME_SESSION_RESURRECTIONS} for ${args.label} verifier ${args.sessionId} (\"${args.stepName}\") — preserving same session id/history; freshAllowanceMs=${args.timeoutMs}.`);
			try {
				const existing = sessionManager.getSession(args.sessionId);
				if (existing && existing.status !== "terminated" && typeof sessionManager.restartAgent === "function") {
					await sessionManager.restartAgent(args.sessionId);
				} else if (typeof sessionManager.ensureSessionAlive === "function") {
					await sessionManager.ensureSessionAlive(args.sessionId);
				} else if (typeof sessionManager.restartAgent === "function") {
					await sessionManager.restartAgent(args.sessionId);
				} else {
					throw new Error("Session manager does not expose same-session resurrection");
				}

				const session = sessionManager.getSession(args.sessionId);
				if (!session?.rpcClient) throw new Error("Session missing after same-session resurrection");

				await dispatchTrackedSystemPrompt(session, args.prompt, {
					source: "verification",
					whenReady: typeof session.rpcClient.promptWhenReady === "function",
					now: () => this.clock.now(),
				});

				// Readiness, restart, prompt delivery, and this fixed settle window are
				// outside the fresh active-turn allowance.
				const started = await sessionManager.waitForStreaming(args.sessionId, REVIEWER_REMINDER_STREAM_SETTLE_MS)
					.then(() => true)
					.catch((err: any) => {
						lastError = (err as Error)?.message || String(err);
						return false;
					});

				if (!started) {
					lastError = `${lastError}; resurrected verifier did not start streaming`;
					break;
				}

				const finished = await this.waitForReviewTurn(args.sessionId, args.resultPromise, args.timeoutMs);
				if (finished.type === "result" || finished.type === "timeout") return finished;

				const recoveryResult = await this.waitForReviewerErroredTurnRecovery(args.sessionId, args.resultPromise, args.timeoutMs, args.stepName);
				if (recoveryResult.type === "result" || recoveryResult.type === "timeout") return recoveryResult;
				if (recoveryResult.type === "errored") {
					lastError = recoveryResult.output;
					if (isVerifierProcessDeathMessage(lastError)) continue;
					break;
				}

				const late = await raceResultWithLateVerdictGrace(this.clock, args.resultPromise, REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS);
				if (late.type === "result") return late;

				lastError = "verifier went idle without verification_result after same-session resurrection; not issuing duplicate resurrection prompts to an alive idle session";
				break;
			} catch (err: any) {
				lastError = (err as Error)?.message || String(err);
				if (!isVerifierProcessDeathMessage(lastError) && !isRetryableLlmReviewRecovery(lastError)) break;
			}
		}

		return {
			type: "failed",
			output: `${args.label} verifier process could not be recovered after ${attempts} same-session resurrection attempt(s): ${lastError}`,
		};
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
	): Promise<ReviewStepExecutionResult> {
		// Pause-cascade backstop: race-window guard. The mainline path is
		// blocked at `/gates/:id/signal` (server.ts), but a deep descendant
		// can be paused between signal-accept and verifier-spawn. Refuse to
		// create the llm-review session and surface a failed-result instead.
		if (goalId) {
			const g = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
			if (g?.paused) {
				throw new GoalPausedError(goalId);
			}
		}
		// Pre-generate sessionId so we can register the verification_result resolver and extension before session creation
		const sessionId = preGeneratedSessionId || `llm-review-${randomUUID().slice(0, 12)}`;

		// Set up verification_result promise. Wrap the resolver so a late verdict
		// (a verification_result POST that lands during/after teardown) is CAPTURED
		// even after we've stopped awaiting the promise — the `finally` below can
		// then honor it instead of returning the "did not call" hard failure.
		// This closes the delete-vs-late-POST race that used to 404-drop a real
		// pass (server.ts verification-result handler → pendingResults.get()).
		const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
		let capturedVerdict: VerificationResult | null = null;
		let hardFailureNoResult = false;
		const capturingResolver = (r: VerificationResult) => {
			if (!capturedVerdict) capturedVerdict = r;
			resultResolver(r);
		};
		this.pendingResults.set(sessionId, capturingResolver);

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
			const reviewerMeta = buildVerificationReviewerMeta({
				kind: "llm-review",
				roleName,
				goalId,
				roleAccessory: role.accessory,
				teamLeadSessionId: this.teamManager?.getTeamState(goalId)?.teamLeadSessionId,
			});

			const goalProjectId = this.projectContextManager?.getContextForGoal(goalId)?.project.id;
			if (!goalProjectId) throw new Error(`Cannot create verification review session: goal "${goalId}" has no projectId`);

			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName,
				...reviewerMeta,
				sandboxed: isSandboxed,
				projectId: goalProjectId,
				sessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
				initialModel: _preInitialModel,
				initialThinkingLevel: _preInitialThinking,
			});

			// Set title and metadata. `step.name` is optional — many inline
			// workflows skip it. Fall back to step.role / "Review" so the
			// sidebar never shows "undefined: <name>" as the title prefix.
			const funName = await generateTeamName("verification");
			const titlePrefix = step.name?.trim()
				|| (step.role ? `Review (${step.role})` : "Review");
			this.sessionManager!.setTitle(sessionId, `${titlePrefix}: ${funName}`);
			// Stamp teamLeadSessionId so the sidebar can nest this reviewer
			// under the team-lead that triggered the verification. Without
			// this, reviewer sessions persist with teamLeadSessionId=undefined
			// and the archived render path lumps them under "unmapped" — they
			// only surface under the LAST archived team-lead. Pure-helper
			// contract pinned by tests/verification-reviewer-meta.test.ts.
			this.sessionManager!.updateSessionMeta(sessionId, reviewerMeta);

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
						controlledFallback: controlledSessionModelFallback(this.preferencesStore),
					});
					console.log(`[verification] Applied role model policy for reviewer ${sessionId} (selected="${roleModel_r}", role=${roleName})`);
				} catch (err) {
					console.error(`[verification] Role model "${sanitizeModelErrorForLog(roleModel_r, 500)}" failed for reviewer ${sessionId}: ${sanitizeModelErrorForLog(err)}`);
					throw err;
				}
			} else if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				try {
					await applyReviewModelOverrides(session.rpcClient, {
						prefs: { get: (k) => this.preferencesStore!.get(k) },
						sessionManager: this.sessionManager ?? null,
						sessionId,
						role: "reviewer",
						skipSetModel: !!reviewModelPref && _preInitialModel === reviewModelPref,
						controlledFallback: controlledSessionModelFallback(this.preferencesStore),
					});
					if (reviewModelPref) {
						console.log(`[verification] Applied review model policy for ${sessionId} (selected="${reviewModelPref}")`);
					}
				} catch (err) {
					console.error(`[verification] applyReviewModelOverrides failed for reviewer ${sessionId} (pref="${reviewModelPref ? sanitizeModelErrorForLog(reviewModelPref, 500) : "<unset>"}"): ${sanitizeModelErrorForLog(err)}`);
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
			await dispatchTrackedSystemPrompt(session, kickoff, {
				source: "verification",
				now: () => this.clock.now(),
			});

			// Kickoff transport is outside the allowance. Once dispatched, distinguish
			// a real idle turn from expiry of the full active-thinking window.
			const result = await this.waitForReviewTurn(sessionId, resultPromise, timeoutMs);

			if (result.type === "result") {
				// Got structured result — still wait for agent to go idle (cleanup)
				await this.sessionManager!.waitForIdle(sessionId, 30_000).catch(() => {});
				return { passed: result.verdict, output: result.summary, sessionId };
			}
			if (result.type === "timeout") {
				return this.reviewTimeoutResult("LLM review", timeoutMs, result.elapsedMs, sessionId);
			}

			const recoveryResult = await this.waitForReviewerErroredTurnRecovery(sessionId, resultPromise, timeoutMs, step.name);
			if (recoveryResult.type === "result") {
				await this.sessionManager!.waitForIdle(sessionId, 30_000).catch(() => {});
				return { passed: recoveryResult.verdict, output: recoveryResult.summary, sessionId };
			}
			if (recoveryResult.type === "timeout") {
				return this.reviewTimeoutResult("LLM review", timeoutMs, recoveryResult.elapsedMs, sessionId);
			}
			if (recoveryResult.type === "errored") {
				return { passed: false, output: recoveryResult.output, sessionId };
			}

			// Agent went idle without calling the tool. Re-nudge the SAME live
			// session — it still has its full analysis in context, so a reminder is
			// far cheaper and more reliable than tearing it down and re-running from
			// scratch. Give each reminder a FAIR turn (don't tear down an actively
			// streaming reviewer) and send up to MAX_REVIEWER_REMINDERS of them
			// before escalating. This restores the pre-regression behavior; the
			// single under-graced reminder used to SIGTERM a reviewer that had
			// completed its review but missed the tool call.
			let reminderOutcome:
				| { type: "result"; verdict: boolean; summary: string }
				| { type: "errored"; output: string }
				| { type: "idle" } = { type: "idle" };
			for (let reminderNum = 1; reminderNum <= MAX_REVIEWER_REMINDERS; reminderNum++) {
				const jsonErr = lastErroredToolOutput ? detectJsonValidationError(lastErroredToolOutput) : null;
				const reminderPrompt = jsonErr ? buildJsonRetryPrompt(jsonErr) : buildContextRichReminder(kickoff);
				console.log(`[verification][reviewer-lifecycle] reminder ${reminderNum}/${MAX_REVIEWER_REMINDERS} to ${sessionId} for "${step.name}" (${jsonErr ? "JSON-retry" : "context-rich"}) — re-nudging same session (context preserved).`);
				await dispatchTrackedSystemPrompt(session, reminderPrompt, {
					source: "verification",
					now: () => this.clock.now(),
				});
				// Wait for the agent to actually pick up the reminder before racing
				// against waitForIdle — see _tryResumeFromSession for rationale. Give
				// it a fair settle window; if it never starts streaming we still loop
				// to the next reminder rather than tearing down after one nudge.
				const started = await this.sessionManager!.waitForStreaming(sessionId, REVIEWER_REMINDER_STREAM_SETTLE_MS).then(() => true).catch(() => false);
				if (!started) continue;
				const result2 = await this.waitForReviewTurn(sessionId, resultPromise, timeoutMs);
				if (result2.type === "result") {
					reminderOutcome = { type: "result", verdict: result2.verdict, summary: result2.summary };
					break;
				}
				if (result2.type === "timeout") {
					return this.reviewTimeoutResult("LLM review", timeoutMs, result2.elapsedMs, sessionId);
				}
				const postReminderRecovery = await this.waitForReviewerErroredTurnRecovery(sessionId, resultPromise, timeoutMs, step.name);
				if (postReminderRecovery.type === "result") {
					await this.sessionManager!.waitForIdle(sessionId, 30_000).catch(() => {});
					reminderOutcome = { type: "result", verdict: postReminderRecovery.verdict, summary: postReminderRecovery.summary };
					break;
				}
				if (postReminderRecovery.type === "timeout") {
					return this.reviewTimeoutResult("LLM review", timeoutMs, postReminderRecovery.elapsedMs, sessionId);
				}
				if (postReminderRecovery.type === "errored") {
					reminderOutcome = { type: "errored", output: postReminderRecovery.output };
					break;
				}
				// Idle without result. If the reviewer actually streamed this turn it
				// likely completed its analysis but its verdict POST is still in
				// flight — give a short settle grace and re-check the channel once
				// before deciding to nudge again / give up.
				if (started) {
					const late = await raceResultWithLateVerdictGrace(this.clock, resultPromise, REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS);
					if (late.type === "result") {
						reminderOutcome = { type: "result", verdict: late.verdict, summary: late.summary };
						break;
					}
				}
				// Otherwise loop and send another reminder (fair turn).
			}

			if (reminderOutcome.type === "result") {
				return { passed: reminderOutcome.verdict, output: reminderOutcome.summary, sessionId };
			}
			if (reminderOutcome.type === "errored") {
				return { passed: false, output: reminderOutcome.output, sessionId };
			}

			// Hard failure — reviewer never produced a verdict after fair reminders.
			// Flag it so the `finally` can still honor a verdict that lands during
			// teardown (the delete-vs-late-POST race) instead of dropping it.
			hardFailureNoResult = true;
			console.log(`[verification][reviewer-lifecycle] termination reason=reminder-exhausted for ${sessionId} ("${step.name}") after ${MAX_REVIEWER_REMINDERS} fair reminder(s) — no verification_result.`);
			return { passed: false, output: "Agent did not call verification_result after reminder.", sessionId };
		} catch (err: any) {
			const msg = err?.message || String(err);
			const isTimeout = msg.includes("timed out") || msg.includes("Timeout");
			const isProcessDeath = isVerifierProcessDeathMessage(msg);
			// If the underlying agent was stuck behind a provider rate-limit /
			// overload (corp-subscription quotas, Anthropic 429/529, etc.) the
			// generic active-turn timeout message buries the actual cause.
			// Pull the session's last-turn error state and surface it so the
			// reviewer output (and the team-lead notification that quotes it)
			// names the rate limit explicitly.
			const backoffSuffix = describeProviderBackoff(this.sessionManager?.getSession(sessionId));
			if (isProcessDeath) {
				console.error(`[verification] Reviewer agent process died during "${step.name}" (session ${sessionId}): ${msg}`);
				const recovered = await this.recoverVerifierAfterProcessDeath({
					sessionId,
					stepName: step.name,
					label: "LLM review",
					prompt: VERIFICATION_RESTART_RESUME_PROMPT,
					resultPromise,
					timeoutMs,
				});
				if (recovered.type === "result") {
					return { passed: recovered.verdict, output: recovered.summary, sessionId };
				}
				if (recovered.type === "timeout") {
					return this.reviewTimeoutResult("LLM review", timeoutMs, recovered.elapsedMs, sessionId);
				}
				return { passed: false, output: recovered.output, sessionId };
			}
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.${backoffSuffix}`
				: `LLM review failed: ${msg}${backoffSuffix}`;
			if (backoffSuffix) {
				console.warn(`[verification] Reviewer for "${step.name}" (session ${sessionId}) was stuck on provider backoff at timeout:${backoffSuffix}`);
			}
			return { passed: false, output: errOutput, sessionId };
		} finally {
			try { errListenerUnsub?.(); } catch { /* ignore */ }
			// Always clean up pending results, extension file, terminate, and unregister.
			//
			// ORDER MATTERS: terminate the session FIRST, then delete the pending
			// resolver. A verification_result POST can race the teardown — the
			// reviewer emits its verdict just as the harness gives up. If we deleted
			// the resolver before terminate (the old order), that late POST hit
			// server.ts's `pendingResults.get()` lookup, found nothing, and was
			// 404-dropped — a real pass silently lost. By keeping the resolver live
			// across terminateSession, a late verdict is still captured
			// (capturingResolver) and honored below.
			if (sessionId) {
				try {
					await this.sessionManager!.terminateSession(sessionId);
				} catch { /* ignore — session may already be terminated */ }
				this.pendingResults.delete(sessionId);
				if (this.teamManager) {
					try {
						await this.teamManager.unregisterReviewerSession(goalId, sessionId);
					} catch { /* ignore */ }
				}
				// If the reviewer's verdict landed during teardown and we were about
				// to return the "did not call verification_result" hard failure,
				// honor the late verdict instead of dropping it.
				if (hardFailureNoResult && capturedVerdict) {
					const v: VerificationResult = capturedVerdict;
					console.log(`[verification][reviewer-lifecycle] late verification_result for ${sessionId} ("${step.name}") arrived during teardown — honoring verdict=${v.verdict ? "pass" : "fail"} instead of the 'did not call' hard failure.`);
					// eslint-disable-next-line no-unsafe-finally
					return { passed: v.verdict, output: v.summary, sessionId };
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
	): Promise<ReviewStepExecutionResult & { artifact?: { content: string; contentType: string } }> {
		const QA_MAX_ARTIFACT = 10 * 1024 * 1024; // 10 MB — same limit as llm-review artifacts
		// Inline-roles-aware lookup. Same fallback chain as before: explicit
		// step.role first, then "qa-tester" / "test-engineer" / "reviewer"
		// — any of which may resolve from the goal's inline-roles snapshot
		// before the role-store cascade.
		const goalForLookup: PersistedGoal | undefined = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
		const role =
			resolveRoleFromGoal(goalForLookup, step.role || "qa-tester", this.roleStore)
			?? resolveRoleFromGoal(goalForLookup, "test-engineer", this.roleStore)
			?? resolveRoleFromGoal(goalForLookup, "reviewer", this.roleStore);
		if (!role) {
			const available = listAvailableRoles(goalForLookup, this.roleStore).join(", ") || "none";
			return { passed: false, output: `Agent QA failed: no 'qa-tester', 'test-engineer', or 'reviewer' role found. Available roles (inline + store): ${available}`, sessionId };
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
		const timeoutMs = resolveReviewStepTimeoutSec({ type: "agent-qa", timeout: step.timeout }, qaMinutes) * 1000;

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
		// Pre-generate sessionId and register the verification_result resolver
		// before session creation so same-session recovery can keep using the
		// original identity even when startup/prompt delivery fails.
		let qaSessionId: string | undefined = sessionId || `agent-qa-${randomUUID().slice(0, 12)}`;
		const { promise: resultPromise, resolve: resultResolver } = deferred<VerificationResult>();
		let qaCapturedVerdict: VerificationResult | null = null;
		let qaHardFailureNoResult = false;
		const qaCapturingResolver = (r: VerificationResult) => {
			if (!qaCapturedVerdict) qaCapturedVerdict = r;
			resultResolver(r);
		};
		this.pendingResults.set(qaSessionId, qaCapturingResolver);
		let qaLastErroredToolOutput: string | null = null;
		let qaErrListenerUnsub: (() => void) | undefined;
		try {
			// Create session via SessionManager
			const qaRoleName = role.name || step.role || "qa-tester";

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
			const qaReviewerMeta = buildVerificationReviewerMeta({
				kind: "agent-qa",
				roleName: qaRoleName,
				goalId,
				roleAccessory: role.accessory,
				teamLeadSessionId: this.teamManager?.getTeamState(goalId)?.teamLeadSessionId,
			});

			const qaGoalProjectId = this.projectContextManager?.getContextForGoal(goalId)?.project.id;
			if (!qaGoalProjectId) throw new Error(`Cannot create verification QA session: goal "${goalId}" has no projectId`);

			const session = await this.sessionManager!.createSession(cwd, undefined, goalId, undefined, {
				rolePrompt: combinedPrompt,
				roleName: qaRoleName,
				...qaReviewerMeta,
				sandboxed: qaIsSandboxed,
				projectId: qaGoalProjectId,
				sessionId: qaSessionId,
				skipAutoModel: true,
				skipAutoThinking: true,
				initialModel: _preQaInitialModel,
				initialThinkingLevel: _preQaInitialThinking,
			});
			qaSessionId = session.id;

			// Set title and metadata — same fallback as llm-review above.
			// Same teamLeadSessionId stamp so the sidebar can nest this QA
			// session under its triggering team-lead (see runLlmReviewStep
			// for the rationale; without this, QA sessions surface as
			// orphaned "unmapped" members).
			const qaFunName = await generateTeamName("verification");
			const qaTitlePrefix = step.name?.trim()
				|| (step.role ? `QA (${step.role})` : "QA");
			this.sessionManager!.setTitle(qaSessionId, `${qaTitlePrefix}: ${qaFunName}`);
			this.sessionManager!.updateSessionMeta(qaSessionId, qaReviewerMeta);

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
						controlledFallback: controlledSessionModelFallback(this.preferencesStore),
					});
					console.log(`[verification] Applied role model policy for QA ${qaSessionId} (selected="${roleModel_q}", role=${qaRoleName})`);
				} catch (err) {
					console.error(`[verification] Role model "${sanitizeModelErrorForLog(roleModel_q, 500)}" failed for QA ${qaSessionId}: ${sanitizeModelErrorForLog(err)}`);
					throw err;
				}
			} else if (this.preferencesStore) {
				const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
				try {
					await applyReviewModelOverrides(session.rpcClient, {
						prefs: { get: (k) => this.preferencesStore!.get(k) },
						sessionManager: this.sessionManager ?? null,
						sessionId: qaSessionId,
						role: "qa",
						skipSetModel: !!reviewModelPref && _preQaInitialModel === reviewModelPref,
						controlledFallback: controlledSessionModelFallback(this.preferencesStore),
					});
					if (reviewModelPref) {
						console.log(`[verification] Applied QA model policy for ${qaSessionId} (selected="${reviewModelPref}")`);
					}
				} catch (err) {
					console.error(`[verification] applyReviewModelOverrides failed for QA ${qaSessionId} (pref="${reviewModelPref ? sanitizeModelErrorForLog(reviewModelPref, 500) : "<unset>"}"): ${sanitizeModelErrorForLog(err)}`);
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
			await dispatchTrackedSystemPrompt(session, kickoff, {
				source: "verification",
				now: () => this.clock.now(),
			});

			// Kickoff transport is outside the allowance. Each active QA turn gets
			// the full resolved window once the prompt has been dispatched.
			const result = await this.waitForReviewTurn(qaSessionId, resultPromise, timeoutMs);

			if (result.type === "result") {
				// Got structured result — still wait for agent to go idle (cleanup)
				await this.sessionManager!.waitForIdle(qaSessionId, 30_000).catch(() => {});
				const artifact = result.reportHtml
					? { content: result.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
					: undefined;
				return { passed: result.verdict, output: result.summary, sessionId: qaSessionId, artifact };
			}
			if (result.type === "timeout") {
				return this.reviewTimeoutResult("Agent QA", timeoutMs, result.elapsedMs, qaSessionId);
			}

			const initialRecovery = await this.waitForReviewerErroredTurnRecovery(qaSessionId, resultPromise, timeoutMs, step.name);
			if (initialRecovery.type === "result") {
				await this.sessionManager!.waitForIdle(qaSessionId, 30_000).catch(() => {});
				const artifact = initialRecovery.reportHtml
					? { content: initialRecovery.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
					: undefined;
				return { passed: initialRecovery.verdict, output: initialRecovery.summary, sessionId: qaSessionId, artifact };
			}
			if (initialRecovery.type === "timeout") {
				return this.reviewTimeoutResult("Agent QA", timeoutMs, initialRecovery.elapsedMs, qaSessionId);
			}
			if (initialRecovery.type === "errored") {
				return { passed: false, output: initialRecovery.output, sessionId: qaSessionId };
			}

			// Agent went idle without calling the tool. Match llm-review fairness:
			// re-nudge the SAME session up to MAX_REVIEWER_REMINDERS times, wait for
			// streaming to actually start, then give the turn/late verdict a grace
			// window before terminating or step-level retry can happen.
			let qaReminderOutcome:
				| { type: "result"; verdict: boolean; summary: string; reportHtml?: string }
				| { type: "errored"; output: string }
				| { type: "idle" } = { type: "idle" };
			for (let reminderNum = 1; reminderNum <= MAX_REVIEWER_REMINDERS; reminderNum++) {
				const qaJsonErr = qaLastErroredToolOutput ? detectJsonValidationError(qaLastErroredToolOutput) : null;
				const qaReminderPrompt = qaJsonErr ? buildJsonRetryPrompt(qaJsonErr) : buildContextRichReminder(kickoff);
				console.log(`[verification][verifier-lifecycle] QA reminder ${reminderNum}/${MAX_REVIEWER_REMINDERS} to ${qaSessionId} for "${step.name}" (${qaJsonErr ? "JSON-retry" : "context-rich"}) — re-nudging same session (context preserved).`);
				await dispatchTrackedSystemPrompt(session, qaReminderPrompt, {
					source: "verification",
					now: () => this.clock.now(),
				});
				const started = await this.sessionManager!.waitForStreaming(qaSessionId, REVIEWER_REMINDER_STREAM_SETTLE_MS).then(() => true).catch(() => false);
				if (!started) continue;
				const result2 = await this.waitForReviewTurn(qaSessionId, resultPromise, timeoutMs);

				if (result2.type === "result") {
					qaReminderOutcome = { type: "result", verdict: result2.verdict, summary: result2.summary, reportHtml: result2.reportHtml };
					break;
				}
				if (result2.type === "timeout") {
					return this.reviewTimeoutResult("Agent QA", timeoutMs, result2.elapsedMs, qaSessionId);
				}

				const postReminderRecovery = await this.waitForReviewerErroredTurnRecovery(qaSessionId, resultPromise, timeoutMs, step.name);
				if (postReminderRecovery.type === "result") {
					await this.sessionManager!.waitForIdle(qaSessionId, 30_000).catch(() => {});
					qaReminderOutcome = { type: "result", verdict: postReminderRecovery.verdict, summary: postReminderRecovery.summary, reportHtml: postReminderRecovery.reportHtml };
					break;
				}
				if (postReminderRecovery.type === "timeout") {
					return this.reviewTimeoutResult("Agent QA", timeoutMs, postReminderRecovery.elapsedMs, qaSessionId);
				}
				if (postReminderRecovery.type === "errored") {
					qaReminderOutcome = { type: "errored", output: postReminderRecovery.output };
					break;
				}

				if (started) {
					const late = await raceResultWithLateVerdictGrace(this.clock, resultPromise, REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS);
					if (late.type === "result") {
						qaReminderOutcome = { type: "result", verdict: late.verdict, summary: late.summary, reportHtml: late.reportHtml };
						break;
					}
				}
			}

			if (qaReminderOutcome.type === "result") {
				const artifact = qaReminderOutcome.reportHtml
					? { content: qaReminderOutcome.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
					: undefined;
				return { passed: qaReminderOutcome.verdict, output: qaReminderOutcome.summary, sessionId: qaSessionId, artifact };
			}
			if (qaReminderOutcome.type === "errored") {
				return { passed: false, output: qaReminderOutcome.output, sessionId: qaSessionId };
			}

			// Hard failure — keep the resolver alive through teardown so a verdict
			// racing terminateSession is captured and honored in finally.
			qaHardFailureNoResult = true;
			console.log(`[verification][verifier-lifecycle] termination reason=reminder-exhausted for QA ${qaSessionId} ("${step.name}") after ${MAX_REVIEWER_REMINDERS} fair reminder(s) — no verification_result.`);
			return { passed: false, output: "Agent did not call verification_result after reminder.", sessionId: qaSessionId };
		} catch (err: any) {
			const msg = err?.message || String(err);
			const isTimeout = msg.includes("timed out") || msg.includes("Timeout");
			const isProcessDeath = isVerifierProcessDeathMessage(msg);
			// See runLlmReviewViaSession for rationale: surface provider
			// rate-limit / overload state so a "timed out" failure doesn't
			// hide a quota wall behind a generic timeout message.
			const backoffSuffix = qaSessionId
				? describeProviderBackoff(this.sessionManager?.getSession(qaSessionId))
				: "";
			if (isProcessDeath && qaSessionId) {
				console.error(`[verification] QA agent process died during "${step.name}" (session ${qaSessionId}): ${msg}`);
				const recovered = await this.recoverVerifierAfterProcessDeath({
					sessionId: qaSessionId,
					stepName: step.name,
					label: "Agent QA",
					prompt: buildQaRestartContinuationPrompt(kickoff),
					resultPromise,
					timeoutMs,
				});
				if (recovered.type === "result") {
					const artifact = recovered.reportHtml
						? { content: recovered.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
						: undefined;
					return { passed: recovered.verdict, output: recovered.summary, sessionId: qaSessionId, artifact };
				}
				if (recovered.type === "timeout") {
					return this.reviewTimeoutResult("Agent QA", timeoutMs, recovered.elapsedMs, qaSessionId);
				}
				return { passed: false, output: recovered.output, sessionId: qaSessionId };
			}
			const errOutput = isTimeout
				? `Agent QA timed out after ${(timeoutMs / 1000)}s.${backoffSuffix}`
				: `Agent QA failed: ${msg}${backoffSuffix}`;
			if (backoffSuffix) {
				console.warn(`[verification] QA agent for "${step.name}" (session ${qaSessionId}) was stuck on provider backoff at timeout:${backoffSuffix}`);
			}
			return { passed: false, output: errOutput, sessionId: qaSessionId };
		} finally {
			try { qaErrListenerUnsub?.(); } catch { /* ignore */ }
			if (qaSessionId) {
				// Terminate BEFORE deleting the pending resolver so a verdict POST
				// racing teardown is still captured, not 404-dropped (see the
				// delete-vs-late-POST fix in runLlmReviewViaSession).
				try { await this.sessionManager!.terminateSession(qaSessionId); } catch { /* ignore */ }
				this.pendingResults.delete(qaSessionId);
				if (this.teamManager) {
					try { await this.teamManager.unregisterReviewerSession(goalId, qaSessionId); } catch { /* ignore */ }
				}
				if (qaHardFailureNoResult && qaCapturedVerdict) {
					const v: VerificationResult = qaCapturedVerdict;
					const artifact = v.reportHtml
						? { content: v.reportHtml.slice(0, QA_MAX_ARTIFACT), contentType: "text/html" }
						: undefined;
					console.log(`[verification][verifier-lifecycle] late verification_result for QA ${qaSessionId} ("${step.name}") arrived during teardown — honoring verdict=${v.verdict ? "pass" : "fail"} instead of the 'did not call' hard failure.`);
					// eslint-disable-next-line no-unsafe-finally
					return { passed: v.verdict, output: v.summary, sessionId: qaSessionId, artifact };
				}
			}
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
	): Promise<{ passed: boolean; output: string; diagnostics?: GateStepDiagnostics }> {
		return new Promise((resolve) => {
			const normalizedCwd = cwd.replace(/\\/g, "/");
			// Shell selection: default to plain bash (fast), use --login only for
			// commands that need the full interactive PATH (npm, pytest, gh, etc.).
			const { shell: shellBin, args: shellArgs } = getVerificationShell(command);

			// Decide execution/recovery mode (see decideCommandRecoveryMode).
			//   detached      → host bash exit-file wrapper (durable host identity)
			//   container-exec→ attached docker exec + durable IN-CONTAINER exit/pid
			//                   files, re-attached via `docker exec` on resume
			//   pending-retry → not durable here (Windows w/o Git Bash); a restart
			//                   is a retryable pending interruption, never a verdict
			//   unsupported   → no streaming context; not recoverable
			const recoveryMode0: CommandRecoveryMode = decideCommandRecoveryMode({
				containerId,
				hasStreamCtx: !!streamCtx,
				platform: process.platform,
				hasGitBash: !!GIT_BASH,
			});
			// A non-durable command-step runner (tier-1 fake) cannot drive the
			// detached pid/exit-file wrapper or a durable in-container job. Downgrade
			// any durable mode to the attached, restart→pending/retryable path so NONE
			// of the durable file machinery (wrapper, pidFile, readProcessStartToken,
			// file tailers) runs against a fake. Production (real runner) is never
			// nonDurable, so this is a strict no-op there.
			const runnerNonDurable = !!this.commandStepRunner.nonDurable;
			// The `container-exec` arm is defensive-only: container steps are dispatched
			// by the `if (containerId)` branch below via a DIRECT spawnTracked call and
			// are never routed through this seam, so a fake never reaches container mode
			// in practice. Kept in the downgrade so that IF a nonDurable runner ever saw
			// a container step it would still avoid the durable in-container files.
			const recoveryMode: CommandRecoveryMode =
				runnerNonDurable && (recoveryMode0 === "detached" || recoveryMode0 === "container-exec") && !!streamCtx
					? "pending-retry"
					: recoveryMode0;
			let useDetached = recoveryMode === "detached";
			const useContainerDurable = recoveryMode === "container-exec" && !!streamCtx;
			let restartRecoveryUnsupportedReason: string | undefined =
				recoveryMode === "pending-retry"
					? (runnerNonDurable
						? "Command step executed via an injected non-durable command-step runner (tier-1 fake); the attached path is not durable, so a gateway restart leaves the step pending/retryable (re-run on the next signal), never a fabricated verdict."
						: "Windows command verification is using cmd.exe because Git Bash is unavailable; this attached path is not durable, so a gateway restart leaves the step pending/retryable (it is re-run on the next signal), never a fabricated verdict.")
					: undefined;

			if (recoveryMode === "pending-retry" && !runnerNonDurable && !VerificationHarness._warnedCmdExeDetached) {
				VerificationHarness._warnedCmdExeDetached = true;
				console.warn("[verification] Git Bash not found on Windows — durable detached command mode unavailable (cmd.exe cannot run the bash exit-file wrapper). A gateway restart mid-verification will leave command steps pending/retryable rather than recovered.");
			}
			let outFile: string | undefined;
			let errFile: string | undefined;
			let exitFile: string | undefined;
			let pidFile: string | undefined;
			let pidNonce: string | undefined;
			let heartbeatFile: string | undefined;
			let processStartToken: string | undefined;
			let diagnosticsPaths: GateStepDiagnosticsPaths | undefined;

			if (streamCtx) {
				try {
					diagnosticsPaths = prepareGateStepDiagnosticsPaths({
						stateDir: this._stateDir,
						goalId: streamCtx.goalId,
						gateId: streamCtx.gateId,
						signalId: streamCtx.signalId,
						stepIndex: streamCtx.stepIndex,
						stepName: this.activeVerifications.get(streamCtx.signalId)?.steps[streamCtx.stepIndex]?.name ?? `step-${streamCtx.stepIndex}`,
					});
					outFile = diagnosticsPaths.stdoutPath;
					errFile = diagnosticsPaths.stderrPath;
				} catch (err) {
					console.warn(`[verification] Failed to set up retained command diagnostics: ${(err as Error).message}`);
				}
			}

			if (useDetached && streamCtx) {
				try {
					const stepDir = path.join(this._stateDir, "verifications", streamCtx.signalId);
					fs.mkdirSync(stepDir, { recursive: true });
					if (!outFile || !errFile) {
						outFile = path.join(stepDir, `${streamCtx.stepIndex}.out`);
						errFile = path.join(stepDir, `${streamCtx.stepIndex}.err`);
					}
					exitFile = path.join(stepDir, `${streamCtx.stepIndex}.exit`);
					pidFile = path.join(stepDir, `${streamCtx.stepIndex}.pid.json`);
					heartbeatFile = path.join(stepDir, `${streamCtx.stepIndex}.heartbeat.json`);
					pidNonce = randomUUID();
					for (const file of [exitFile, exitFile + ".tmp", pidFile, pidFile + ".tmp", heartbeatFile, heartbeatFile + ".tmp"]) {
						try { fs.unlinkSync(file); } catch { /* not present */ }
					}
					fs.writeFileSync(outFile, "");
					fs.writeFileSync(errFile, "");
				} catch (err) {
					console.warn(`[verification] Failed to set up survival files — falling back to attached mode: ${(err as Error).message}`);
					useDetached = false;
					restartRecoveryUnsupportedReason = `Detached command recovery setup failed before spawn: ${(err as Error).message}`;
					outFile = diagnosticsPaths?.stdoutPath;
					errFile = diagnosticsPaths?.stderrPath;
					exitFile = undefined;
					pidFile = undefined;
					pidNonce = undefined;
					heartbeatFile = undefined;
				}
			}

			// Container durable recovery: persist exit/pid/heartbeat paths INSIDE
			// the container. The host cannot read them via `fs`; resume reads them
			// with `docker exec`. Host stdout/stderr streaming (outFile/errFile,
			// the pipe path) is unchanged so live output still works.
			let containerStateDir: string | undefined;
			if (useContainerDurable && streamCtx) {
				containerStateDir = `/tmp/.bobbit-verif/${streamCtx.signalId}`;
				exitFile = `${containerStateDir}/${streamCtx.stepIndex}.exit`;
				pidFile = `${containerStateDir}/${streamCtx.stepIndex}.pid`;
				heartbeatFile = `${containerStateDir}/${streamCtx.stepIndex}.heartbeat`;
				pidNonce = randomUUID();
			}

			const stampActiveCommandStep = (patch: Partial<ActiveVerification["steps"][number]>) => {
				if (!streamCtx) return;
				const av = this.activeVerifications.get(streamCtx.signalId);
				if (!av || !av.steps[streamCtx.stepIndex]) return;
				Object.assign(av.steps[streamCtx.stepIndex], patch);
				this._persistActive();
			};

			if (streamCtx) {
				const durable = useDetached || useContainerDurable;
				stampActiveCommandStep({
					outFile,
					errFile,
					exitFile,
					pidFile,
					pidNonce,
					heartbeatFile,
					containerId,
					bootEpoch: durable ? this.bootEpoch : undefined,
					timeoutSec,
					expectFailure,
					errorPattern,
					commandCwd: normalizedCwd,
					restartRecoveryMode: recoveryMode,
					restartRecoveryUnsupportedReason: durable ? undefined : (restartRecoveryUnsupportedReason ?? "Attached command execution cannot be recovered after gateway restart."),
				});
			}

			// Build the command to actually run. In detached mode we wrap so
			// the wrapper, not the gateway, owns writing the exit code atomically.
			let cmdToRun = command;
			if (useDetached && exitFile && pidFile && pidNonce && heartbeatFile && outFile && errFile) {
				const exitTmp = exitFile + ".tmp";
				const pidTmp = pidFile + ".tmp";
				const heartbeatTmp = heartbeatFile + ".tmp";
				const nonceJson = JSON.stringify(pidNonce);
				const qOut = shellSingleQuote(outFile);
				const qErr = shellSingleQuote(errFile);
				const writeIdentity = `printf '{"pid":%s,"nonce":%s}\\n' "$__bobbit_pid" ${shellSingleQuote(nonceJson)} > ${shellSingleQuote(pidTmp)} && mv ${shellSingleQuote(pidTmp)} ${shellSingleQuote(pidFile)}`;
				const writeHeartbeat = `printf '{"pid":%s,"nonce":%s,"ts":%s}\\n' "$__bobbit_pid" ${shellSingleQuote(nonceJson)} "$(date +%s 2>/dev/null || printf 0)" > ${shellSingleQuote(heartbeatTmp)} && mv ${shellSingleQuote(heartbeatTmp)} ${shellSingleQuote(heartbeatFile)}`;
				const trimLogs = `for __bobbit_f in ${qOut} ${qErr}; do if [ -f "$__bobbit_f" ] && [ "$(wc -c < "$__bobbit_f" 2>/dev/null || echo 0)" -gt ${MAX_RETAINED_LOG_BYTES} ]; then tail -c ${MAX_RETAINED_LOG_BYTES} "$__bobbit_f" > "$__bobbit_f.trim" 2>/dev/null && cat "$__bobbit_f.trim" > "$__bobbit_f" && rm -f "$__bobbit_f.trim"; fi; done`;
				// Run command in a subshell so its `exit` does not short-circuit our
				// exit-file write; capture $?, publish the durable verdict atomically,
				// then propagate. Publish BEFORE best-effort helper cleanup: under load,
				// Windows/Git-Bash can delay helper signalling/log trimming after the
				// command has already exited. Resume must not misclassify that gap as a
				// no-verdict restart interruption. Helper loops are signalled but not
				// waited on because a sleeping helper can deadlock wrapper completion.
				cmdToRun = `__bobbit_pid=$$; ${writeIdentity}; ( while :; do ${writeHeartbeat}; sleep 1; done ) & __bobbit_hb=$!; ( while kill -0 "$__bobbit_pid" 2>/dev/null; do ${trimLogs}; sleep 5; done ) & __bobbit_trim=$!; ( ${command}\n) >> ${qOut} 2>> ${qErr}; __ec=$?; printf %s "$__ec" > ${shellSingleQuote(exitTmp)} && mv ${shellSingleQuote(exitTmp)} ${shellSingleQuote(exitFile)}; kill "$__bobbit_hb" "$__bobbit_trim" 2>/dev/null; ${trimLogs}; exit $__ec`;
			}

			// Resolve a synchronously-thrown spawn error the same way we'd
			// handle child.on("error", ...) — surface the error text and honour
			// expectFailure semantics. Without this, accessing child.pid below
			// would throw TypeError and crash the verification pipeline.
			const finalizeDiagnostics = (): GateStepDiagnostics | undefined => {
				if (!diagnosticsPaths) return undefined;
				try {
					tailRetainCommandLogs(diagnosticsPaths.stdoutPath, diagnosticsPaths.stderrPath);
					return finalizeGateStepDiagnostics({ paths: diagnosticsPaths, commandCwd: normalizedCwd, containerId });
				} catch (err) {
					console.warn(`[verification] Failed to finalize retained command diagnostics: ${(err as Error).message}`);
					return undefined;
				}
			};
			const withDiagnostics = (result: { passed: boolean; output: string }): { passed: boolean; output: string; diagnostics?: GateStepDiagnostics } => {
				const diagnostics = finalizeDiagnostics();
				return diagnostics ? { ...result, diagnostics } : result;
			};
			const handleSpawnError = (err: Error): { passed: boolean; output: string; diagnostics?: GateStepDiagnostics } => {
				appendRetainedLogChunk(outFile, "");
				appendRetainedLogChunk(errFile, err.message);
				if (expectFailure && errorPattern) {
					try {
						const regex = new RegExp(errorPattern, "i");
						return withDiagnostics({ passed: regex.test(err.message), output: err.message });
					} catch {
						return withDiagnostics({ passed: false, output: `Invalid error_pattern regex when handling spawn error: ${err.message}` });
					}
				}
				return withDiagnostics({ passed: expectFailure, output: err.message });
			};

			// IMPORTANT: do NOT re-introduce `spawn(..., { timeout })` here.
			// Node's `timeout` option only kills the immediate child (the
			// shell), leaving descendants (npm, playwright, chromium) running.
			// The same is true for any direct `process.kill(child.pid, sig)`.
			// We use `spawnTracked` which spawns the child in its own process
			// group (POSIX `detached:true`) so the helper can kill the whole
			// tree via `process.kill(-pgid, sig)` (or `taskkill /T /F` on
			// Windows). The helper owns the timeout timer. See spawn-tree.ts.
			// This primitive is reusable; any caller that spawns a shell which
			// may itself spawn descendants should prefer it over raw spawn.
			let tracked: TrackedChild | undefined;
			let child: any;
			let spawnError: Error | undefined;
			try {
				if (containerId) {
					// Wrap the command so the in-container shell writes its PID
					// to a temp file. On timeout, we kill that PID's process
					// group — scoped to this step's subtree, not container-wide.
					// When durable recovery is enabled, the PID file is the
					// persisted in-container path and the wrapper also writes a
					// heartbeat + atomic exit-code file so a resume after gateway
					// restart can finalize from the exit code (or re-attach by
					// process group) instead of fabricating a verdict.
					const stepKillId = randomUUID().slice(0, 8);
					const killPidFile = useContainerDurable && pidFile ? pidFile : `/tmp/.bobbit-step-${stepKillId}.pid`;
					let wrappedCmd: string;
					if (useContainerDurable && containerStateDir && exitFile && heartbeatFile) {
						const qDir = shellSingleQuote(containerStateDir);
						const qPid = shellSingleQuote(killPidFile);
						const qHb = shellSingleQuote(heartbeatFile);
						const qExit = shellSingleQuote(exitFile);
						// POSIX sh; stdout/stderr intentionally NOT redirected so the
						// docker exec pipe keeps streaming live output to the host.
						wrappedCmd = `mkdir -p ${qDir} 2>/dev/null; __bp=$$; printf %s "$__bp" > ${qPid}.tmp && mv ${qPid}.tmp ${qPid}; ( while :; do printf '{"pid":%s,"ts":%s}' "$__bp" "$(date +%s 2>/dev/null || printf 0)" > ${qHb}.tmp && mv ${qHb}.tmp ${qHb}; sleep 1; done ) & __hb=$!; ( ${command}\n); __ec=$?; kill "$__hb" 2>/dev/null; wait "$__hb" 2>/dev/null; printf %s "$__ec" > ${qExit}.tmp && mv ${qExit}.tmp ${qExit}; exit $__ec`;
					} else {
						wrappedCmd = `echo $$ > ${killPidFile}; ${command}`;
					}
					const pidFileForKill = killPidFile;
					tracked = spawnTracked("docker", ["exec", "-w", normalizedCwd, containerId, "/bin/sh", "-c", wrappedCmd], {
						stdio: ["ignore", "pipe", "pipe"],
						timeoutMs: timeoutSec * 1000,
						env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
						onTimeout: () => {
							// Belt-and-braces: host-side tree-kill of `docker exec`
							// does not reliably reach in-container descendants.
							// Kill the step's own process group via the persisted
							// pid file — leaves other concurrent docker exec'd
							// processes (agent sessions, other verification steps,
							// bg-processes) untouched.
							try {
								const qp = shellSingleQuote(pidFileForKill);
								if (!this.commandRunner.spawn) throw new Error("CommandRunner.spawn is required for docker command cleanup");
								const killer = this.commandRunner.spawn("docker", [
									"exec", containerId, "/bin/sh", "-c",
									`p=$(cat ${qp} 2>/dev/null) && kill -TERM -- -$p 2>/dev/null; sleep 0.2; p=$(cat ${qp} 2>/dev/null) && kill -KILL -- -$p 2>/dev/null; rm -f ${qp}`,
								], { stdio: "ignore" });
								killer.on("error", () => { /* docker missing — best-effort */ });
							} catch { /* ignore */ }
						},
					});
				} else if (useDetached) {
					// Host durable path routed through the command-step seam (default =
					// realVerificationCommandRunner → the identical spawnTracked call).
					tracked = this.commandStepRunner.spawn({
						shellBin, shellArgs, cmdToRun, command,
						cwd: normalizedCwd,
						stdio: ["ignore", "ignore", "ignore"],
						timeoutMs: timeoutSec * 1000,
						windowsHide: process.platform === "win32",
						useDetached: true,
					});
				} else {
					// Host attached path routed through the seam (default = real spawn).
					tracked = this.commandStepRunner.spawn({
						shellBin, shellArgs, cmdToRun, command,
						cwd: normalizedCwd,
						stdio: ["ignore", "pipe", "pipe"],
						timeoutMs: timeoutSec * 1000,
						windowsHide: process.platform === "win32",
						useDetached: false,
					});
				}
				child = tracked.child;
			} catch (err) {
				spawnError = err as Error;
			}

			if (spawnError || !child || !tracked) {
				resolve(handleSpawnError(spawnError ?? new Error("spawn returned no child")));
				return;
			}

			// Register so cancellation / shutdown can tree-kill the live child.
			const trackedKey = streamCtx ? `${streamCtx.signalId}:${streamCtx.stepIndex}` : `__no_ctx_${child.pid ?? Date.now()}`;
			this._trackedCommandChildren.set(trackedKey, tracked);

			// Stamp the persisted step with everything needed for cross-restart
			// recovery before doing anything else — if the gateway dies right
			// now, the next boot must be able to verify the child identity before
			// reattaching or killing it.
			if (useDetached && streamCtx && child.pid != null) {
				const startTimeMs = Date.now();
				processStartToken = readProcessStartToken(child.pid);
				stampActiveCommandStep({
					pid: child.pid,
					startTimeMs,
					deadlineMs: startTimeMs + timeoutSec * 1000,
					processStartToken,
					outFile,
					errFile,
					exitFile,
					pidFile,
					pidNonce,
					heartbeatFile,
					bootEpoch: this.bootEpoch,
					timeoutSec,
					expectFailure,
					errorPattern,
					commandCwd: normalizedCwd,
					restartRecoveryMode: "detached",
					restartRecoveryUnsupportedReason: undefined,
				});
				// unref so the child does not keep the gateway alive during a
				// graceful shutdown — we want it to survive past our exit.
				try { child.unref(); } catch { /* ignore */ }
				// Mark for restart-survival so killAllTracked (called from
				// shutdown()) skips this entry. The next boot resumes via
				// _resumeCommandStep using durable identity + exit files.
				tracked!.markSurvival();
			} else if (useContainerDurable && streamCtx) {
				// Container durable path: the host `docker exec` client's pid is
				// not the in-container process, so we do not stamp `pid` (resume
				// re-attaches via `docker exec` reading the in-container pid/exit
				// files). Stamp timing + mark survival so a graceful shutdown does
				// not tear down the client and (potentially) the in-container job
				// before it writes its exit file.
				const startTimeMs = Date.now();
				stampActiveCommandStep({
					startTimeMs,
					deadlineMs: startTimeMs + timeoutSec * 1000,
					containerId,
					outFile,
					errFile,
					exitFile,
					pidFile,
					pidNonce,
					heartbeatFile,
					bootEpoch: this.bootEpoch,
					timeoutSec,
					expectFailure,
					errorPattern,
					commandCwd: normalizedCwd,
					restartRecoveryMode: "container-exec",
					restartRecoveryUnsupportedReason: undefined,
				});
				try { child.unref(); } catch { /* ignore */ }
				tracked!.markSurvival();
			}

			let stdout = "";
			let stderr = "";
			let stopTail: (() => void) | undefined;

			if (useDetached && streamCtx && outFile && errFile) {
				stopTail = this._startFileTailers(outFile, errFile, streamCtx);
			} else if (!useDetached) {
				const onData = (text: string, stream: "stdout" | "stderr") => {
					const target = stream === "stdout" ? outFile : errFile;
					appendRetainedLogChunk(target, text);
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

			let settled = false;
			let exitCode: number | null = null;
			let exitSignal: NodeJS.Signals | null = null;
			let closeGraceTimer: TimerHandle | undefined;
			let exitFilePollTimer: TimerHandle | undefined;
			// These timers are coupled to a real OS child process. Do not schedule them
			// on the injected/manual gateway clock used by tests; if the child emits
			// "exit" without a matching "close", virtual time would never advance and
			// verification would remain running until the outer test times out.
			const processClock = realClock;

			const settleFromProcess = (code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (closeGraceTimer) processClock.clearTimeout(closeGraceTimer);
				if (exitFilePollTimer) processClock.clearInterval(exitFilePollTimer);
				this._trackedCommandChildren.delete(trackedKey);
				try { stopTail?.(); } catch { /* ignore */ }

				let outText = stdout;
				let errText = stderr;
				if (useDetached && outFile && errFile) {
					tailRetainCommandLogs(outFile, errFile);
					outText = readCommandLogTail(outFile);
					errText = readCommandLogTail(errFile);
				}
				const tail = (outText + "\n" + errText).trim().slice(-5000);
				const didTimeOut = tracked!.timedOut();
				const didCancel = !didTimeOut && this._cancelledTrackedKeys.delete(trackedKey);

				if (didTimeOut) {
					const marker = `[step timed out after ${timeoutSec}s \u2014 killed subprocess tree]`;
					const combined = tail ? `${tail}\n${marker}` : marker;
					if (expectFailure) {
						// Honour expectFailure + errorPattern against the accumulated output.
						resolve(withDiagnostics(matchExpectFailure(null, combined, errorPattern)));
						return;
					}
					resolve(withDiagnostics({ passed: false, output: combined }));
					return;
				}
				if (didCancel) {
					const marker = `[step cancelled \u2014 killed subprocess tree]`;
					const combined = tail ? `${tail}\n${marker}` : marker;
					resolve(withDiagnostics({ passed: false, output: combined }));
					return;
				}
				if (expectFailure) {
					resolve(withDiagnostics(matchExpectFailure(code, tail, errorPattern)));
					return;
				}
				resolve(withDiagnostics({ passed: code === 0, output: tail || (signal ? `exit signal ${signal}` : `exit code ${code}`) }));
			};

			if (useDetached && exitFile) {
				// The durable wrapper writes the exit file after the command finishes.
				// In some Windows/Git-Bash runs the wrapper has already written stdout +
				// exit status, but Node never receives a prompt child close/exit event,
				// leaving the gate running until the outer test timeout. Treat the exit
				// file as the authoritative detached-command verdict on the live path too
				// (the restart path already does this).
				exitFilePollTimer = processClock.setInterval(() => {
					if (settled || !exitFile) return;
					let code: number | null = null;
					try {
						const raw = fs.readFileSync(exitFile, "utf8").trim();
						const parsed = parseInt(raw, 10);
						if (!Number.isFinite(parsed)) return;
						code = parsed;
					} catch {
						return;
					}
					try { if (child.pid) killTreeByPid(child.pid, "SIGKILL"); } catch { /* best-effort */ }
					settleFromProcess(code, null);
				}, 100);
				exitFilePollTimer.unref?.();
			}

			child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
				exitCode = code;
				exitSignal = signal;
				closeGraceTimer = processClock.setTimeout(() => {
					if (settled) return;
					const warning = `[verification] command process exited but stdio did not close within ${COMMAND_EXIT_CLOSE_GRACE_MS}ms; treating the process exit as authoritative and attempting to kill any remaining subprocess group.`;
					stderr += `${stderr ? "\n" : ""}${warning}`;
					appendRetainedLogChunk(errFile, `${warning}\n`);
					try { if (child.pid) killTreeByPid(child.pid, "SIGKILL"); } catch { /* best-effort */ }
					try { child.stdout?.destroy(); } catch { /* ignore */ }
					try { child.stderr?.destroy(); } catch { /* ignore */ }
					settleFromProcess(exitCode, exitSignal);
				}, COMMAND_EXIT_CLOSE_GRACE_MS);
				closeGraceTimer.unref?.();
			});
			child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
				settleFromProcess(code ?? exitCode, signal ?? exitSignal);
			});
			child.on("error", (err: Error) => {
				if (settled) return;
				settled = true;
				if (closeGraceTimer) processClock.clearTimeout(closeGraceTimer);
				if (exitFilePollTimer) processClock.clearInterval(exitFilePollTimer);
				this._trackedCommandChildren.delete(trackedKey);
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
				let stat = fs.statSync(filePath);
				if (stat.size > MAX_RETAINED_LOG_BYTES) {
					const retained = tailRetainCommandLogFile(filePath);
					stat = fs.statSync(filePath);
					pos = retained.truncated || pos > stat.size ? 0 : pos;
				}
				if (stat.size < pos) pos = 0;
				if (stat.size <= pos) return pos;
				const fd = fs.openSync(filePath, "r");
				try {
					const len = Math.min(stat.size - pos, 64 * 1024);
					const buf = Buffer.allocUnsafe(len);
					const bytesRead = fs.readSync(fd, buf, 0, len, pos);
					if (bytesRead <= 0) return pos;
					const text = buf.subarray(0, bytesRead).toString("utf8");
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
					return pos + bytesRead;
				} finally {
					try { fs.closeSync(fd); } catch { /* ignore */ }
				}
			} catch {
				return pos;
			}
		};

		// File tailing follows bytes written by an OS process, not logical gateway
		// time. Use wall-clock timers so live output still flows when tests inject
		// a manual clock for deterministic gateway timers.
		const interval = realClock.setInterval(() => {
			if (stopped) return;
			outPos = readNew(outFile, outPos, "stdout");
			errPos = readNew(errFile, errPos, "stderr");
		}, 200);

		return () => {
			if (stopped) return;
			stopped = true;
			realClock.clearInterval(interval);
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
	 * 2. Else if the persisted pidfile nonce plus process-start token or live
	 *    heartbeat verifies identity — poll for the exit file until the original
	 *    deadline, killing only that verified process tree on timeout.
	 * 3. Else — there is no durable command verdict or safe process identity,
	 *    so leave the gate pending/retryable instead of fabricating a failed
	 *    command result.
	 *
	 * Returns null only when a future command subtype has no restart recovery
	 * path at all; ordinary no-status command interruptions return an explicit
	 * restart-interrupted row.
	 */
	private async _resumeCommandStep(
		v: ActiveVerification,
		step: ActiveVerification["steps"][number],
	): Promise<ResumedVerificationStep | null> {
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
		const waitForDurableExitFile = async (): Promise<boolean> => {
			if (!step.exitFile) return false;
			const deadline = Date.now() + COMMAND_EXIT_CLOSE_GRACE_MS;
			while (this._isResumeStillActive(v) && Date.now() < deadline) {
				if (fs.existsSync(step.exitFile)) return true;
				// The wrapper publishes the exit code only after the command process
				// disappears. Under load, resume can observe that disappearance in the
				// short gap before the atomic exit-file rename. This wait is tied to a
				// real OS process, so keep it on the real clock rather than a test clock.
				await new Promise<void>(resolve => realClock.setTimeout(resolve, 50));
			}
			return fs.existsSync(step.exitFile);
		};
		const retainedTail = (): string => retainedCommandOutputTail(step.outFile, step.errFile);
		const finalizeDiagnostics = (): GateStepDiagnostics | undefined => {
			if (!step.outFile && !step.errFile) return undefined;
			const baseDir = path.dirname(step.outFile ?? step.errFile!);
			try {
				tailRetainCommandLogs(step.outFile, step.errFile);
				return finalizeGateStepDiagnostics({
					paths: {
						baseDir,
						stdoutPath: step.outFile ?? path.join(baseDir, "stdout.log"),
						stderrPath: step.errFile ?? path.join(baseDir, "stderr.log"),
						artifactsDir: path.join(baseDir, "artifacts"),
					},
					commandCwd: step.commandCwd ?? process.cwd(),
				});
			} catch (err) {
				console.warn(`[verification] Failed to finalize retained command diagnostics during resume: ${(err as Error).message}`);
				return undefined;
			}
		};
		const withDiagnostics = (result: ResumedVerificationStep) => {
			const diagnostics = finalizeDiagnostics();
			if (diagnostics) result.diagnostics = diagnostics;
			return result;
		};
		const restartInterrupted = (reason?: string) => {
			const tail = retainedTail();
			const parts = [
				"Step was interrupted by server restart before a durable command exit status was recorded. No command verdict was obtained; please re-signal the gate to run a fresh verification.",
			];
			if (reason) parts.push(reason);
			if (tail) parts.push(`Last retained output:\n${truncateForOutput(tail)}`);
			return withDiagnostics({
				name: step.name,
				type: step.type,
				passed: false,
				status: "waiting",
				output: parts.join("\n\n"),
				duration_ms: Date.now() - step.startedAt,
			});
		};
		const finalize = (code: number | null) => {
			const output = retainedTail();
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
			return withDiagnostics({
				name: step.name,
				type: step.type,
				passed,
				output: displayOutput,
				duration_ms: Date.now() - step.startedAt,
			});
		};
		const timeoutResult = () => {
			const timeoutSec = step.timeoutSec ?? 300;
			const marker = `[step timed out after ${timeoutSec}s — killed verified subprocess tree after restart]`;
			const tail = retainedTail();
			const combined = tail ? `${tail}\n${marker}` : marker;
			if (step.expectFailure) {
				const matched = matchExpectFailure(null, combined, step.errorPattern);
				return withDiagnostics({
					name: step.name,
					type: step.type,
					passed: matched.passed,
					output: matched.output,
					duration_ms: Date.now() - step.startedAt,
				});
			}
			return withDiagnostics({
				name: step.name,
				type: step.type,
				passed: false,
				status: "failed",
				output: combined,
				duration_ms: Date.now() - step.startedAt,
			});
		};

		// Case A: child already finished before we restarted. A durable exit file
		// is a real command verdict and keeps the existing expectFailure/errorPattern
		// semantics.
		if (step.exitFile && fs.existsSync(step.exitFile)) {
			if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resume: exit file present for "${step.name}" — finalizing from disk`);
			return finalize(readExitFile());
		}
		if (step.killReason === "timeout" && step.killCompletedAt) {
			return timeoutResult();
		}

		// Container durable recovery: the exit/pid/heartbeat files live INSIDE the
		// container and are read via `docker exec`, so the host `fs.existsSync`
		// Case A above never matched them. Re-attach by finalizing from the
		// in-container exit file, or by verifying the in-container process is
		// still alive (fresh heartbeat) and polling for its exit.
		if (step.restartRecoveryMode === "container-exec" && step.containerId && step.exitFile) {
			return await this._resumeContainerCommandStep(v, step, { finalize, timeoutResult, restartInterrupted });
		}

		const unsupportedRecoveryReason = (): string | undefined => {
			if (step.restartRecoveryUnsupportedReason) return step.restartRecoveryUnsupportedReason;
			if (step.containerId) return `Container command step for docker container "${step.containerId}" used attached docker exec; durable restart recovery is unsupported for this path.`;
			if (step.restartRecoveryMode === "unsupported") return "This command execution path was attached to the gateway and is not restart-recoverable.";
			return undefined;
		};

		if (step.restartRecoveryMode === "unsupported" || step.containerId) {
			return restartInterrupted(unsupportedRecoveryReason());
		}

		if (!step.exitFile) {
			return restartInterrupted(unsupportedRecoveryReason() ?? "No durable command exit file path was recorded before restart.");
		}

		const identityFile = await this._waitForCommandIdentityFile(step, () => this._isResumeStillActive(v));
		if (!this._isResumeStillActive(v)) return null;
		if (step.exitFile && fs.existsSync(step.exitFile)) {
			return finalize(readExitFile());
		}
		const identity = this._verifyPersistedCommandIdentity(step, identityFile);
		if (!identity.verified || !identity.pid) {
			if (identity.reason === "command process is no longer alive" && await waitForDurableExitFile()) {
				return finalize(readExitFile());
			}
			return restartInterrupted(`Could not verify command process identity after restart: ${identity.reason}`);
		}

		const timeoutSec = step.timeoutSec ?? 300;
		const deadline = step.deadlineMs ?? ((step.startTimeMs ?? step.startedAt) + timeoutSec * 1000);

		const finalizeTimeoutAfterVerifiedCleanup = async (unsafeReason: string): Promise<ResumedVerificationStep> => {
			if (step.killReason === "timeout" && step.killCompletedAt) return timeoutResult();
			const cleanup = await this._killVerifiedCommandStepForTimeout(v, step);
			if (cleanup.status === "settled") return timeoutResult();
			if (cleanup.status === "pending") {
				this._scheduleCommandKillCleanupRetry(v.signalId);
				throw new PendingCommandCleanupError(cleanup.reason ?? "Timeout cleanup is still pending for a verified command process.");
			}
			return restartInterrupted(cleanup.reason ?? unsafeReason);
		};

		if (this.clock.now() >= deadline) {
			return await finalizeTimeoutAfterVerifiedCleanup("The original timeout deadline elapsed, but the command identity could no longer be verified; refusing to kill a possibly reused PID.");
		}

		if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resume: verified pid ${identity.pid} for "${step.name}" still alive — polling for exit file (deadline in ${Math.max(0, Math.round((deadline - this.clock.now()) / 1000))}s)`);

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
			let identityFailureReason: string | undefined;
			while (this.clock.now() < deadline) {
				if (!this._isResumeStillActive(v)) return null;
				await new Promise<void>(r => this.clock.setTimeout(() => r(), 500));
				if (step.exitFile && fs.existsSync(step.exitFile)) {
					return finalize(readExitFile());
				}
				const current = this._verifyPersistedCommandIdentity(step);
				if (!current.verified) {
					identityFailureReason = current.reason;
					break;
				}
			}

			if (!this._isResumeStillActive(v)) return null;
			if (step.exitFile && fs.existsSync(step.exitFile)) {
				return finalize(readExitFile());
			}
			if (identityFailureReason === "command process is no longer alive" && await waitForDurableExitFile()) {
				return finalize(readExitFile());
			}
			if (this.clock.now() >= deadline) {
				return await finalizeTimeoutAfterVerifiedCleanup("The command reached its timeout after restart, but identity verification failed before it could be safely killed.");
			}

			// The process was alive and verified when resume started, but it exited or
			// lost its durable heartbeat without writing an exit file. That is not a
			// command verdict, so keep the gate pending/retryable.
			return restartInterrupted("The command process stopped after restart without writing a durable exit status.");
		} finally {
			if (stopTail) stopTail();
		}
	}

	/**
	 * Run a short `docker exec … /bin/sh -c <cmd>` and capture stdout. Best-effort:
	 * resolves `{ code: null }` on spawn error / timeout so resume logic can fall
	 * back gracefully. Used only by the container command resume path.
	 */
	private _dockerExecCapture(containerId: string, shellCmd: string, timeoutMs = 5_000): Promise<{ code: number | null; stdout: string }> {
		return new Promise(resolve => {
			let out = "";
			let done = false;
			let child: ReturnType<typeof spawn> | undefined;
			const finish = (code: number | null) => {
				if (done) return;
				done = true;
				try { child?.kill?.(); } catch { /* ignore */ }
				resolve({ code, stdout: out });
			};
			try {
				child = spawn("docker", ["exec", containerId, "/bin/sh", "-c", shellCmd], { stdio: ["ignore", "pipe", "ignore"] });
			} catch {
				resolve({ code: null, stdout: "" });
				return;
			}
			const timer = setTimeout(() => finish(null), timeoutMs);
			timer.unref?.();
			child.stdout?.on("data", (d: Buffer) => {
				out += d.toString();
				if (out.length > 65_536) out = out.slice(-65_536);
			});
			child.on("error", () => { clearTimeout(timer); finish(null); });
			child.on("close", (code: number | null) => { clearTimeout(timer); finish(code); });
		});
	}

	/**
	 * Resume a container command step after a gateway restart. The durable
	 * exit/pid/heartbeat files live inside the container, so re-attachment is
	 * done via `docker exec`:
	 *   1. Exit file present → finalize from the recovered exit code (honours
	 *      expectFailure/errorPattern), same as the host detached path.
	 *   2. Otherwise, while the in-container heartbeat is fresh and the deadline
	 *      has not passed, poll for the exit file.
	 *   3. On deadline → kill the in-container process group via `docker exec`
	 *      and return the timeout result.
	 *   4. Heartbeat stale and no exit file → the job stopped without a durable
	 *      verdict; return a retryable pending interrupt (never a fabricated
	 *      failure), matching the host detached semantics.
	 */
	private async _resumeContainerCommandStep(
		v: ActiveVerification,
		step: ActiveVerification["steps"][number],
		helpers: {
			finalize: (code: number | null) => ResumedVerificationStep;
			timeoutResult: () => ResumedVerificationStep;
			restartInterrupted: (reason?: string) => ResumedVerificationStep;
		},
	): Promise<ResumedVerificationStep | null> {
		const cid = step.containerId!;
		const readExit = async (): Promise<number | null> => {
			const r = await this._dockerExecCapture(cid, `cat ${shellSingleQuote(step.exitFile!)} 2>/dev/null`);
			const n = parseInt(r.stdout.trim(), 10);
			return Number.isFinite(n) ? n : null;
		};
		const heartbeatFresh = async (): Promise<boolean> => {
			if (!step.heartbeatFile) return false;
			const r = await this._dockerExecCapture(cid, `cat ${shellSingleQuote(step.heartbeatFile)} 2>/dev/null`);
			const m = r.stdout.match(/"ts":(\d+)/);
			if (!m) return false;
			const tsMs = parseInt(m[1], 10) * 1000;
			return Number.isFinite(tsMs) && (Date.now() - tsMs) < 15_000;
		};

		// 1. Already finished.
		let code = await readExit();
		if (code !== null) return helpers.finalize(code);

		const deadline = step.deadlineMs ?? ((step.startTimeMs ?? step.startedAt) + (step.timeoutSec ?? 300) * 1000);

		if (process.env.BOBBIT_DEBUG) console.log(`[verification] Resume: container step "${step.name}" — polling in-container exit file (deadline in ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s)`);

		// 2. Poll while the in-container process is alive (fresh heartbeat).
		while (this._isResumeStillActive(v) && Date.now() < deadline) {
			if (!(await heartbeatFresh())) break;
			await new Promise(r => setTimeout(r, 1_000));
			code = await readExit();
			if (code !== null) return helpers.finalize(code);
		}
		if (!this._isResumeStillActive(v)) return null;

		code = await readExit();
		if (code !== null) return helpers.finalize(code);

		// 3. Deadline elapsed → kill the in-container process group, then timeout.
		if (Date.now() >= deadline) {
			if (step.pidFile) {
				const qp = shellSingleQuote(step.pidFile);
				await this._dockerExecCapture(
					cid,
					`p=$(cat ${qp} 2>/dev/null) && kill -TERM -- -$p 2>/dev/null; sleep 0.2; p=$(cat ${qp} 2>/dev/null) && kill -KILL -- -$p 2>/dev/null`,
				).catch(() => undefined);
			}
			return helpers.timeoutResult();
		}

		// 4. Stopped without a durable verdict → retryable pending interrupt.
		return helpers.restartInterrupted("The in-container command process stopped after restart without writing a durable exit status.");
	}
	// ── Nested goals (subgoal verify-step) ───────────────────────────────
	// `runSubgoalStep` is the single integration point. Stamp-immediately,
	// stale-pointer invalidation, workflow-less recovery, paused != failed,
	// tier resolution — all encoded inline. See docs/nested-goals.md.

	/**
	 * Acquire/create the per-tree concurrency semaphore (default 3, max 8).
	 * Keyed by rootGoalId. Delegates to the unified `ChildTeamScheduler` so the
	 * harness shares ONE permit pool with the REST/POST start paths. `goalId`
	 * is retained for signature stability (tests stub this method); the
	 * scheduler resolves the cap from `rootGoalId` itself.
	 * See `goalManager.resolveRootMaxConcurrentChildren`.
	 */
	private _acquireRootSubgoalSemaphore(rootGoalId: string, _goalId: string): Semaphore {
		return this.childScheduler.getSemaphore(rootGoalId);
	}

	/**
	 * Public access to the unified child-team scheduler so the REST start
	 * paths (`spawn-child`, `integrate-child` auto-unblock) and `POST
	 * /api/goals` child creation can route their team starts through the same
	 * per-root concurrency cap. See `child-team-scheduler.ts`.
	 */
	get childTeamScheduler(): ChildTeamScheduler {
		return this.childScheduler;
	}

	/**
	 * Request a capacity-gated child-team start (REST/POST/auto-unblock paths).
	 * Returns `"started"` when a permit was free (the team start is kicked off),
	 * or `"capacity-blocked"` when the per-root cap is saturated (the caller
	 * must stamp the child `state='blocked'`; the scheduler starts it later when
	 * a permit frees). Thin delegator to `ChildTeamScheduler.requestStart`.
	 */
	requestChildStart(childGoalId: string): "started" | "capacity-blocked" {
		return this.childScheduler.requestStart(childGoalId);
	}

	/**
	 * Notify the scheduler of a terminal child event (merge / archive /
	 * completion) so its permit is released and the next capacity-blocked child
	 * starts. Best-effort + idempotent. Thin delegator to
	 * `ChildTeamScheduler.notifyTerminal`.
	 */
	notifyChildTerminal(childGoalId: string): void {
		this.childScheduler.notifyTerminal(childGoalId);
	}

	/**
	 * Scheduler callback — start a capacity-gated child's team. Mirrors the
	 * setup/start logic of the REST `spawn-child` / `integrate-child` handlers:
	 * a previously capacity-blocked child has `state='blocked'`, so flip it back
	 * to `todo`, then drive worktree setup + team start (or just team start when
	 * the worktree is already `ready`, e.g. a resumed goal). Broadcasts mirror
	 * the REST handlers so the UI updates identically.
	 *
	 * Returns the start PROMISE so the scheduler can release the held permit on
	 * an ASYNCHRONOUS start failure (e.g. the goal is paused/archived mid-start
	 * and `teamManager.startTeam` rejects). Returning here without propagating
	 * the rejection (the old detached swallow-log `.catch`) would leave the child
	 * holding a permit with no terminal event → permit leak → queue deadlock. A
	 * rejected promise tells the scheduler the team did NOT start; it releases
	 * the permit, re-enqueues the child, and drains the next eligible (the retry
	 * hits the worktree-ready else-branch and just re-runs `startTeam`).
	 */
	private _startScheduledChildTeam(childGoalId: string): void | Promise<void> {
		const ctx = this.projectContextManager?.getContextForGoal(childGoalId);
		const goalManager = ctx?.goalManager;
		const teamManager = this.teamManager;
		if (!goalManager || !teamManager) return;
		const g = goalManager.getGoal(childGoalId);
		// Throw (rather than silently return) for not-found / archived / paused so
		// the scheduler RELEASES the permit it acquired before calling us — never
		// leak it. A paused child is re-enqueued by the scheduler and stays queued
		// until resume; archived/missing children are dropped on the next drain.
		// (Primary guarantee is the scheduler's pre-acquire paused/archived skip;
		// this covers the race where the child is paused/archived in the window
		// between the eligibility check and this start.)
		if (!g) throw new Error(`[scheduler] child ${childGoalId} not found — not starting`);
		if (g.archived) throw new Error(`[scheduler] child ${childGoalId} is archived — not starting`);
		if (g.paused) throw new Error(`[scheduler] child ${childGoalId} is paused — not starting`);
		if (g.state === "blocked") {
			goalManager.updateGoal(childGoalId, { state: "todo" })
				.then(() => this.broadcastFn?.(childGoalId, { type: "goal_state_changed", goalId: childGoalId }))
				.catch((err) => console.warn(`[scheduler] flip blocked→todo failed for ${childGoalId} (non-fatal):`, err));
		}
		if (g.setupStatus === "preparing") {
			// Propagate the rejection (don't swallow) so the scheduler releases the
			// permit + re-enqueues when the team does not actually start.
			return goalManager.setupWorktreeAndStartTeam(childGoalId, () => teamManager.startTeam(childGoalId))
				.then(() => { this.broadcastFn?.(childGoalId, { type: "goal_setup_complete", goalId: childGoalId }); })
				.catch((err) => {
					const cur = goalManager.getGoal(childGoalId);
					if (cur?.setupStatus === "ready") {
						// Worktree finished but the team start raced (e.g. goal
						// paused/archived mid-start). The worktree work is preserved, so
						// surface setup-complete (no error UI) — but STILL rethrow so the
						// scheduler frees the permit; the re-enqueued retry takes the
						// worktree-ready else-branch and just re-runs startTeam.
						this.broadcastFn?.(childGoalId, { type: "goal_setup_complete", goalId: childGoalId });
						console.error(`[scheduler] auto-start team failed for ${childGoalId} (worktree ready):`, err);
					} else {
						console.error(`[scheduler] setup failed for ${childGoalId}:`, err);
						this.broadcastFn?.(childGoalId, { type: "goal_setup_error", goalId: childGoalId, error: String(err) });
					}
					throw err;
				});
		}
		// Worktree already exists (resumed/ready goal): just start the team.
		// Propagate failure so the scheduler releases the permit + re-enqueues.
		return Promise.resolve(teamManager.startTeam(childGoalId)).then(() => {}).catch((err) => {
			console.error(`[scheduler] startTeam failed for ${childGoalId}:`, err);
			throw err;
		});
	}

	/**
	 * C2: live concurrency-policy enforcement. `PATCH /api/goals/:id/policy`
	 * persists a new `maxConcurrentChildren`, but the per-root subgoal
	 * semaphore is cached on first use — without this, lowering 3→1 on a live
	 * root had no effect until restart. The policy handler calls this AFTER
	 * the goal record is updated so the cached semaphore is resized in place.
	 *
	 * Resizing respects in-flight permits (it never goes negative and never
	 * interrupts running children — see `Semaphore.resize`). When no semaphore
	 * has been created yet this is a no-op: lazy creation will read the fresh
	 * `resolveRootMaxConcurrentChildren` value.
	 *
	 * `newMax` SHOULD be the already-resolved integer cap
	 * (`goalManager.resolveRootMaxConcurrentChildren(rootGoalId)`); it is
	 * re-floored/clamped defensively by `Semaphore.resize`.
	 */
	resizeRootSubgoalSemaphore(rootGoalId: string, newMax: number): boolean {
		return this.childScheduler.resize(rootGoalId, newMax);
	}

	/**
	 * Tier-based plan-step child resolution. See docs/nested-goals.md.
	 *
	 * Returns the most relevant child for `(parentGoalId, planId)` along with
	 * the tier source so callers can short-circuit the success terminal vs.
	 * spawn fresh vs. fall through. Tie-break within a tier: most recent
	 * `createdAt`.
	 *
	 * Tiers:
	 *   1.  Live in-progress
	 *   1.5 Cached pointer on `active.steps[stepIndex].subgoal.childGoalId`
	 *       (tier-1 / tier-2 verified). Stale archived-non-complete pointer
	 *       INVALIDATES (stale archived non-complete cached pointer must be wiped).
	 *   2.  Archived + state=complete (success terminal)
	 *   3.  Live other (todo / paused / awaiting setup)
	 *   4.  Archived + non-complete (shelved dupe)
	 *   5.  Rescue: parentGoalId+title match where spawnedFromPlanId is unset
	 *       (stamp-immediately invariant defensive path). On hit, planId is back-filled.
	 *
	 * The cached pointer is wiped from `active` AND persisted via
	 * `_persistActive` whenever the resolved child is archived-non-complete or
	 * tier-1.5 mismatches the live state.
	 */
	/**
	 * R-012 — extract the four duplicated cache-wipe blocks. Wipes the
	 * cached `childGoalId` pointer on a subgoal step in `active.steps[i]`
	 * and persists the active verification record. No-ops when the active
	 * record / step / subgoal descriptor is missing.
	 */
	private _wipeSubgoalCachedPointer(
		active: ActiveVerification | undefined,
		stepIndex: number | undefined,
	): void {
		if (!active || stepIndex === undefined) return;
		const st = active.steps[stepIndex];
		if (st?.subgoal) {
			st.subgoal.childGoalId = undefined;
			this._persistActive();
		}
	}

	resolvePlanStepChild(
		parentGoalId: string,
		planId: string,
		opts?: {
			expectedTitle?: string;
			active?: ActiveVerification;
			stepIndex?: number;
		},
	): {
		child?: import("./goal-store.js").PersistedGoal;
		source: "live-active" | "cached-pointer" | "archived-complete" | "live-other" | "archived-other" | "rescue" | "none";
	} {
		const ctx = this.projectContextManager?.getContextForGoal(parentGoalId);
		if (!ctx) return { source: "none" };
		const goalStore = ctx.goalStore;

		const all = goalStore.getAll();
		const matchPlan = all.filter(g =>
			g.parentGoalId === parentGoalId && g.spawnedFromPlanId === planId,
		);
		const sortByCreatedDesc = <T extends { createdAt: number }>(arr: T[]) =>
			arr.slice().sort((a, b) => b.createdAt - a.createdAt);

		// Tier 1: live in-progress
		const tier1 = sortByCreatedDesc(matchPlan.filter(g => !g.archived && g.state === "in-progress"))[0];
		if (tier1) return { child: tier1, source: "live-active" };

		// Tier 1.5: cached pointer on the active step. Verify it still points at
		// a healthy candidate; otherwise invalidate (stale archived non-complete cached pointer must be wiped).
		const cachedId = opts?.active && opts?.stepIndex !== undefined
			? opts.active.steps[opts.stepIndex]?.subgoal?.childGoalId
			: undefined;
		if (cachedId) {
			const cached = goalStore.get(cachedId);
			if (cached) {
				if (cached.archived && cached.state === "complete") {
					return { child: cached, source: "cached-pointer" };
				}
				if (!cached.archived) {
					return { child: cached, source: "cached-pointer" };
				}
				// archived && state !== "complete" → stale pointer; wipe (R-012).
				this._wipeSubgoalCachedPointer(opts?.active, opts?.stepIndex);
			} else {
				// pointed-at goal vanished — wipe the pointer (R-012).
				this._wipeSubgoalCachedPointer(opts?.active, opts?.stepIndex);
			}
		}

		// Tier 2: archived + complete (success terminal)
		const tier2 = sortByCreatedDesc(matchPlan.filter(g => g.archived === true && g.state === "complete"))[0];
		if (tier2) return { child: tier2, source: "archived-complete" };

		// Tier 3: live other (todo / paused / awaiting setup)
		const tier3 = sortByCreatedDesc(matchPlan.filter(g => !g.archived && g.state !== "in-progress"))[0];
		if (tier3) return { child: tier3, source: "live-other" };

		// Tier 4: archived + non-complete (shelved dupe)
		const tier4 = sortByCreatedDesc(matchPlan.filter(g => g.archived === true && g.state !== "complete"))[0];
		if (tier4) return { child: tier4, source: "archived-other" };

		// Tier 5: rescue by (parentGoalId, title) on undefined planId — back-fill
		// spawnedFromPlanId so future lookups take the cheap tier-1 path.
		if (opts?.expectedTitle) {
			const rescue = sortByCreatedDesc(all.filter(g =>
				g.parentGoalId === parentGoalId &&
				g.spawnedFromPlanId === undefined &&
				g.title === opts.expectedTitle,
			))[0];
			if (rescue) {
				try {
					ctx.goalManager.updateGoal(rescue.id, { spawnedFromPlanId: planId }).catch(() => {});
				} catch { /* defensive */ }
				return { child: rescue, source: "rescue" };
			}
		}

		return { source: "none" };
	}

	/**
	 * Subgoal verify-step handler — the entire feature in one method.
	 *
	 * Each numbered block encodes one or more lessons:
	 *  1. Resolve descriptor.
	 *  2. Tier-based child lookup (tier preference: live in-progress > archived complete > live other > archived non-complete).
	 *  3. Stale archived non-complete invalidation (stale archived non-complete cached pointer must be wiped).
	 *  4. Success terminal short-circuit.
	 *  5. Workflow-less complete-child recovery (workflow-less complete-child recovery — legacy records).
	 *  6. Spawn (stamp-immediately invariant: stamp planId IMMEDIATELY) + worktree/team start.
	 *  7. Wait for ready-to-merge.
	 *  8. mergeChild + archive + teardown.
	 *  9. Concurrency cap (§3.5).
	 *
	 * Test budget: ~12-15 unit tests (one per lesson + happy paths). Each
	 * numbered block encodes a previously-shipped regression. Do not collapse.
	 */
	async runSubgoalStep(
		step: VerifyStep,
		signal: GateSignal,
		active: ActiveVerification,
		stepIndex: number,
	): Promise<{ passed: boolean; output: string }> {
		// ── 1. Resolve descriptor ─────────────────────────────────────
		const sg = step.subgoal;
		if (!sg || !sg.planId || !sg.title || sg.spec === undefined || sg.spec === null) {
			throw new Error(
				`runSubgoalStep: step "${step.name}" is missing required subgoal fields (planId, title, spec)`,
			);
		}
		const planId = sg.planId;
		const parentGoalId = signal.goalId;

		const ctx = this.projectContextManager?.getContextForGoal(parentGoalId);
		if (!ctx) {
			return { passed: false, output: `runSubgoalStep: parent goal ${parentGoalId} not found in any project context` };
		}
		const parent = ctx.goalStore.get(parentGoalId);
		if (!parent) {
			return { passed: false, output: `runSubgoalStep: parent goal ${parentGoalId} not found` };
		}
		const goalManager = ctx.goalManager;
		const teamManager = this.teamManager;
		const rootGoalId = parent.rootGoalId ?? parent.id;

		// Subgoal nesting-limit gate — mirrors the REST `POST /spawn-child`
		// path. Single source of truth in subgoal-nesting-limit.ts. We only
		// run the check on the spawn path; if the child is already resolved
		// (tier 1/3/5/cached) we skip — idempotent re-runs must not fail a
		// step that already produced a live child.
		const _nestingPrefs = readSubgoalNestingPrefs((k) => this.preferencesStore?.get(k));

		// Tag the active step with the planId early so cancellation paths /
		// restart-resume can correlate without spawn having succeeded yet.
		if (active.steps[stepIndex]) {
			if (!active.steps[stepIndex].subgoal) {
				active.steps[stepIndex].subgoal = { planId };
			} else {
				active.steps[stepIndex].subgoal!.planId = planId;
			}
			this._persistActive();
		}

		// ── 2 + 3. Tier resolution + stale-pointer invalidation ──────
		let resolved = this.resolvePlanStepChild(parentGoalId, planId, {
			expectedTitle: sg.title,
			active,
			stepIndex,
		});

		// stale-pointer invalidation: an archived non-complete child is a dead pointer; wipe and
		// fall through to spawn. resolvePlanStepChild already handled tier-1.5
		// pointer wipe; this guard handles the case where the resolved child
		// itself is archived-non-complete (tier-4 hit).
		if (resolved.source === "archived-other" && resolved.child) {
			this._wipeSubgoalCachedPointer(active, stepIndex);
			resolved = { source: "none" };
		}

		// ── 4. Success terminal short-circuit ─────────────────────────
		if (resolved.child && resolved.child.archived === true && resolved.child.state === "complete") {
			return { passed: true, output: `Subgoal already complete + archived (${resolved.source}): ${resolved.child.id}` };
		}

		// ── 5. Workflow-less complete-child recovery (workflow-less complete-child recovery — legacy records) ─────
		// Predicate is conjunctive AND narrow: state=complete + !archived + !workflow.
		if (
			resolved.child &&
			resolved.child.state === "complete" &&
			!resolved.child.archived &&
			!resolved.child.workflow
		) {
			const childId = resolved.child.id;
			try {
				const outcome = await goalManager.mergeChild(parentGoalId, childId);
				if (outcome.merged || outcome.alreadyMerged) {
					try { await teamManager?.teardownTeam(childId); } catch { /* non-fatal */ }
					await goalManager.archiveGoalAfterMerge(childId);
					return { passed: true, output: `Recovered workflow-less complete child ${childId} (${outcome.merged ? "merged" : "already merged"})` };
				}
				if (outcome.conflict) {
					return {
						passed: false,
						output: `Workflow-less child ${childId} has merge conflict — manual recovery required: see docs/nested-goals.md §recovery. ${truncateForOutput(outcome.output)}`,
					};
				}
			} catch (err) {
				return { passed: false, output: `Workflow-less child recovery failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}

		// Pause/cancel guard — do NOT spawn a child if this verification was
		// cancelled or the parent goal is paused. The REST `POST /spawn-child`
		// path already rejects paused parents; this mirrors it on the harness
		// path. Re-reads the parent from the store each call so a pause that
		// landed during an earlier await is seen. Checked BEFORE acquiring the
		// semaphore (cheap reject) AND again after acquisition immediately
		// before createGoal (pause/cancel can race during the acquire await).
		const _shouldAbortSpawn = (): { passed: boolean; output: string } | null => {
			if (active.cancelled) {
				return { passed: false, output: `runSubgoalStep: verification cancelled — not spawning child for plan "${planId}".` };
			}
			const fresh = ctx.goalStore.get(parentGoalId);
			if (fresh?.paused) {
				return { passed: false, output: `runSubgoalStep: parent goal ${parentGoalId} is paused — not spawning child for plan "${planId}".` };
			}
			return null;
		};
		const _preAcquireAbort = _shouldAbortSpawn();
		if (_preAcquireAbort) return _preAcquireAbort;

		// ── 6 + 7 + 8 + 9. Acquire semaphore → spawn or use existing → wait → merge ──
		const sem = this._acquireRootSubgoalSemaphore(rootGoalId, parentGoalId);
		await sem.acquire();
		// `permitHeld` tracks whether we currently own the semaphore permit. A
		// child created BLOCKED on unmet deps releases the permit while it waits
		// for the auto-unblock scan (holding it would deadlock a cap=1 root —
		// the dependency could never acquire a slot to run + merge) and
		// re-acquires before the in-flight ready-to-merge wait. The `finally`
		// only releases when we actually hold the permit.
		let permitHeld = true;
		try {
			let childGoalId: string;
			if (resolved.child) {
				// Existing live child (tier-1 / tier-3 / tier-5 / cached). Re-tag
				// the cached pointer in case tier-5 just back-filled the planId
				// or tier-1.5 was the path here.
				childGoalId = resolved.child.id;
				if (active.steps[stepIndex]?.subgoal) {
					active.steps[stepIndex].subgoal!.childGoalId = childGoalId;
					this._persistActive();
				}
				// Finding 3 — state-aware handling of an EXISTING live child.
				// Previously this branch ONLY stamped the pointer and fell
				// through to `_waitForChildReadyToMerge` while holding the
				// permit. That stranded a never-started `todo`/awaiting-setup
				// child (no team is ever started → waits forever) and, for a
				// `blocked` child, held the permit during the wait (re-creating
				// the cap=1 deadlock the fresh-blocked path is careful to avoid).
				// Re-read the live record (resolved.child may be a stale snapshot).
				const existing = ctx.goalStore.get(childGoalId) ?? resolved.child;
				if (existing.state === "blocked") {
					// Dep-blocked existing child: release the permit while waiting
					// for the auto-unblock scan (mirrors the fresh-blocked path —
					// holding it would deadlock a cap=1 root). Hand the freed slot
					// to any capacity-blocked sibling, then re-acquire + start.
					sem.release();
					permitHeld = false;
					this.childScheduler.startNextEligible(rootGoalId);
					const unblockOutcome = await this._waitForChildUnblock(parentGoalId, childGoalId, active);
					if (unblockOutcome === "cancelled") return { passed: false, output: "Cancelled" };
					if (unblockOutcome === "archived-complete") return { passed: true, output: `Subgoal already complete + archived (during dep-wait): ${childGoalId}` };
					if (unblockOutcome === "archived-other") return { passed: false, output: `Subgoal ${childGoalId} archived externally while blocked (state != complete) — re-signal to re-resolve` };
					if (unblockOutcome === "timeout") return { passed: false, output: `Subgoal ${childGoalId} blocked-dep wait timed out (>24h) — re-signal to retry` };
					await sem.acquire();
					permitHeld = true;
					// pause/cancel can race during the (re)acquire await.
					const _abortAfterUnblock = _shouldAbortSpawn();
					if (_abortAfterUnblock) return _abortAfterUnblock;
					await this._startChildTeam(childGoalId, goalManager, teamManager);
				} else if (existing.state === "in-progress") {
					// Team already running — just wait (holding the permit, which
					// correctly occupies a concurrency slot for the live child).
				} else {
					// Runnable existing child (todo / awaiting-setup) whose team was
					// never started (crash / restart / idempotent re-signal). Start
					// it under the held permit before waiting for ready-to-merge —
					// without this it would wait forever for a team that never runs.
					const _abortBeforeStart = _shouldAbortSpawn();
					if (_abortBeforeStart) return _abortBeforeStart;
					await this._startChildTeam(childGoalId, goalManager, teamManager);
				}
			} else {
				// Validate spec before spawning — reject placeholders so the child
				// team-lead always receives a real task in its first user message.
				const _specValidation = validateSpawnChildSpec(sg.spec ?? "");
				if (!_specValidation.ok) {
					return {
						passed: false,
						output: `runSubgoalStep: spec validation failed (${_specValidation.code}): ${_specValidation.error}`,
					};
				}
				// Enforce nesting limit BEFORE spawning a fresh child. The
				// outer `finally { sem.release() }` covers the early-return
				// paths below — do NOT release here.
				const _check = checkCanSpawnChild(parent, _nestingPrefs, (gid) => ctx.goalStore.get(gid));
				if (!_check.ok) {
					if (_check.code === "SUBGOALS_DISABLED") {
						return { passed: false, output: `Subgoal spawn blocked: subgoals are disabled for this goal tree.` };
					}
					if (_check.code === "PARENT_SUBGOALS_DISABLED") {
						return { passed: false, output: `Subgoal spawn blocked: parent goal "${parent.title}" doesn't allow sub-goals.` };
					}
					return {
						passed: false,
						output: `Subgoal spawn blocked: nesting depth limit reached (${_check.currentDepth}/${_check.maxDepth}).`,
					};
				}
				// Re-check pause/cancel after the semaphore await — pause or
				// cancel can race during acquisition. Returning here releases
				// the semaphore via the outer `finally`.
				const _postAcquireAbort = _shouldAbortSpawn();
				if (_postAcquireAbort) return _postAcquireAbort;

				// Spawn a fresh child. stamp-immediately invariant: stamp spawnedFromPlanId
				// IMMEDIATELY after createGoal — no other awaits or calls in
				// between. The very next line MUST be the updateGoal call.
				//
				// Resolve the child's workflow + roles with a cascade that
				// mirrors `goal_spawn_child` at server.ts:
				//   workflow: sg.workflowId (store lookup) → parent.workflow
				//             (stripped of subgoal verify-steps when it's a
				//             meta-workflow) → "feature" store lookup → first
				//             non-hidden workflow in the store.
				//   roles:    inherit `parent.inlineRoles` deep-cloned.
				// A parent that defined custom roles and a custom workflow
				// inline on itself expects every subgoal-spawned child to
				// inherit them — same invariant as `goal_spawn_child`.
				// R-003 — single-source workflow resolution shared with the
				// REST spawn-child path (see spawn-child-workflow.ts).
				const workflowStore = ctx.workflowStore;
				let { workflow: resolvedChildWorkflow, workflowId: childWorkflowId } =
					resolveChildWorkflow(parent, sg, undefined, workflowStore);
				// Spawn-time rewrite — every newly-spawned child gets a child-aware
				// `ready-to-merge` snapshot so it merges into parent's branch locally
				// and skips the PR step. See child-ready-to-merge.ts.
				if (parent.branch) {
					if (resolvedChildWorkflow) {
						resolvedChildWorkflow = adaptReadyToMergeForChild(
							resolvedChildWorkflow,
							{ parentBranch: parent.branch },
						);
					} else if (workflowStore) {
						// Cascade landed on an id-only tier (2/4/5). Materialise the
						// workflow from the store so we can stamp a child-aware
						// snapshot onto the child goal at create-time.
						const fromStore = workflowStore.get(childWorkflowId);
						if (fromStore) {
							resolvedChildWorkflow = adaptReadyToMergeForChild(
								structuredClone(fromStore),
								{ parentBranch: parent.branch },
							);
						}
					}
				}
				// R-032/033 — prefer structuredClone over JSON.parse/stringify
				// (this is the harness:3086 site called out by the review).
				const inheritedInlineRoles = parent.inlineRoles
					? structuredClone(parent.inlineRoles)
					: undefined;
				// R-002 — attribute harness-spawned children to the parent's
				// team-lead session so the sidebar nests them under the
				// spawning team-lead (matches POST /spawn-child). Routed through
				// the shared cascade so both spawn paths agree; tiers 1–3 do
				// not apply here (no HTTP body / headers) so this collapses to
				// tier-4 (parent's live team-lead) or tier-5 (undefined).
				const parentTeamLeadSessionId = resolveSpawnedBySessionId({
					parentGoalId,
					teamManager,
				}).value;
				const _childOverrides = inheritedChildOverrides(
					parent,
					_nestingPrefs,
					(id) => this.projectContextManager?.getContextForGoal(id)?.goalStore.get(id),
				);
				// dependsOn scheduling enforcement (mirrors POST /spawn-child):
				// resolve each declared dep planId to a sibling and check whether it
				// has merged (state=complete). Children with unresolved deps are
				// stamped state='blocked' (scheduler-managed, NOT operator 'paused')
				// and skip worktree/team start; they auto-resume when their last
				// dependency merges (see _autoUnblockDependents, run from §8 after
				// each child merge). Computed sync BEFORE createGoal so the
				// stamp-immediately invariant (no awaits between createGoal and the
				// spawnedFromPlanId updateGoal) is preserved.
				const _siblings = ctx.goalStore.getAll().filter(
					g => g.parentGoalId === parentGoalId,
				);
				const _unresolvedDeps = this._computeUnresolvedDeps(sg.dependsOn, _siblings);
				const _blocked = _unresolvedDeps.length > 0;
				const child = await goalManager.createGoal(sg.title, parent.cwd, {
					spec: sg.spec,
					workflowId: childWorkflowId,
					resolvedWorkflow: resolvedChildWorkflow,
					projectId: parent.projectId,
					sandboxed: parent.sandboxed,
					parentGoalId,
					inlineRoles: inheritedInlineRoles,
					subgoalsAllowed: _childOverrides.subgoalsAllowed,
					maxNestingDepth: _childOverrides.maxNestingDepth,
				});
				await goalManager.updateGoal(child.id, {
					spawnedFromPlanId: planId,
					...(parentTeamLeadSessionId ? { spawnedBySessionId: parentTeamLeadSessionId } : {}),
					// Stamp explicit dependsOn from the verify-step's subgoal
					// payload so the Plan tab synthesis can compute topological depth
					// + draw the right edges. Empty/missing → parallel sibling.
					...(sg.dependsOn !== undefined ? { dependsOnPlanIds: sg.dependsOn } : {}),
					// dependsOn scheduling: stamp state='blocked' atomically so the
					// child never has a runnable window with unresolved deps.
					...(_blocked ? { state: "blocked" as const } : {}),
				});
				// END stamp-immediately invariant critical sequence.

				// R-001 — initialise the child's gate state. Mirrors the
				// `initGatesForGoal` call in POST /api/goals/:id/spawn-child.
				// Without this, gateStore.getGatesForGoal(child.id) returns []
				// and `_waitForChildReadyToMerge` polls forever.
				if (child.workflow) {
					ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id));
				}

				childGoalId = child.id;
				if (active.steps[stepIndex]) {
					active.steps[stepIndex].subgoal = { childGoalId, planId };
					this._persistActive();
				}

				if (_blocked) {
					// Blocked child: do NOT start its team/worktree. Release the
					// per-root concurrency permit while we wait for the auto-unblock
					// scan (triggered by a dependency's merge in §8) to flip this
					// child blocked→todo. The scan only flips the state; THIS loop
					// re-acquires the permit and starts the team (see below) so the
					// start stays within the per-root cap. Holding the permit here
					// would deadlock a cap=1 root, where the dependency could never
					// acquire a slot to run + merge. Re-acquire before the in-flight
					// ready-to-merge wait below.
					sem.release();
					permitHeld = false;
					// Hand the freed slot to any capacity-blocked sibling.
					this.childScheduler.startNextEligible(rootGoalId);
					const unblockOutcome = await this._waitForChildUnblock(parentGoalId, childGoalId, active);
					if (unblockOutcome === "cancelled") return { passed: false, output: "Cancelled" };
					if (unblockOutcome === "archived-complete") return { passed: true, output: `Subgoal already complete + archived (during dep-wait): ${childGoalId}` };
					if (unblockOutcome === "archived-other") return { passed: false, output: `Subgoal ${childGoalId} archived externally while blocked (state != complete) — re-signal to re-resolve` };
					if (unblockOutcome === "timeout") return { passed: false, output: `Subgoal ${childGoalId} blocked-dep wait timed out (>24h) — re-signal to retry` };
					// Unblocked: the auto-unblock scan ONLY flipped this child
					// blocked→todo (waking the wait above); it deliberately did NOT
					// start the team, because the just-merged dependency may still
					// hold its per-root permit (cap=1) and starting there would run
					// this dependent outside the concurrency cap. Re-acquire the
					// permit and start the team HERE so it runs within the bound.
					await sem.acquire();
					permitHeld = true;
					await this._startChildTeam(childGoalId, goalManager, teamManager);
				} else {
					// Trigger worktree setup + team start (asynchronously kicked off;
					// `waitForReadyToMerge` polls the gate state regardless of when
					// setup completes).
					await this._startChildTeam(childGoalId, goalManager, teamManager);
				}
			}

			// ── 7. Wait for ready-to-merge ───────────────────────────
			const waitOutcome = await this._waitForChildReadyToMerge(parentGoalId, childGoalId, active);
			if (waitOutcome === "cancelled") {
				return { passed: false, output: "Cancelled" };
			}
			if (waitOutcome === "archived-complete") {
				return { passed: true, output: `Subgoal already complete + archived (during wait): ${childGoalId}` };
			}
			if (waitOutcome === "archived-other") {
				// Archived externally with a non-complete state — fall back to
				// tier resolution next signal; do NOT crash. Treat as failure
				// for THIS step so the harness re-runs naturally on re-signal.
				return { passed: false, output: `Subgoal ${childGoalId} archived externally (state != complete) — re-signal to re-resolve` };
			}
			if (waitOutcome === "timeout") {
				// R-011 — 24h ceiling exceeded. Release the semaphore via the
				// `finally` and surface a non-fatal failure so the harness
				// re-runs the step on the next signal (treated like
				// `archived-other` from the caller's perspective).
				return { passed: false, output: `Subgoal ${childGoalId} wait timed out (>24h) — re-signal to retry` };
			}
			// ready-to-merge passed — proceed to merge.

			// ── 8. Merge + archive ────────────────────────────────────
			const outcome = await goalManager.mergeChild(parentGoalId, childGoalId);
			if (outcome.merged || outcome.alreadyMerged) {
				// Durable merge-conflict flag: a successful merge clears any
				// prior conflict (data contract for /descendants).
				const _mc = ctx.goalStore.get(childGoalId);
				if (_mc?.mergeConflict) {
					try {
						await goalManager.updateGoal(childGoalId, { mergeConflict: false });
						this.broadcastFn?.(childGoalId, { type: "goal_state_changed", goalId: childGoalId });
					} catch (err) { console.warn(`[verification] failed to clear mergeConflict for ${childGoalId} (non-fatal):`, err); }
				}
				try { await teamManager?.teardownTeam(childGoalId); } catch { /* non-fatal */ }
				await goalManager.archiveGoalAfterMerge(childGoalId);
				// dependsOn scheduling — auto-unblock any sibling whose deps are now
				// ALL complete after this merge. Harness equivalent of the
				// integrate-child REST auto-unblock scan, which does NOT run on the
				// harness merge path. Best-effort: never fails the step.
				await this._autoUnblockDependents(parentGoalId, childGoalId, goalManager);
				return { passed: true, output: `Subgoal merged + archived (${outcome.merged ? "merged" : "already merged"}): ${childGoalId}` };
			}
			if (outcome.conflict) {
				// Durable merge-conflict flag: persist + broadcast so the Plan
				// tab can render this child's conflict across reloads. The child
				// is preserved (not auto-archived) for manual recovery.
				try {
					await goalManager.updateGoal(childGoalId, { mergeConflict: true });
					this.broadcastFn?.(childGoalId, { type: "goal_state_changed", goalId: childGoalId });
				} catch (err) { console.warn(`[verification] failed to set mergeConflict for ${childGoalId} (non-fatal):`, err); }
				return {
					passed: false,
					output: `Merge conflict between child ${childGoalId} and parent ${parentGoalId} — manual resolution required. See docs/nested-goals.md §conflicts. Conflict diagnostic: ${truncateForOutput(outcome.output)}`,
				};
			}
			return { passed: false, output: `Unexpected merge outcome (no merged/alreadyMerged/conflict flag): ${truncateForOutput(outcome.output)}` };
		} finally {
			if (permitHeld) {
				sem.release();
				// Terminal release for this harness-managed child — drive the next
				// capacity-blocked REST/POST child into the freed slot so the
				// per-root cap is unified across all start paths.
				this.childScheduler.startNextEligible(rootGoalId);
			}
		}
	}

	/**
	 * dependsOn scheduling — resolve each declared dependency planId to a
	 * sibling and return those that have NOT merged (state != "complete").
	 * Mirrors the REST `POST /spawn-child` dependency check so both spawn paths
	 * agree on what "unmet" means. A missing sibling counts as unmet.
	 */
	private _computeUnresolvedDeps(
		dependsOn: string[] | undefined,
		siblings: Array<{ spawnedFromPlanId?: string; state: string }>,
	): string[] {
		const unresolved: string[] = [];
		if (dependsOn && dependsOn.length > 0) {
			for (const depPlanId of dependsOn) {
				const sibling = siblings.find(g => g.spawnedFromPlanId === depPlanId);
				if (!sibling || sibling.state !== "complete") unresolved.push(depPlanId);
			}
		}
		return unresolved;
	}

	/**
	 * Start a child's worktree + team. Prefers the test seam
	 * (`_subgoalHooks.setupChildAndStartTeam`); otherwise kicks off the real
	 * `setupWorktreeAndStartTeam` fire-and-forget (the ready-to-merge wait polls
	 * regardless of when setup completes). Used by the fresh-spawn path and by
	 * a previously-blocked child's own runSubgoalStep once it re-acquires the
	 * per-root permit (after `_autoUnblockDependents` flips it blocked→todo) so
	 * every team start stays within the concurrency cap.
	 */
	private async _startChildTeam(
		childGoalId: string,
		goalManager: import("./goal-manager.js").GoalManager,
		teamManager: import("./team-manager.js").TeamManager | undefined,
	): Promise<void> {
		if (this._subgoalHooks?.setupChildAndStartTeam) {
			try { await this._subgoalHooks.setupChildAndStartTeam(childGoalId); } catch (err) {
				console.warn(`[verification] setupChildAndStartTeam hook failed for ${childGoalId}:`, err);
			}
			return;
		}
		if (teamManager) {
			goalManager.setupWorktreeAndStartTeam(childGoalId, async () => {
				return teamManager.startTeam(childGoalId);
			}).catch((err) => {
				console.warn(`[verification] setupWorktreeAndStartTeam failed for child ${childGoalId} (non-fatal):`, err);
			});
		}
	}

	/**
	 * Harness equivalent of the integrate-child REST auto-unblock scan. After a
	 * child merges (state=complete + archived), flip any sibling whose
	 * `dependsOnPlanIds` are now ALL resolved from state='blocked' → 'todo'.
	 * This scan flips state ONLY — it does NOT start the unblocked child's
	 * team. Each harness-spawned blocked child is parked in its own
	 * `runSubgoalStep`/`_waitForChildUnblock` loop (having released its per-root
	 * permit); the state flip wakes that loop, which re-acquires the semaphore
	 * and starts the team within the concurrency cap. Starting the team here
	 * would bypass the semaphore (the just-merged dependency may still hold its
	 * permit under cap=1) and double-start once the waiting loop resumes. The
	 * REST scan only runs on the integrate-child HTTP path; harness-driven
	 * merges (runSubgoalStep §8) need this so the parent-workflow path enforces
	 * dependsOn scheduling end-to-end. A multi-dep child only unblocks when its
	 * LAST dependency merges.
	 *
	 * Best-effort: never throws (logs + swallows) so a scan failure can't fail
	 * the merge that already succeeded.
	 */
	private async _autoUnblockDependents(
		parentGoalId: string,
		mergedChildId: string,
		goalManager: import("./goal-manager.js").GoalManager,
	): Promise<void> {
		try {
			const ctx = this.projectContextManager?.getContextForGoal(parentGoalId);
			if (!ctx) return;
			const all = ctx.goalStore.getAll();
			const mergedPlanId = ctx.goalStore.get(mergedChildId)?.spawnedFromPlanId;
			if (!mergedPlanId) return;
			const siblings = all.filter(g => g.parentGoalId === parentGoalId && !g.archived && g.id !== mergedChildId);
			for (const sib of siblings) {
				const deps = sib.dependsOnPlanIds;
				if (!deps || deps.length === 0) continue;
				if (!deps.includes(mergedPlanId)) continue;
				if (sib.state !== "blocked") continue;
				const allResolved = deps.every(depPid => {
					const depSib = all.find(g =>
						g.parentGoalId === parentGoalId && g.spawnedFromPlanId === depPid);
					return !!depSib && depSib.state === "complete";
				});
				if (!allResolved) continue;
				// Unblock: flip state='blocked' → 'todo' ONLY. Do NOT start the
				// team here. Each harness-spawned blocked child is parked in its
				// own runSubgoalStep `_waitForChildUnblock` poll (it released its
				// permit before waiting); flipping the state wakes that loop, which
				// RE-ACQUIRES the per-root semaphore and starts the team within the
				// concurrency cap. Starting the team here would (a) bypass the
				// semaphore — the just-merged dependency may still hold its permit
				// under cap=1, so the dependent would run outside the cap — and
				// (b) double-start once the waiting loop resumes. The semaphore
				// remains the authoritative concurrency bound.
				await goalManager.updateGoal(sib.id, { state: "todo" });
				this.broadcastFn?.(sib.id, { type: "goal_state_changed", goalId: sib.id });
			}
		} catch (err) {
			console.error(`[verification] auto-unblock scan failed (non-fatal):`, err);
		}
	}

	/**
	 * Wait for a BLOCKED child to be auto-unblocked (state transitions away from
	 * 'blocked'), or for a terminal exit condition. Polls the live goal record;
	 * `_autoUnblockDependents` flips state blocked→todo (state only — it does
	 * NOT start the team) when the child's last dependency merges. Does NOT hold
	 * the per-root semaphore (the caller releases it before calling this) so a
	 * cap=1 root can still run + merge the dependency. On return the caller
	 * re-acquires the permit and starts the team within the cap.
	 *
	 * Exit conditions mirror `_waitForChildReadyToMerge`:
	 *   - active.cancelled → "cancelled"
	 *   - child gone / cross-tree → "archived-other"
	 *   - child.archived && state === "complete" → "archived-complete"
	 *   - child.archived && state !== "complete" → "archived-other"
	 *   - state !== "blocked" → "unblocked"
	 *   - >24h → "timeout"
	 */
	private async _waitForChildUnblock(
		parentGoalId: string,
		childGoalId: string,
		active: ActiveVerification,
	): Promise<"unblocked" | "archived-complete" | "archived-other" | "cancelled" | "timeout"> {
		const ctx = this.projectContextManager?.getContextForGoal(childGoalId);
		if (!ctx) return "archived-other";
		const POLL_MS = 100;
		const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
		const startedAt = this.clock.now();
		while (true) {
			if (active.cancelled) return "cancelled";
			const child = ctx.goalStore.get(childGoalId);
			if (!child) return "archived-other";
			if (child.parentGoalId !== parentGoalId) return "archived-other";
			if (child.archived === true) {
				return child.state === "complete" ? "archived-complete" : "archived-other";
			}
			if (child.state !== "blocked") return "unblocked";
			if (this.clock.now() - startedAt >= MAX_WAIT_MS) return "timeout";
			await new Promise<void>(r => this.clock.setTimeout(() => r(), POLL_MS));
		}
	}

	/**
	 * Wait for a child goal's `ready-to-merge` gate to pass, or for a terminal
	 * exit condition. Default polling interval 500 ms.
	 *
	 * Exit conditions:
	 *   - active.cancelled → "cancelled"
	 *   - child.archived && state === "complete" → "archived-complete"
	 *   - child.archived && state !== "complete" → "archived-other"
	 *   - ready-to-merge gate state === "passed" → "passed"
	 *
	 * Paused children continue waiting (paused-children-not-in-flight rule — paused != failed).
	 */
	private async _waitForChildReadyToMerge(
		_parentGoalId: string,
		childGoalId: string,
		active: ActiveVerification,
	): Promise<"passed" | "archived-complete" | "archived-other" | "cancelled" | "timeout"> {
		// Test seam: allow callers to swap in a deterministic resolver.
		if (this._subgoalHooks?.waitForReadyToMerge) {
			const aborter = { aborted: !!active.cancelled };
			// keep aborter.aborted in sync with active.cancelled (best effort)
			const sync = this.clock.setInterval(() => { aborter.aborted = !!active.cancelled; }, 50);
			try {
				return await this._subgoalHooks.waitForReadyToMerge(childGoalId, aborter);
			} finally {
				this.clock.clearInterval(sync);
			}
		}

		const ctx = this.projectContextManager?.getContextForGoal(childGoalId);
		if (!ctx) return "archived-other"; // child evaporated — equivalent to external archive
		const POLL_MS = 500;
		// R-011 — cap the wait at 24h so a stuck child can't hold a
		// rootSubgoalSemaphore slot indefinitely. The caller treats
		// `"timeout"` like `"archived-other"` (release semaphore + retry on
		// the next harness pass).
		const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
		const startedAt = this.clock.now();
		while (true) {
			if (active.cancelled) return "cancelled";
			const child = ctx.goalStore.get(childGoalId);
			if (!child) return "archived-other";
			// R-034 — defensive: if a tier-resolver bug somehow yields a child
			// belonging to a different parent (cross-tree), treat it as
			// externally archived rather than waiting on it.
			if (child.parentGoalId !== _parentGoalId) return "archived-other";
			if (child.archived === true) {
				return child.state === "complete" ? "archived-complete" : "archived-other";
			}
			const rtm = ctx.gateStore.getGate(childGoalId, "ready-to-merge");
			if (rtm?.status === "passed") return "passed";
			if (this.clock.now() - startedAt >= MAX_WAIT_MS) return "timeout";
			// paused / pending / failed all continue the wait — only an external
			// archive or a passed ready-to-merge is terminal.
			await new Promise<void>(r => this.clock.setTimeout(() => r(), POLL_MS));
		}
	}
}

/**
 * Truncate a multi-line output blob for inclusion in a step's `output` field
 * without bloating the gate-status payload. Mirrors the convention used by
 * `runCommandStep` (last 5KB).
 */
function truncateForOutput(s: string | undefined, max = 4000): string {
	if (!s) return "";
	return s.length > max ? `…${s.slice(-max)}` : s;
}

