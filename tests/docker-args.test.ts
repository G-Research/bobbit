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

	it("mounts the google-code-assist state subdir so sandboxed agents can load the provider extension", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-docker-gca-"));
		try {
			const args = buildDockerRunArgs({
				image: "test", workspaceDir: "/tmp/test",
				stateDir,
			});
			const mounts = args.filter((a, i) => args[i - 1] === "-v");
			assert.ok(
				mounts.some((m) => m.includes(":/bobbit-state/google-code-assist")),
				`expected a /bobbit-state/google-code-assist mount, got: ${JSON.stringify(mounts)}`,
			);
			// The mount must be a subdir (never the full state dir) and created on disk.
			assert.ok(
				fs.existsSync(path.join(stateDir, "google-code-assist")),
				"google-code-assist subdir should be created before mounting",
			);
			assert.ok(
				!mounts.some((m) => m.endsWith(":/bobbit-state")),
				"must never mount the full state dir",
			);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("mounts the google-code-assist state subdir READ-ONLY so a compromised sandbox cannot tamper with the generated provider extension", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-docker-gca-ro-"));
		try {
			const args = buildDockerRunArgs({
				image: "test", workspaceDir: "/tmp/test",
				stateDir,
			});
			const mounts = args.filter((a, i) => args[i - 1] === "-v");
			const gca = mounts.find((m) => m.includes(":/bobbit-state/google-code-assist"));
			assert.ok(gca, `expected a google-code-assist mount, got: ${JSON.stringify(mounts)}`);
			assert.ok(
				gca!.endsWith(":/bobbit-state/google-code-assist:ro"),
				`google-code-assist mount must be read-only (:ro), got: ${gca}`,
			);
			// The writable state subdirs must NOT have picked up :ro.
			for (const sub of ["sessions", "tool-guard", "html-snapshots"]) {
				const m = mounts.find((x) => x.includes(`:/bobbit-state/${sub}`));
				assert.ok(m, `expected a /bobbit-state/${sub} mount`);
				assert.ok(
					m!.endsWith(`:/bobbit-state/${sub}`),
					`/bobbit-state/${sub} must stay writable (no :ro), got: ${m}`,
				);
			}
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
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
