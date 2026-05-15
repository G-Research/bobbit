/**
 * Security regression: TypescriptLspClient must FAIL CLOSED \u2014 not silently
 * spawn a host language server \u2014 when a sandbox bridge is supplied but no
 * container is currently running for the worktree.
 *
 * History:
 *   - 2026-05-14 (sessions `03afb128` Mel Brookpoint, `9150a1de`): silent host
 *     fallback combined with path translation produced `/workspace-wt/...`
 *     URIs sent to host tsserver, causing ENOENT during initialize. Earlier
 *     fix: don't translate paths when no container is running, but still
 *     spawn on the host.
 *   - 2026-05-15 security review: spawning the language server on the host
 *     for a project that has opted into sandbox isolation is itself a
 *     high-severity finding \u2014 it leaks a process running as the gateway
 *     user with full host filesystem access. Fix: refuse to spawn at all
 *     when sandbox is configured but no container exists; report
 *     `lsp_unavailable` so the agent falls back to grep.
 *
 * This test pins the new behavior at the adapter boundary. A focused unit
 * test for `spawnLspChild` itself lives in
 * `tests/lsp/server-process-sandbox.spec.ts`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TypescriptLspFactory } from "../../src/server/lsp/clients/typescript.ts";
import type { SandboxLspBridge } from "../../src/server/lsp/client.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

const factory = new TypescriptLspFactory();
const HAS_LSP = factory.isInstalled();
const skip = !HAS_LSP ? { skip: "typescript-language-server not installed" } : undefined;

function makeFakeBridge(): SandboxLspBridge & {
	toContainerCalls: string[];
	resolveCalls: string[];
	containerLookups: string[];
	spawnCalls: number;
} {
	const toContainerCalls: string[] = [];
	const resolveCalls: string[] = [];
	const containerLookups: string[] = [];
	let spawnCalls = 0;

	const inner: SandboxLspBridge = {
		spawn() {
			spawnCalls++;
			throw new Error("sandbox.spawn() must not be called when no container is running");
		},
		toContainerPath(hostPath: string): string {
			toContainerCalls.push(hostPath);
			return `/workspace-wt/goal-fake/${path.basename(hostPath)}`;
		},
		toHostPath(p: string): string { return p; },
		containerIdForWorktree(hostWorktreePath: string): string | null {
			containerLookups.push(hostWorktreePath);
			return null; // No container running.
		},
	};

	const outer: SandboxLspBridge = {
		resolveForWorktree(worktreePath: string): SandboxLspBridge {
			resolveCalls.push(worktreePath);
			return inner;
		},
		spawn: inner.spawn,
		toContainerPath: inner.toContainerPath,
		toHostPath: inner.toHostPath,
		containerIdForWorktree: inner.containerIdForWorktree,
	};

	return Object.assign(outer, {
		toContainerCalls,
		resolveCalls,
		containerLookups,
		get spawnCalls() { return spawnCalls; },
	});
}

describe("typescript LSP adapter \u2014 docker sandbox without running container", skip, () => {
	test("factory.spawn() rejects with lsp_unavailable; no host tsserver is started", async () => {
		const fake = makeFakeBridge();
		const err: any = await factory.spawn({ worktreePath: FIXTURE, sandbox: fake }).then(
			() => null,
			(e) => e,
		);
		assert.ok(err, "factory.spawn() must reject when sandbox is configured but no container is running");
		assert.equal(
			err.code,
			"lsp_unavailable",
			`expected LspUnavailableError (code=lsp_unavailable). Got code=${err?.code}, message=${err?.message}`,
		);
		assert.match(
			String(err.message),
			/sandbox.*container|container.*sandbox/i,
			`error must explain the sandbox/no-container situation. Got: ${err.message}`,
		);
		// Bridge-level invariants: containerIdForWorktree was consulted, but
		// neither the in-container spawn nor host-path translation ran.
		assert.ok(
			fake.containerLookups.length >= 1,
			`expected containerIdForWorktree() to be consulted at least once, got ${fake.containerLookups.length} calls`,
		);
		assert.equal(
			fake.spawnCalls,
			0,
			"bridge.spawn() must not be invoked when no container is running",
		);
		assert.equal(
			fake.toContainerCalls.length,
			0,
			`toContainerPath() must not be called when no container is running. Got calls:\n  ${fake.toContainerCalls.join("\n  ")}`,
		);
	});
});
