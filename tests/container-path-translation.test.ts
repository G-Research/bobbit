import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the container ↔ host path translation in rpc-bridge.ts.
 *
 * These translations are used internally by session-fs.ts as a bind-mount
 * fallback when Docker containers are unavailable. All other code stores
 * and passes paths in the agent's coordinate system (container paths for
 * sandbox, host paths for local).
 */

const TEST_AGENT_DIR = process.platform === "win32"
	? "C:\\Users\\test\\.bobbit\\agent"
	: "/home/test/.bobbit/agent";
const TEST_BOBBIT_DIR = process.platform === "win32"
	? "C:\\Users\\test\\project\\.bobbit"
	: "/home/test/project/.bobbit";

// Set env vars before importing the module so globalAgentDir() picks them up
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { containerPathToHost, hostPathToContainer } = await import("../src/server/agent/rpc-bridge.js");

describe("containerPathToHost (bind-mount fallback)", () => {
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

	it("returns non-matching paths unchanged", () => {
		const containerPath = "/workspace-wt/my-branch/src/index.ts";
		assert.equal(containerPathToHost(containerPath), containerPath);
	});
});

describe("hostPathToContainer (bind-mount fallback)", () => {
	it("translates host agent sessions path to container path", () => {
		const hostPath = process.platform === "win32"
			? "C:\\Users\\test\\.bobbit\\agent\\sessions\\--workspace--\\2026-01-01.jsonl"
			: "/home/test/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		const containerPath = hostPathToContainer(hostPath);
		assert.equal(containerPath, "/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl");
	});

	it("returns non-matching paths unchanged", () => {
		assert.equal(hostPathToContainer("/some/random/path.txt"), "/some/random/path.txt");
	});
});

describe("round-trip", () => {
	it("container → host → container preserves the path", () => {
		const original = "/home/node/.bobbit/agent/sessions/--workspace-wt-branch--/2026-04-04.jsonl";
		const host = containerPathToHost(original);
		const backToContainer = hostPathToContainer(host);
		assert.equal(backToContainer, original);
	});
});
