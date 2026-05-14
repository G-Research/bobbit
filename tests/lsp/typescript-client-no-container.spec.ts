/**
 * Regression test: TypescriptLspClient must NOT attach a sandbox path-translation
 * bridge when no sandbox container is actually running.
 *
 * Bug scenario (2026-05-14, sessions `03afb128` Mel Brookpoint and `9150a1de`):
 *   Project declares `sandbox: docker` in project.yaml but no container is up.
 *   `TypescriptLspClient.start()` previously cached
 *     `sandbox?.resolveForWorktree?.(worktreePath) ?? sandbox`
 *   as `this.bridge` unconditionally. For docker-configured projects the
 *   resolver returns a docker bridge because the worktree path matches
 *   `<rootPath>-wt/<branch>`, but `server-process.ts` correctly falls back to
 *   spawning `tsserver` on the host when `containerIdForWorktree()` is null.
 *   The mismatch caused `toUri()` to translate every host path to
 *   `/workspace-wt/<branch>/...` even though tsserver was running on the host,
 *   producing `ENOENT stat '/workspace-wt/...'` during `initialize` and silently
 *   disabling LSP for every TS coder on the project.
 *
 *   Fix: cache the bridge only when `containerIdForWorktree(worktreePath)`
 *   returns a non-null container id; otherwise leave it undefined and use host
 *   paths.
 *
 * This test passes a fake `SandboxLspBridge` whose `resolveForWorktree()` returns
 * a bridge with `containerIdForWorktree() === null` and whose `toContainerPath()`
 * translates to a bogus `/workspace-wt/...` path. If the adapter caches that
 * bridge by mistake, every URI it sends will reference `/workspace-wt/...` and
 * `initialize`/`definition` will fail. The assertions:
 *
 *   1. `toContainerPath()` is NEVER invoked (bridge must remain unattached).
 *   2. `start()` resolves cleanly (no ENOENT from bogus rootUri).
 *   3. `definition()` returns a host file:// path under the fixture directory,
 *      with no `/workspace-wt/` substring leaking through.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TypescriptLspFactory } from "../../src/server/lsp/clients/typescript.ts";
import type { LspClient, SandboxLspBridge } from "../../src/server/lsp/client.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

const factory = new TypescriptLspFactory();
const HAS_LSP = factory.isInstalled();
const skip = !HAS_LSP ? { skip: "typescript-language-server not installed" } : undefined;

function makeFakeBridge(): SandboxLspBridge & {
	toContainerCalls: string[];
	resolveCalls: string[];
	containerLookups: string[];
} {
	const toContainerCalls: string[] = [];
	const resolveCalls: string[] = [];
	const containerLookups: string[] = [];

	const inner: SandboxLspBridge = {
		spawn() {
			throw new Error("sandbox.spawn() must not be called when no container is running");
		},
		toContainerPath(hostPath: string): string {
			toContainerCalls.push(hostPath);
			// Bogus translation — if this leaks into the LSP request, tsserver will
			// fail to stat the path and initialize will reject with ENOENT.
			return `/workspace-wt/goal-fake/${path.basename(hostPath)}`;
		},
		toHostPath(p: string): string {
			if (p.startsWith("/workspace-wt/goal-fake/")) {
				return path.join(FIXTURE, p.slice("/workspace-wt/goal-fake/".length));
			}
			return p;
		},
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

	return Object.assign(outer, { toContainerCalls, resolveCalls, containerLookups });
}

describe("typescript LSP adapter — docker sandbox without running container", skip, () => {
	let client: LspClient;
	let fake: ReturnType<typeof makeFakeBridge>;
	const mathPath = path.join(FIXTURE, "src", "math.ts");
	const indexPath = path.join(FIXTURE, "src", "index.ts");

	before(async () => {
		fake = makeFakeBridge();
		client = await factory.spawn({ worktreePath: FIXTURE, sandbox: fake });
		// Mirror the base TypeScript adapter integration test: pre-open both files
		// so the language server has the imported module in its project graph.
		await client.ensureDocOpen(mathPath);
		await client.ensureDocOpen(indexPath);
	});

	after(async () => {
		if (client) await client.shutdown(true);
	});

	test("bridge consults containerIdForWorktree and does NOT attach when null", () => {
		// The adapter must check whether a container actually exists before
		// caching the bridge for path translation.
		assert.ok(
			fake.containerLookups.length >= 1,
			`expected containerIdForWorktree() to be consulted at least once, got ${fake.containerLookups.length} calls`,
		);
		// And it must never translate host paths to bogus container paths.
		assert.equal(
			fake.toContainerCalls.length,
			0,
			`toContainerPath() must not be called when no container is running. Got calls:\n  ${fake.toContainerCalls.join("\n  ")}`,
		);
	});

	test("definition() returns a host file path under the fixture (no /workspace-wt/ leak)", async () => {
		// "const x = add(1, 2);" — `add` starts at character 10 on line 2 in the existing fixture test.
		const loc = await client.definition(indexPath, 2, 10);
		assert.ok(loc, "expected a definition result");
		assert.ok(
			!loc!.path.includes("/workspace-wt/"),
			`definition path must not contain '/workspace-wt/'. Got: ${loc!.path}`,
		);
		assert.ok(
			loc!.path.startsWith(FIXTURE),
			`definition path must be under the host fixture dir ${FIXTURE}. Got: ${loc!.path}`,
		);
		assert.ok(loc!.path.endsWith(path.join("src", "math.ts")), `got ${loc!.path}`);
		// Final guard: still no translation calls after a real LSP operation.
		assert.equal(
			fake.toContainerCalls.length,
			0,
			`toContainerPath() must remain uncalled after definition(). Got calls:\n  ${fake.toContainerCalls.join("\n  ")}`,
		);
	});
});
