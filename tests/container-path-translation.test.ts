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
	? "C:\\Users\\test\\project\\.bobbit\\agent"
	: "/home/test/project/.bobbit/agent";
const TEST_BOBBIT_DIR = process.platform === "win32"
	? "C:\\Users\\test\\project\\.bobbit"
	: "/home/test/project/.bobbit";

// Set env vars before importing the module so the startup-resolved active
// agent dir is configurable via BOBBIT_AGENT_DIR.
process.env.BOBBIT_AGENT_DIR = TEST_AGENT_DIR;
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { containerPathToHost, hostPathToContainer } = await import("../src/server/agent/rpc-bridge.ts");

describe("containerPathToHost (bind-mount fallback)", () => {
	it("translates agent sessions path", () => {
		const containerPath = "/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		const hostPath = containerPathToHost(containerPath);
		const expected = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\agent\\sessions\\--workspace--\\2026-01-01.jsonl"
			: "/home/test/project/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
		assert.equal(hostPath, expected);
		assert.ok(hostPath.includes(".bobbit"), "must use the configured active Bobbit agent dir");
	});

	it("translates /bobbit-state subdirectory paths", () => {
		// Only specific state subdirs are mounted; never the state root.
		const containerPath = "/bobbit-state/sessions/abc-123/2026-01-01.jsonl";
		const hostPath = containerPathToHost(containerPath);
		const expected = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\state\\sessions\\abc-123\\2026-01-01.jsonl"
			: "/home/test/project/.bobbit/state/sessions/abc-123/2026-01-01.jsonl";
		assert.equal(hostPath, expected);
	});

	it("translates generated extension paths", () => {
		for (const { containerPath, expectedHost } of [
			{
				containerPath: "/bobbit-state/google-code-assist/abc123def456/provider.ts",
				expectedHost: process.platform === "win32"
					? "C:\\Users\\test\\project\\.bobbit\\state\\google-code-assist\\abc123def456\\provider.ts"
					: "/home/test/project/.bobbit/state/google-code-assist/abc123def456/provider.ts",
			},
			{
				containerPath: "/bobbit-state/openai-orphan-tool-result/def456abc123/extension.ts",
				expectedHost: process.platform === "win32"
					? "C:\\Users\\test\\project\\.bobbit\\state\\openai-orphan-tool-result\\def456abc123\\extension.ts"
					: "/home/test/project/.bobbit/state/openai-orphan-tool-result/def456abc123/extension.ts",
			},
			{
				containerPath: "/bobbit-state/provider-bridge/abc123def456/bridge.ts",
				expectedHost: process.platform === "win32"
					? "C:\\Users\\test\\project\\.bobbit\\state\\provider-bridge\\abc123def456\\bridge.ts"
					: "/home/test/project/.bobbit/state/provider-bridge/abc123def456/bridge.ts",
			},
		]) {
			assert.equal(containerPathToHost(containerPath), expectedHost);
		}
	});

	it("every sandbox state mount has a working host→container remap (provider-bridge regression)", async () => {
		// Regression net for the class of bug where a generated extension dir is
		// staged under the state dir and passed to pi via --extension, but is
		// missing from either SANDBOX_STATE_MOUNTS (docker-args.ts) or the mount
		// table (rpc-bridge.ts). When the remap is missing, hostPathToContainer
		// returns the HOST path unchanged, pi inside the container exits 1 with
		// "Extension path does not exist", and the session terminates at spawn.
		// That exact rot shipped for provider-bridge (per-turn provider hooks,
		// #788) and broke every sandboxed session with hindsight enabled.
		const { SANDBOX_STATE_MOUNTS } = await import("../src/server/agent/docker-args.ts");
		const statePrefix = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\state\\"
			: "/home/test/project/.bobbit/state/";
		for (const { sub } of SANDBOX_STATE_MOUNTS) {
			const hostPath = process.platform === "win32"
				? `${statePrefix}${sub}\\deadbeef1234\\file.ts`
				: `${statePrefix}${sub}/deadbeef1234/file.ts`;
			assert.equal(
				hostPathToContainer(hostPath),
				`/bobbit-state/${sub}/deadbeef1234/file.ts`,
				`state subdir "${sub}" is bind-mounted by docker-args.ts but has no host→container remap in rpc-bridge.ts buildMountTable() — sandboxed --extension paths under it would leak host paths into the container`,
			);
		}
	});

	it("does NOT translate /bobbit-state root files (not mounted)", () => {
		// sessions.json is at the state dir root — intentionally not exposed to containers
		const containerPath = "/bobbit-state/sessions.json";
		assert.equal(containerPathToHost(containerPath), containerPath);
	});

	it("returns non-matching paths unchanged", () => {
		const containerPath = "/workspace-wt/my-branch/src/index.ts";
		assert.equal(containerPathToHost(containerPath), containerPath);
	});
});

describe("hostPathToContainer (bind-mount fallback)", () => {
	it("translates host agent sessions path to container path", () => {
		const hostPath = process.platform === "win32"
			? "C:\\Users\\test\\project\\.bobbit\\agent\\sessions\\--workspace--\\2026-01-01.jsonl"
			: "/home/test/project/.bobbit/agent/sessions/--workspace--/2026-01-01.jsonl";
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
