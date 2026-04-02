import { describe, it } from "node:test";
import assert from "node:assert";
import { buildDockerRunArgs } from "../src/server/agent/docker-args.js";

describe("buildDockerRunArgs", () => {
	it("includes resource limits", () => {
		const args = buildDockerRunArgs({
			mode: "pool", image: "test", workspaceDir: "/tmp/test",
			label: "test", labelPrefix: "bobbit-sandbox",
		});
		assert.ok(args.includes("--memory=4g"));
		assert.ok(args.includes("--cpus=2"));
		assert.ok(args.includes("--pids-limit=256"));
	});

	it("blackholes cloud metadata endpoints when sandboxNetwork is set", () => {
		const args = buildDockerRunArgs({
			mode: "pool", image: "test", workspaceDir: "/tmp/test",
			sandboxNetwork: "bobbit-sandbox-net",
		});
		assert.ok(args.some(a => a.includes("169.254.169.254")));
		assert.ok(args.some(a => a.includes("metadata.google.internal")));
		assert.ok(args.some(a => a.includes("metadata.internal")));
	});
});
