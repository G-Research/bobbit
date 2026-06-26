import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDockerRunArgs } from "../src/server/agent/docker-args.js";
import { prepareSanitizedSandboxCloneSource, resolveSandboxCloneSource } from "../src/server/agent/sandbox-clone-source.js";
import { toDockerPath } from "../src/server/agent/rpc-bridge.js";

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

	it("mounts the configured active agent sessions and models but never host auth.json", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-docker-agent-dir-"));
		const agentDir = path.join(root, "active-agent");
		const stateDir = path.join(root, "state");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "models.json"), "{}");
		fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ secret: "host-auth-must-not-mount" }));

		const oldBobbitDir = process.env.BOBBIT_DIR;
		const oldBobbitAgentDir = process.env.BOBBIT_AGENT_DIR;
		const oldPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.BOBBIT_DIR = root;
			process.env.BOBBIT_AGENT_DIR = agentDir;
			delete process.env.PI_CODING_AGENT_DIR;
			await configureAgentDirForDockerTest(agentDir, root);

			const args = buildDockerRunArgs({
				image: "test", workspaceDir: "/tmp/test",
				stateDir,
			});
			const mounts = args.filter((a, i) => args[i - 1] === "-v");
			const hostSessionsDir = path.join(agentDir, "sessions");
			const hostModelsJson = path.join(agentDir, "models.json");
			const hostAuthJson = path.join(agentDir, "auth.json");

			assert.ok(
				mounts.includes(`${toDockerPath(hostSessionsDir)}:/home/node/.bobbit/agent/sessions`),
				`expected configured sessions mount, got: ${JSON.stringify(mounts)}`,
			);
			assert.ok(
				mounts.includes(`${toDockerPath(hostModelsJson)}:/home/node/.bobbit/agent/models.json:ro`),
				`expected configured models.json read-only mount, got: ${JSON.stringify(mounts)}`,
			);
			assert.ok(
				!mounts.some((m) => m.startsWith(`${toDockerPath(agentDir)}:`) && !m.includes("/sessions")),
				"must not mount the whole active agent directory",
			);
			assert.ok(
				!mounts.some((m) => m.startsWith(`${toDockerPath(hostAuthJson)}:`)),
				"must not mount host agent auth.json into the sandbox",
			);
			const sandboxAuthMount = mounts.find((m) => m.endsWith(":/home/node/.bobbit/agent/auth.json:ro"));
			assert.ok(sandboxAuthMount, `expected scoped sandbox auth mount, got: ${JSON.stringify(mounts)}`);
			assert.ok(
				!sandboxAuthMount!.startsWith(`${toDockerPath(hostAuthJson)}:`),
				"sandbox auth mount must use the scoped generated auth file, not host auth.json",
			);
		} finally {
			if (oldBobbitDir === undefined) delete process.env.BOBBIT_DIR; else process.env.BOBBIT_DIR = oldBobbitDir;
			if (oldBobbitAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR; else process.env.BOBBIT_AGENT_DIR = oldBobbitAgentDir;
			if (oldPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPiAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("mounts a sanitized remote-less clone source without exposing project-local agent auth", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-docker-clone-source-"));
		const projectDir = path.join(root, "project");
		const stateDir = path.join(projectDir, ".bobbit", "state");
		const agentDir = path.join(projectDir, ".bobbit", "agent");
		const hostAuthJson = path.join(agentDir, "auth.json");
		const oldBobbitDir = process.env.BOBBIT_DIR;
		const oldBobbitAgentDir = process.env.BOBBIT_AGENT_DIR;
		const oldPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "remote-less" }));
			fs.writeFileSync(hostAuthJson, JSON.stringify({ secret: "host-auth-must-not-leak" }));
			runGit(projectDir, ["init"]);
			runGit(projectDir, ["add", "package.json", ".bobbit/agent/auth.json"]);
			runGit(projectDir, ["commit", "-m", "init"]);

			const sanitizedSource = prepareSanitizedSandboxCloneSource({ repoPath: projectDir, stateDir, key: "root" });
			assert.ok(fs.existsSync(path.join(sanitizedSource, ".git")), "sanitized source should be a git repo");
			assert.ok(
				!fs.existsSync(path.join(sanitizedSource, ".bobbit", "agent", "auth.json")),
				"sanitized source must not contain project-local agent auth",
			);

			const cloneSource = resolveSandboxCloneSource({ originUrl: undefined, mountSourcePath: sanitizedSource });
			assert.equal(cloneSource.kind, "mounted");

			process.env.BOBBIT_DIR = path.join(projectDir, ".bobbit");
			process.env.BOBBIT_AGENT_DIR = agentDir;
			delete process.env.PI_CODING_AGENT_DIR;
			await configureAgentDirForDockerTest(agentDir, projectDir);
			const args = buildDockerRunArgs({
				image: "test",
				workspaceDir: "",
				projectId: "remote-less-default-agent-dir",
				stateDir,
				extraReadonlyMounts: [{ hostPath: cloneSource.hostPath, mountPath: cloneSource.mountPath }],
			});
			const mounts = args.filter((a, i) => args[i - 1] === "-v");
			assert.ok(
				mounts.includes(`${toDockerPath(sanitizedSource)}:/workspace-src:ro`),
				`expected sanitized /workspace-src mount, got: ${JSON.stringify(mounts)}`,
			);
			assert.ok(
				!mounts.includes(`${toDockerPath(projectDir)}:/workspace-src:ro`),
				"must not bind-mount the full project root as /workspace-src",
			);
			assert.ok(
				!mounts.some((m) => m.startsWith(`${toDockerPath(hostAuthJson)}:`)),
				"must not bind-mount host agent auth.json",
			);
			const sandboxAuthMount = mounts.find((m) => m.endsWith(":/home/node/.bobbit/agent/auth.json:ro"));
			assert.ok(sandboxAuthMount, "scoped sandbox auth mount should still be present");
			assert.ok(
				!sandboxAuthMount!.startsWith(`${toDockerPath(hostAuthJson)}:`),
				"scoped sandbox auth must not be the host agent auth.json",
			);
			assert.ok(sandboxAuthMount!.includes("sandbox-agent-auth"), "scoped sandbox auth file should be used");
		} finally {
			if (oldBobbitDir === undefined) delete process.env.BOBBIT_DIR; else process.env.BOBBIT_DIR = oldBobbitDir;
			if (oldBobbitAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR; else process.env.BOBBIT_AGENT_DIR = oldBobbitAgentDir;
			if (oldPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPiAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

function runGit(cwd: string, args: string[]): void {
	execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Bobbit Test",
			GIT_AUTHOR_EMAIL: "bobbit-test@example.com",
			GIT_COMMITTER_NAME: "Bobbit Test",
			GIT_COMMITTER_EMAIL: "bobbit-test@example.com",
		},
	});
}

async function configureAgentDirForDockerTest(agentDir: string, projectRoot: string): Promise<void> {
	const mod = await import("../src/server/bobbit-dir.ts") as Record<string, any>;
	const reset = mod.resetAgentDirStateForTests || mod.resetAgentDirRuntimeForTests;
	if (typeof reset === "function") reset();
	if (typeof mod.setProjectRoot === "function") mod.setProjectRoot(projectRoot);
	if (typeof mod.initializeAgentDirState === "function") {
		mod.initializeAgentDirState({ env: { BOBBIT_AGENT_DIR: agentDir }, projectRoot });
	} else if (typeof mod.initializeAgentDirRuntimeState === "function") {
		mod.initializeAgentDirRuntimeState({ env: { BOBBIT_AGENT_DIR: agentDir }, projectRoot });
	}
}
