/**
 * Security regression — sandboxed worktrees must NEVER host-fallback for LSP.
 *
 * Background: previously `spawnLspChild()` and `TypescriptLspClient.start()`
 * silently fell back to spawning the language server on the host whenever the
 * sandbox bridge had no container ID for the worktree. For sandboxed sessions
 * this allowed tsserver to be invoked against untrusted worktree files on the
 * host — a sandbox escape via the LSP surface.
 *
 * Fix: `spawnLspChild()` now accepts `requireSandbox` and throws
 * `LspSandboxRequiredError` when no container is available. The supervisor
 * sets this flag for worktrees marked via `markSandboxed()`, which session
 * setup calls AFTER `applySandboxWiring` succeeds. Host-only / fixture / dev
 * flows leave the flag unset and keep the legacy host-spawn fallback.
 *
 * This file pins all three layers:
 *   1. `spawnLspChild` raw behaviour (host fallback ON by default, OFF when
 *      `requireSandbox` is set and no container is available, sandbox spawn
 *      when container present).
 *   2. `LspSupervisor.ensure()` passes `requireSandbox: true` to factories
 *      for worktrees added via `markSandboxed()`, and `false` otherwise.
 *   3. `unmarkSandboxed()` / `shutdownForWorktree()` clear the flag so a
 *      re-used worktree path is not permanently sandbox-only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn as cpSpawn } from "node:child_process";

import {
	spawnLspChild,
	LspSandboxRequiredError,
	type LspProcessOpts,
} from "../../src/server/lsp/server-process.ts";
import { LspSupervisor } from "../../src/server/lsp/supervisor.ts";
import type {
	LspClient,
	LspClientFactory,
	SandboxLspBridge,
	SpawnOpts,
} from "../../src/server/lsp/client.ts";
import type { Language } from "../../src/server/lsp/types.ts";

// ── Bridge helpers ─────────────────────────────────────────────────────────

function bridgeWithNoContainer(): SandboxLspBridge {
	return {
		spawn() { throw new Error("sandbox.spawn() must not be called when no container"); },
		toContainerPath(p: string): string { return `/workspace-wt/fake${p}`; },
		toHostPath(p: string): string { return p.replace(/^\/workspace-wt\/fake/, ""); },
		containerIdForWorktree(): string | null { return null; },
	};
}

function bridgeWithContainer(containerId: string, spawnedCmds: string[][]): SandboxLspBridge {
	return {
		spawn({ cmd }) {
			spawnedCmds.push(cmd);
			// `cat` keeps stdio open without producing protocol traffic; the test
			// only inspects that the sandbox path was taken (it never drives a
			// real LSP handshake here).
			return cpSpawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
		},
		toContainerPath(p: string): string { return `/workspace-wt/${containerId}${p}`; },
		toHostPath(p: string): string { return p; },
		containerIdForWorktree(): string | null { return containerId; },
	};
}

// ── 1. spawnLspChild — raw guard ───────────────────────────────────────────

describe("spawnLspChild — sandbox guard", () => {
	test("default (requireSandbox unset) falls back to host spawn when no container", async () => {
		const opts: LspProcessOpts = {
			worktreePath: os.tmpdir(),
			// Use `cat` so the spawn succeeds and the process stays alive on stdio.
			command: "cat",
			args: [],
			sandbox: bridgeWithNoContainer(),
		};
		const proc = await spawnLspChild(opts);
		try {
			assert.ok(proc.child.pid, "expected a host-spawned child pid");
		} finally {
			await proc.stop(false);
		}
	});

	test("requireSandbox + no container → throws LspSandboxRequiredError (no host fallback)", async () => {
		const opts: LspProcessOpts = {
			worktreePath: "/some/sandboxed/worktree",
			// A command that would clearly succeed on the host — if the guard is
			// removed, this test would pass for the wrong reason. Using `cat`
			// proves the throw happens BEFORE any host spawn attempt.
			command: "cat",
			args: [],
			sandbox: bridgeWithNoContainer(),
			requireSandbox: true,
		};
		await assert.rejects(spawnLspChild(opts), (err: Error) => {
			assert.ok(
				err instanceof LspSandboxRequiredError,
				`expected LspSandboxRequiredError, got ${err.name}: ${err.message}`,
			);
			assert.match(err.message, /sandbox required/i);
			assert.match(err.message, /\/some\/sandboxed\/worktree/);
			return true;
		});
	});

	test("requireSandbox + container present → uses sandbox bridge spawn (not host)", async () => {
		const spawnedCmds: string[][] = [];
		const opts: LspProcessOpts = {
			worktreePath: "/some/sandboxed/worktree",
			command: "host-tsserver-DOES-NOT-EXIST",
			args: ["--stdio"],
			sandboxCmd: ["typescript-language-server", "--stdio"],
			sandbox: bridgeWithContainer("container-abc", spawnedCmds),
			requireSandbox: true,
		};
		const proc = await spawnLspChild(opts);
		try {
			assert.equal(spawnedCmds.length, 1, "expected exactly one sandbox spawn");
			assert.deepEqual(
				spawnedCmds[0],
				["typescript-language-server", "--stdio"],
				"sandbox spawn must use sandboxCmd, not host command",
			);
		} finally {
			await proc.stop(false);
		}
	});

	test("requireSandbox unset + container present → still uses sandbox bridge (existing behaviour)", async () => {
		const spawnedCmds: string[][] = [];
		const opts: LspProcessOpts = {
			worktreePath: "/some/worktree",
			command: "cat",
			args: [],
			sandboxCmd: ["typescript-language-server", "--stdio"],
			sandbox: bridgeWithContainer("container-xyz", spawnedCmds),
		};
		const proc = await spawnLspChild(opts);
		try {
			assert.equal(spawnedCmds.length, 1);
		} finally {
			await proc.stop(false);
		}
	});
});

// ── 2. Supervisor — markSandboxed plumbing ─────────────────────────────────

interface RecordingFactoryOpts {
	language: Language;
	captures: SpawnOpts[];
}

function makeRecordingFactory(opts: RecordingFactoryOpts): LspClientFactory {
	return {
		language: opts.language,
		isInstalled: () => true,
		async spawn(spawnOpts: SpawnOpts): Promise<LspClient> {
			opts.captures.push(spawnOpts);
			return {
				language: opts.language,
				worktreePath: spawnOpts.worktreePath,
				state: "warm" as const,
				async ensureDocOpen() {},
				async definition() { return null; },
				async references() { return []; },
				async hover() { return null; },
				async diagnostics() { return []; },
				async documentSymbols() { return []; },
				async workspaceSymbol() { return []; },
				async rename() { return { changes: {} }; },
				async shutdown() {},
			};
		},
	};
}

describe("LspSupervisor — sandbox marking", () => {
	test("ensure() passes requireSandbox=true ONLY for markSandboxed() worktrees", async () => {
		const captures: SpawnOpts[] = [];
		const sup = new LspSupervisor({
			factories: [makeRecordingFactory({ language: "typescript", captures })],
			idleTtlMs: 60_000,
		});

		const wtSandboxed = path.resolve("/wt/sandboxed");
		const wtHostOnly = path.resolve("/wt/host-only");

		sup.markSandboxed(wtSandboxed);
		assert.ok(sup.isSandboxed(wtSandboxed));
		assert.ok(!sup.isSandboxed(wtHostOnly));

		await sup.ensure({ worktreePath: wtSandboxed, language: "typescript" });
		await sup.ensure({ worktreePath: wtHostOnly, language: "typescript" });

		assert.equal(captures.length, 2);
		const sandboxedSpawn = captures.find(c => c.worktreePath === wtSandboxed);
		const hostOnlySpawn = captures.find(c => c.worktreePath === wtHostOnly);
		assert.equal(sandboxedSpawn?.requireSandbox, true, "marked worktree must get requireSandbox=true");
		assert.equal(hostOnlySpawn?.requireSandbox, false, "unmarked worktree must NOT require sandbox");
	});

	test("unmarkSandboxed() clears the flag for future spawns", async () => {
		const captures: SpawnOpts[] = [];
		const sup = new LspSupervisor({
			factories: [makeRecordingFactory({ language: "typescript", captures })],
			idleTtlMs: 60_000,
		});
		const wt = path.resolve("/wt/recycled");

		sup.markSandboxed(wt);
		await sup.ensure({ worktreePath: wt, language: "typescript" });
		assert.equal(captures[0].requireSandbox, true);

		// Tear down (mimic session teardown) and unmark.
		await sup.shutdownForWorktree(wt);
		assert.ok(!sup.isSandboxed(wt), "shutdownForWorktree should clear sandbox flag");

		// A subsequent spawn (e.g. dev session re-using the path) must NOT
		// require sandbox.
		await sup.ensure({ worktreePath: wt, language: "typescript" });
		assert.equal(captures[1].requireSandbox, false, "post-shutdown spawn must not be sandbox-only");
	});

	test("unmarkSandboxed() alone (no shutdown) flips the flag", () => {
		const sup = new LspSupervisor({ factories: [], idleTtlMs: 60_000 });
		const wt = path.resolve("/wt/x");
		sup.markSandboxed(wt);
		assert.ok(sup.isSandboxed(wt));
		sup.unmarkSandboxed(wt);
		assert.ok(!sup.isSandboxed(wt));
	});
});
