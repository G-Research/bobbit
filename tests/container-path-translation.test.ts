import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test the translation functions by importing them directly.
// The mount table depends on globalAgentDir() and bobbitStateDir(),
// which read from env vars or fall back to home-dir-based defaults.
// For testing, we set PI_CODING_AGENT_DIR and BOBBIT_DIR so the
// host paths are deterministic.

const TEST_AGENT_DIR = process.platform === "win32"
	? "C:\\Users\\test\\.bobbit\\agent"
	: "/home/test/.bobbit/agent";
const TEST_BOBBIT_DIR = process.platform === "win32"
	? "C:\\Users\\test\\project\\.bobbit"
	: "/home/test/project/.bobbit";

// Set env vars before importing the module so globalAgentDir() picks them up
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { containerPathToHost, hostPathToContainer, toDockerPath } = await import("../src/server/agent/rpc-bridge.js");

describe("containerPathToHost", () => {
	it("translates agent sessions path", () => {
		const containerPath = "/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		const hostPath = containerPathToHost(containerPath);
		const expected = process.platform === "win32"
			? "C:\\Users\\test\\.bobbit\\agent\\sessions\\--workspace--\\2026-01-01.jsonl"
			: "/home/test/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		assert.equal(hostPath, expected);
	});

	it("translates /bobbit-state paths", () => {
		const containerPath = "/bobbit-state/sessions.json";
		const hostPath = containerPathToHost(containerPath);
		const expected = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\state\\sessions.json"
			: "/home/test/project/.bobbit/state/sessions.json";
		assert.equal(hostPath, expected);
	});

	it("translates /tmp/session-prompts paths", () => {
		const containerPath = "/tmp/session-prompts/abc123.md";
		const hostPath = containerPathToHost(containerPath);
		const expected = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\state\\session-prompts\\abc123.md"
			: "/home/test/project/.bobbit/state/session-prompts/abc123.md";
		assert.equal(hostPath, expected);
	});

	it("returns non-matching paths unchanged", () => {
		const containerPath = "/workspace-wt/my-branch/src/index.ts";
		assert.equal(containerPathToHost(containerPath), containerPath);
	});

	it("returns host paths unchanged (idempotent for non-container paths)", () => {
		const hostPath = process.platform === "win32"
			? "C:\\Users\\test\\.bobbit\\agent\\sessions\\foo.jsonl"
			: "/home/test/.bobbit/agent/sessions/foo.jsonl";
		// This should NOT double-translate (host path doesn't start with container prefix)
		assert.equal(containerPathToHost(hostPath), hostPath);
	});
});

describe("hostPathToContainer", () => {
	it("translates host agent sessions path to container path", () => {
		const hostPath = process.platform === "win32"
			? "C:\\Users\\test\\.bobbit\\agent\\sessions\\--workspace--\\2026-01-01.jsonl"
			: "/home/test/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		const containerPath = hostPathToContainer(hostPath);
		assert.equal(containerPath, "/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl");
	});

	it("translates host state paths to /bobbit-state", () => {
		const hostPath = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\state\\sessions.json"
			: "/home/test/project/.bobbit/state/sessions.json";
		const containerPath = hostPathToContainer(hostPath);
		assert.equal(containerPath, "/bobbit-state/sessions.json");
	});

	it("returns non-matching paths unchanged", () => {
		const hostPath = "/some/random/path.txt";
		assert.equal(hostPathToContainer(hostPath), hostPath);
	});
});

describe("round-trip", () => {
	it("container → host → container preserves the path", () => {
		const original = "/home/node/.bobbit/agent/sessions/--workspace-wt-branch--/2026-04-04.jsonl";
		const host = containerPathToHost(original);
		const backToContainer = hostPathToContainer(host);
		assert.equal(backToContainer, original);
	});

	it("host → container → host preserves the path", () => {
		const original = process.platform === "win32"
			? "C:\\Users\\test\\.bobbit\\agent\\sessions\\slug\\file.jsonl"
			: "/home/test/.bobbit/agent/sessions/slug/file.jsonl";
		const container = hostPathToContainer(original);
		const backToHost = containerPathToHost(container);
		assert.equal(backToHost, original);
	});
});
