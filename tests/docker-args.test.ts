import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDockerRunArgs } from "../src/server/agent/docker-args.js";

describe("buildDockerRunArgs", () => {
	it("includes resource limits", () => {
		const args = buildDockerRunArgs({
			mode: "pool", image: "test", workspaceDir: "/tmp/test",
			label: "test", labelPrefix: "bobbit-sandbox",
		});
		assert.ok(args.includes("--memory=32g"));
		assert.ok(args.includes("--cpus=12"));
		assert.ok(args.includes("--pids-limit=512"));
	});

	it("allows custom resource limits", () => {
		const args = buildDockerRunArgs({
			mode: "pool", image: "test", workspaceDir: "/tmp/test",
			label: "test", labelPrefix: "bobbit-sandbox",
			memoryLimit: "8g", cpuLimit: "4", pidsLimit: "512",
		});
		assert.ok(args.includes("--memory=8g"));
		assert.ok(args.includes("--cpus=4"));
		assert.ok(args.includes("--pids-limit=512"));
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

	it("mounts named workspace and worktrees volumes when projectId is set", () => {
		const projectId = "test-project-abc";
		const args = buildDockerRunArgs({
			image: "test", workspaceDir: "/tmp/test",
			projectId,
		});
		assert.ok(
			args.includes(`bobbit-workspace-${projectId}:/workspace`),
			"should mount workspace named volume",
		);
		assert.ok(
			args.includes(`bobbit-worktrees-${projectId}:/workspace-wt`),
			"should mount worktrees named volume",
		);
	});

	it("does not mount worktrees volume when projectId is not set", () => {
		const args = buildDockerRunArgs({
			image: "test", workspaceDir: "/tmp/test",
		});
		assert.ok(
			!args.some(a => a.includes("/workspace-wt")),
			"should not mount worktrees volume without projectId",
		);
	});

	it("mounts config tools, builtin tools, and builtin first-party pack roots read-only", () => {
		const previousBuiltinPacksDir = process.env.BOBBIT_BUILTIN_PACKS_DIR;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-docker-pack-mounts-"));
		const builtinToolsDir = path.join(root, "defaults", "tools");
		const builtinPacksDir = path.join(root, "builtin-packs", "market-packs");
		fs.mkdirSync(builtinToolsDir, { recursive: true });
		fs.mkdirSync(path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough"), { recursive: true });
		process.env.BOBBIT_BUILTIN_PACKS_DIR = builtinPacksDir;
		try {
			const args = buildDockerRunArgs({
				image: "test", workspaceDir: "/tmp/test",
				toolManager: { getBuiltinToolsDir: () => builtinToolsDir } as any,
			});
			const mounts = args.filter((a, i) => args[i - 1] === "-v");
			assert.ok(mounts.some((m) => m.endsWith(":/tools:ro")), "config tools mount stays /tools:ro");
			assert.ok(mounts.some((m) => m.endsWith(":/tools-builtin:ro")), "builtin tools mount stays /tools-builtin:ro");
			assert.ok(mounts.some((m) => m.endsWith(":/market-packs-builtin:ro")), "builtin first-party packs mount read-only");
		} finally {
			if (previousBuiltinPacksDir === undefined) delete process.env.BOBBIT_BUILTIN_PACKS_DIR;
			else process.env.BOBBIT_BUILTIN_PACKS_DIR = previousBuiltinPacksDir;
		}
	});
});
