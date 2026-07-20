/**
 * Per-component worktree setup runner.
 *
 * Sequentially executes each component's `worktreeSetupCommand` (when set)
 * with its `cwd` resolved via `componentRoot()` and `SOURCE_REPO` pointing
 * at the matching component path in the project's primary checkout.
 *
 * Test hook: the caller injects `exec` so unit tests can pass a recorder
 * stub and Docker-mode callers can pass `_dockerExec` directly.
 *
 * See docs/design/multi-repo-components.md §7.1.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import { componentRoot } from "./worktree-paths.js";
import type { Component } from "../agent/project-config-store.js";
import { realClock, type Clock } from "../gateway-deps.js";
/**
 * Single source of truth for the worktree-setup timeout fallback.
 * Per-goal override → project `worktree_setup_timeout_ms` → this default.
 */
export const DEFAULT_WORKTREE_SETUP_TIMEOUT_MS = 120_000;

/**
 * Resolve the worktree-setup timeout (ms) from a goal override, then a
 * project default, then {@link DEFAULT_WORKTREE_SETUP_TIMEOUT_MS}.
 *
 * Only finite, strictly-positive integers are accepted at each level.
 * The project value may be a number or a numeric string (project config
 * stores everything as strings). Invalid / zero / negative / non-finite
 * values fall through to the next level.
 */
export function resolveSetupTimeoutMs(input?: {
	goalTimeoutMs?: unknown;
	projectTimeoutMs?: unknown;
}): number {
	const goal = coercePositiveIntMs(input?.goalTimeoutMs);
	if (goal !== undefined) return goal;
	const project = coercePositiveIntMs(input?.projectTimeoutMs);
	if (project !== undefined) return project;
	return DEFAULT_WORKTREE_SETUP_TIMEOUT_MS;
}

function coercePositiveIntMs(v: unknown): number | undefined {
	let n: number;
	if (typeof v === "number") n = v;
	else if (typeof v === "string" && v.trim() !== "") n = Number(v);
	else return undefined;
	// Design says finite positive INTEGERS. Reject fractional values rather than
	// flooring them — "0.5" must fall through to the next tier, not resolve to 0
	// (and "1.5" must not be silently truncated to 1).
	if (!Number.isInteger(n) || n <= 0) return undefined;
	return n;
}

export interface RunComponentSetupsOpts {
	components: Component[];
	/** Per-branch container directory: `<wt-root>/<branchSlug>`. */
	branchContainer: string;
	/** The project's primary checkout root — used to compute `SOURCE_REPO`. */
	primaryWorktreeRoot: string;
	/** Resolved per-command timeout (ms). Defaults to {@link DEFAULT_WORKTREE_SETUP_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Caller-supplied exec — host or in-container. */
	exec: (cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
	/**
	 * True when `exec` enforces `timeoutMs` itself and only rejects after any
	 * timed-out subprocess tree has been cleaned up. This avoids returning a
	 * worktree to callers while a killed setup shell still holds directory handles.
	 */
	execHandlesTimeout?: boolean;
	clock?: Clock;
	skipNpmCi?: boolean;
	recordSetupPath?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string, clock: Clock = realClock): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = clock.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => { clock.clearTimeout(timer); resolve(v); },
			(e) => { clock.clearTimeout(timer); reject(e); },
		);
	});
}

export async function runComponentSetups(opts: RunComponentSetupsOpts): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKTREE_SETUP_TIMEOUT_MS;
	const clock = opts.clock ?? realClock;
	const diagEnabled = cpuDiagnosticsEnabled();
	const diagStart = diagEnabled ? performance.now() : 0;
	const counters = diagEnabled ? { components: opts.components.length, skippedByEnv: 0, commands: 0, successes: 0, failures: 0 } : undefined;
	try {
		// Global escape hatch — used by E2E/CI to skip slow npm/pip installs in
		// freshly-claimed pool/staff worktrees. Mirrors the legacy gate that lived
		// inside `createWorktree` before per-component setup was the canonical path.
		if (opts.skipNpmCi) { if (counters) counters.skippedByEnv = 1; return; }
		for (const c of opts.components) {
			if (!c.worktreeSetupCommand) continue;  // data-only or no hook
			if (counters) counters.commands++;

			const cwd = componentRoot(c, opts.branchContainer);
			const sourceRepo = path.join(
				opts.primaryWorktreeRoot,
				c.repo === "." ? "" : c.repo,
				c.relativePath ?? "",
			);
			const env: NodeJS.ProcessEnv = { ...process.env, SOURCE_REPO: sourceRepo };

			// Test hook: when BOBBIT_TEST_RECORD_SETUP is set, append an audit
			// line to the file pointed at by the env var. The browser E2E for
			// multi-repo flows uses this to assert per-component invocation
			// without standing up a real npm/dependency install.
			const recordPath = opts.recordSetupPath;
			if (recordPath) {
				try {
					await fs.promises.mkdir(path.dirname(recordPath), { recursive: true });
					await fs.promises.appendFile(recordPath, `${c.name}\t${cwd}\t${sourceRepo}\t${c.worktreeSetupCommand}\n`);
				} catch { /* test-only — don't fail the worktree on audit IO errors */ }
			}

			const componentStart = diagEnabled ? performance.now() : 0;
			try {
				const setupPromise = opts.exec(c.worktreeSetupCommand, cwd, env, timeoutMs);
				if (opts.execHandlesTimeout) await setupPromise;
				else await withTimeout(setupPromise, timeoutMs, `[worktree-setup] ${c.name}`, clock);
				if (counters) counters.successes++;
				console.log(`[worktree-setup] ${c.name}: ok`);
				if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-setup:component", performance.now() - componentStart, { commands: 1, successes: 1, failures: 0 });
			} catch (err) {
				if (counters) counters.failures++;
				if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-setup:component", performance.now() - componentStart, { commands: 1, successes: 0, failures: 1 });
				console.warn(`[worktree-setup] ${c.name}: failed (non-fatal):`, err);
			}
		}
	} finally {
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-setup:run", performance.now() - diagStart, counters);
	}
}
