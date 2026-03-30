/**
 * Unit tests for sandbox session path remapping helpers.
 *
 * These functions (containerToHostSessionPath, hostToContainerSessionPath)
 * translate between Docker container paths and host-native paths so that
 * sandboxed session files can be persisted and restored across server restarts.
 *
 * The functions do not exist yet — this test will fail on import until
 * the implementation adds the exports to rpc-bridge.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// This import will fail until the implementation adds these exports
const { containerToHostSessionPath, hostToContainerSessionPath, CONTAINER_AGENT_DIR } =
	await import("../src/server/agent/rpc-bridge.ts");

describe("sandbox session path remapping", () => {
	const homeDir = os.homedir();
	const hostAgentDir = path.join(homeDir, ".pi", "agent") + "/";

	describe("containerToHostSessionPath", () => {
		it("should remap container path to host path", () => {
			const containerPath =
				"/home/node/.pi/agent/sessions/--workspace--/abc.jsonl";
			const hostPath = containerToHostSessionPath(containerPath);

			// Should NOT start with container home
			assert.ok(
				!hostPath.startsWith("/home/node"),
				`expected host path not to start with /home/node, got: ${hostPath}`,
			);

			// Should start with the actual host home directory
			const expectedSuffix = path.join(
				".pi",
				"agent",
				"sessions",
				"--workspace--",
				"abc.jsonl",
			);
			assert.ok(
				hostPath.endsWith(expectedSuffix) ||
					hostPath.replace(/\\/g, "/").endsWith(expectedSuffix.replace(/\\/g, "/")),
				`expected host path to end with ${expectedSuffix}, got: ${hostPath}`,
			);
		});

		it("should not remap non-container paths", () => {
			const normalPath = "/some/other/path/file.jsonl";
			const result = containerToHostSessionPath(normalPath);
			assert.strictEqual(
				result,
				normalPath,
				"non-container paths should pass through unchanged",
			);
		});

		it("should not remap paths that only partially match the prefix", () => {
			// Path starts with /home/node but NOT with /home/node/.pi/agent/
			const partialMatch = "/home/node/something-else/file.jsonl";
			const result = containerToHostSessionPath(partialMatch);
			assert.strictEqual(
				result,
				partialMatch,
				"paths not under /home/node/.pi/agent/ should pass through unchanged",
			);
		});
	});

	describe("hostToContainerSessionPath", () => {
		it("should remap host path to container path", () => {
			const hostPath = path.join(
				homeDir,
				".pi",
				"agent",
				"sessions",
				"--workspace--",
				"abc.jsonl",
			);
			const containerPath = hostToContainerSessionPath(hostPath);

			assert.strictEqual(
				containerPath,
				"/home/node/.pi/agent/sessions/--workspace--/abc.jsonl",
			);
		});

		it("should not remap paths outside the host agent directory", () => {
			const otherPath = path.join(homeDir, "Documents", "file.jsonl");
			const result = hostToContainerSessionPath(otherPath);
			assert.strictEqual(
				result,
				otherPath,
				"paths outside host agent dir should pass through unchanged",
			);
		});
	});

	describe("round-trip", () => {
		it("should round-trip container → host → container", () => {
			const originalContainerPath =
				"/home/node/.pi/agent/sessions/--workspace--/abc.jsonl";
			const hostPath = containerToHostSessionPath(originalContainerPath);
			const roundTripped = hostToContainerSessionPath(hostPath);
			assert.strictEqual(roundTripped, originalContainerPath);
		});

		it("should round-trip host → container → host", () => {
			const originalHostPath = path.join(
				homeDir,
				".pi",
				"agent",
				"sessions",
				"--workspace--",
				"xyz.jsonl",
			);
			const containerPath = hostToContainerSessionPath(originalHostPath);
			const roundTripped = containerToHostSessionPath(containerPath);

			// Normalize separators for comparison (Windows uses backslashes)
			assert.strictEqual(
				roundTripped.replace(/\\/g, "/"),
				originalHostPath.replace(/\\/g, "/"),
			);
		});
	});

	describe("CONTAINER_AGENT_DIR", () => {
		it("should be the expected container agent directory prefix", () => {
			assert.strictEqual(CONTAINER_AGENT_DIR, "/home/node/.pi/agent/");
		});
	});
});
