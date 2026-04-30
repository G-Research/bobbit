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
import { componentRoot } from "./worktree-paths.js";
import type { Component } from "../agent/project-config-store.js";

const TIMEOUT_MS = 120_000;

export interface RunComponentSetupsOpts {
	components: Component[];
	/** Per-branch container directory: `<wt-root>/<branchSlug>`. */
	branchContainer: string;
	/** The project's primary checkout root — used to compute `SOURCE_REPO`. */
	primaryWorktreeRoot: string;
	/** Caller-supplied exec — host or in-container. */
	exec: (cmd: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

export async function runComponentSetups(opts: RunComponentSetupsOpts): Promise<void> {
	// Global escape hatch — used by E2E/CI to skip slow npm/pip installs in
	// freshly-claimed pool/staff worktrees. Mirrors the legacy gate that lived
	// inside `createWorktree` before per-component setup was the canonical path.
	if (process.env.BOBBIT_SKIP_NPM_CI) return;
	for (const c of opts.components) {
		if (!c.worktreeSetupCommand) continue;  // data-only or no hook

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
		const recordPath = process.env.BOBBIT_TEST_RECORD_SETUP;
		if (recordPath) {
			try {
				fs.mkdirSync(path.dirname(recordPath), { recursive: true });
				fs.appendFileSync(recordPath, `${c.name}\t${cwd}\t${sourceRepo}\t${c.worktreeSetupCommand}\n`);
			} catch { /* test-only — don't fail the worktree on audit IO errors */ }
		}

		try {
			await withTimeout(opts.exec(c.worktreeSetupCommand, cwd, env), TIMEOUT_MS, `[worktree-setup] ${c.name}`);
			console.log(`[worktree-setup] ${c.name}: ok`);
		} catch (err) {
			console.warn(`[worktree-setup] ${c.name}: failed (non-fatal):`, err);
		}
	}
}
