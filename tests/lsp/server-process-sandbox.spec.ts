/**
 * Security regression: `spawnLspChild` must NEVER fall back to a host
 * `child_process.spawn(...)` when the caller has configured a sandbox bridge
 * but no container is currently running for the worktree.
 *
 * Background (2026-05-15 security review): a sandbox-configured project that
 * silently leaks its language server onto the host runs that process under
 * the gateway user with full host filesystem access — defeating the sandbox
 * boundary. The previous "best-effort" fallback in `server-process.ts` was
 * rated high-severity and must remain fixed.
 *
 * Invariants pinned by this test:
 *   1. With `opts.sandbox` set and `containerIdForWorktree()` returning null,
 *      `spawnLspChild` rejects with an `LspUnavailableError` (code
 *      `lsp_unavailable`).
 *   2. The bridge's `spawn()` is never invoked.
 *   3. No host child process is created — we verify by passing a bogus
 *      command path. If a host spawn happened we'd see ENOENT, not the
 *      sandbox refusal message.
 *
 * The non-sandbox (no `opts.sandbox`) host-spawn path is exercised by the
 * existing `tests/lsp/typescript-client.spec.ts` integration test, so we do
 * not re-prove it here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { spawnLspChild } from "../../src/server/lsp/server-process.ts";
import type { SandboxLspBridge } from "../../src/server/lsp/client.ts";

function makeNoContainerBridge() {
	const calls = { spawn: 0, containerLookups: [] as string[], toContainer: 0 };
	const bridge: SandboxLspBridge = {
		spawn() {
			calls.spawn++;
			throw new Error("sandbox.spawn() must not be called when no container is running");
		},
		toContainerPath(p: string): string {
			calls.toContainer++;
			return `/workspace-wt/${p}`;
		},
		toHostPath(p: string): string { return p; },
		containerIdForWorktree(p: string): string | null {
			calls.containerLookups.push(p);
			return null;
		},
	};
	return { bridge, calls };
}

describe("spawnLspChild — sandbox fail-closed", () => {
	test("rejects with lsp_unavailable when sandbox is set but no container is running", async () => {
		const { bridge, calls } = makeNoContainerBridge();
		// Use a clearly bogus command path. If the security guard ever
		// regresses and we fall back to host spawn, the failure mode would be
		// an ENOENT from `child_process.spawn` rather than the structured
		// `lsp_unavailable` error — distinguishing the two is the point.
		await assert.rejects(
			() => spawnLspChild({
				worktreePath: "/tmp/nonexistent-worktree-for-sandbox-test",
				command: "/definitely/not/a/real/binary-that-must-not-be-spawned",
				args: ["--stdio"],
				sandbox: bridge,
			}),
			(err: any) => {
				assert.equal(err.code, "lsp_unavailable", `expected code=lsp_unavailable, got ${err.code}`);
				assert.match(
					String(err.message),
					/sandbox.*no container|no container.*sandbox/i,
					`error message must explain the sandbox/no-container situation. Got: ${err.message}`,
				);
				// Ensure the message is NOT a generic ENOENT — that would
				// indicate the host-spawn path actually executed.
				assert.ok(
					!/ENOENT/i.test(String(err.message)),
					`error must come from the sandbox guard, not a host spawn ENOENT. Got: ${err.message}`,
				);
				return true;
			},
		);
		assert.equal(calls.spawn, 0, "bridge.spawn() must not be invoked when no container is running");
		assert.equal(calls.toContainer, 0, "toContainerPath() must not be called when no container is running");
		assert.ok(
			calls.containerLookups.length >= 1,
			`expected containerIdForWorktree() to be consulted at least once. Got ${calls.containerLookups.length}`,
		);
	});
});
