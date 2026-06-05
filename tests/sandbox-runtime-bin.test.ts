/**
 * Unit tests for the podman/docker sandbox-runtime selection.
 *
 * Pins:
 *   1. ProjectConfigStore.getSandboxRuntime() resolution — default "docker"
 *      when the key is absent, explicit "podman", and unknown/empty/garbage
 *      values falling back to "docker" (never throwing).
 *   2. runtimeBin() resolver — null/undefined store → DEFAULT_RUNTIME_BIN,
 *      otherwise mirrors the store's getSandboxRuntime().
 *   3. The configured binary is the one actually spawned for container exec —
 *      observed via BgProcessManager's injectable SpawnFn (no real docker /
 *      podman required in CI).
 *   4. Guard scan: no hardcoded spawned-binary "docker" literal remains in
 *      src/server (all container-CLI invocations route through the resolver).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import type { ChildProcess } from "node:child_process";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { runtimeBin, DEFAULT_RUNTIME_BIN, type RuntimeBin } from "../src/server/agent/runtime-bin.ts";
import { BgProcessManager, type SpawnFn } from "../src/server/agent/bg-process-manager.ts";

function makeStore(yamlBody?: string): ProjectConfigStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-bin-"));
	if (yamlBody !== undefined) fs.writeFileSync(path.join(dir, "project.yaml"), yamlBody);
	return new ProjectConfigStore(dir);
}

describe("ProjectConfigStore.getSandboxRuntime", () => {
	it("defaults to docker when the key is absent", () => {
		assert.equal(makeStore("sandbox: docker\n").getSandboxRuntime(), "docker");
		assert.equal(makeStore().getSandboxRuntime(), "docker");
	});

	it("returns podman when explicitly configured", () => {
		assert.equal(makeStore("sandbox_runtime: podman\n").getSandboxRuntime(), "podman");
	});

	it("is case/whitespace-insensitive for podman", () => {
		assert.equal(makeStore("sandbox_runtime: '  PODMAN  '\n").getSandboxRuntime(), "podman");
	});

	it("falls back to docker for unknown/empty/garbage values (never throws)", () => {
		assert.equal(makeStore("sandbox_runtime: ''\n").getSandboxRuntime(), "docker");
		assert.equal(makeStore("sandbox_runtime: containerd\n").getSandboxRuntime(), "docker");
		assert.equal(makeStore("sandbox_runtime: 'lxc; rm -rf /'\n").getSandboxRuntime(), "docker");
	});
});

describe("runtimeBin resolver", () => {
	it("returns DEFAULT_RUNTIME_BIN for null/undefined store", () => {
		assert.equal(DEFAULT_RUNTIME_BIN, "docker");
		assert.equal(runtimeBin(null), "docker");
		assert.equal(runtimeBin(undefined), "docker");
	});

	it("mirrors the store's getSandboxRuntime()", () => {
		assert.equal(runtimeBin({ getSandboxRuntime: () => "podman" }), "podman");
		assert.equal(runtimeBin({ getSandboxRuntime: () => "docker" }), "docker");
	});
});

// ── Spawned-binary observation ───────────────────────────────────────────

interface FakeChild extends EventEmitter {
	pid: number;
	stdout: EventEmitter & { destroy(): void };
	stderr: EventEmitter & { destroy(): void };
	kill(): boolean;
	unref(): void;
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = 4242;
	const mkStream = () => Object.assign(new EventEmitter(), { destroy() { /* noop */ } });
	child.stdout = mkStream();
	child.stderr = mkStream();
	child.kill = () => true;
	child.unref = () => { /* noop */ };
	return child;
}

describe("BgProcessManager spawns the configured runtime binary", () => {
	function capturingManager() {
		const calls: Array<{ containerId: string | undefined; runtime: RuntimeBin }> = [];
		const spawn: SpawnFn = (_cmd, _cwd, containerId, runtime) => {
			calls.push({ containerId, runtime });
			return makeFakeChild() as unknown as ChildProcess;
		};
		return { mgr: new BgProcessManager(() => undefined, spawn), calls };
	}

	it("passes podman through to the spawn fn for a container process", () => {
		const { mgr, calls } = capturingManager();
		mgr.create("s1", "echo hi", "/workspace", "cid-123", true, "t", "podman");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].containerId, "cid-123");
		assert.equal(calls[0].runtime, "podman");
	});

	it("defaults to docker when no runtime is supplied", () => {
		const { mgr, calls } = capturingManager();
		mgr.create("s2", "echo hi", "/workspace", "cid-9", true, "t");
		assert.equal(calls[0].runtime, "docker");
	});
});

// ── Regression guard ───────────────────────────────────────────────────────

describe("no hardcoded spawned-binary \"docker\" literal in src/server", () => {
	it("every container-CLI invocation routes through the runtime resolver", () => {
		const here = path.dirname(url.fileURLToPath(import.meta.url));
		const serverDir = path.join(here, "..", "src", "server");
		// Matches a spawn-style call whose binary argument is the literal "docker".
		// These MUST instead receive a resolved RuntimeBin ("docker" | "podman").
		const offending = /\b(spawn|spawnTracked|spawnSync|execFile|execFileAsync)\(\s*["']docker["']/;

		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!entry.name.endsWith(".ts")) continue;
				const lines = fs.readFileSync(full, "utf-8").split("\n");
				lines.forEach((line, i) => {
					if (offending.test(line)) offenders.push(`${full}:${i + 1}: ${line.trim()}`);
				});
			}
		};
		walk(serverDir);

		assert.deepEqual(
			offenders,
			[],
			`Found hardcoded spawned-binary "docker" literal(s):\n${offenders.join("\n")}`,
		);
	});
});
