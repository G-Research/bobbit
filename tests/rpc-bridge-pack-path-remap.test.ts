import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectRoot, setProjectRoot } from "../src/server/bobbit-dir.ts";
import { buildDockerRunArgs } from "../src/server/agent/docker-args.ts";
import {
	BUILTIN_PACKS_CONTAINER_DIR,
	GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR,
	PROJECT_MARKET_PACKS_CONTAINER_DIR,
	RpcBridge,
	SERVER_MARKET_PACKS_CONTAINER_DIR,
	containerPathToHost,
	hostPathToContainer,
	tryHostPathToContainer,
	toDockerPath,
} from "../src/server/agent/rpc-bridge.ts";
import { scopePaths } from "../src/server/agent/pack-types.ts";
import { TOOLS_DIR } from "../src/server/agent/tool-manager.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-rpc-pack-remap-"));
const previousBuiltinPacksDir = process.env.BOBBIT_BUILTIN_PACKS_DIR;
const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
const previousProjectRoot = getProjectRoot();
const serverRoot = path.join(root, "server-root");
const projectRoot = path.join(root, "project-root");
const builtinToolsDir = path.join(root, "defaults", "tools");
const builtinPacksDir = path.join(root, "builtin-packs", "market-packs");
const serverMarketPacksRoot = scopePaths("server", serverRoot).marketPacksRoot;
const projectMarketPacksRoot = scopePaths("project", projectRoot).marketPacksRoot;

before(() => {
	fs.mkdirSync(path.join(builtinToolsDir, "_builtins"), { recursive: true });
	fs.mkdirSync(path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough"), { recursive: true });
	fs.mkdirSync(path.join(builtinPacksDir, "runtime-demo", "pi-extensions", "demo"), { recursive: true });
	fs.mkdirSync(path.join(serverMarketPacksRoot, "server-pack", "pi-extensions", "demo"), { recursive: true });
	fs.mkdirSync(path.join(serverMarketPacksRoot, "server-pack", "tools", "demo"), { recursive: true });
	fs.mkdirSync(path.join(projectMarketPacksRoot, "project-pack", "pi-extensions", "demo"), { recursive: true });
	process.env.BOBBIT_BUILTIN_PACKS_DIR = builtinPacksDir;
	process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");
	setProjectRoot(serverRoot);
});

after(() => {
	if (previousBuiltinPacksDir === undefined) delete process.env.BOBBIT_BUILTIN_PACKS_DIR;
	else process.env.BOBBIT_BUILTIN_PACKS_DIR = previousBuiltinPacksDir;
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	setProjectRoot(previousProjectRoot);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("RpcBridge Docker path remapping for market pack extensions", () => {
	it("remaps built-in first-party pack extension args without regressing /tools or /tools-builtin", () => {
		const packExtension = path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts");
		const configExtension = path.join(TOOLS_DIR, "shell", "extension.ts");
		const builtinExtension = path.join(builtinToolsDir, "_builtins", "extension.ts");
		const bridge = new RpcBridge({
			containerId: "container-123",
			toolManager: { getBuiltinToolsDir: () => builtinToolsDir } as any,
		});

		const remapped = (bridge as any).remapArgsForContainer([
			"--extension", configExtension,
			"--extension", builtinExtension,
			"--extension", packExtension,
		]);

		assert.deepEqual(remapped, [
			"--extension", "/tools/shell/extension.ts",
			"--extension", "/tools-builtin/_builtins/extension.ts",
			"--extension", `${BUILTIN_PACKS_CONTAINER_DIR}/pr-walkthrough/tools/pr-walkthrough/extension.ts`,
		]);
	});

	it("translates built-in first-party pack paths in the bind-mount table", () => {
		const hostPath = path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts");
		const containerPath = `${BUILTIN_PACKS_CONTAINER_DIR}/pr-walkthrough/tools/pr-walkthrough/extension.ts`;
		assert.equal(hostPathToContainer(hostPath), containerPath);
		assert.equal(containerPathToHost(containerPath), hostPath);
	});

	it("remaps installed server/global/project market pack pi-extension paths", () => {
		const serverPiExtension = path.join(serverMarketPacksRoot, "server-pack", "pi-extensions", "demo", "extension.ts");
		const serverToolExtension = path.join(serverMarketPacksRoot, "server-pack", "tools", "demo", "extension.ts");
		const globalPiExtension = path.join(os.homedir(), ".bobbit", "config", "market-packs", "global-pack", "pi-extensions", "demo", "extension.js");
		const projectPiExtension = path.join(projectMarketPacksRoot, "project-pack", "pi-extensions", "demo", "index.mjs");
		const bridge = new RpcBridge({ containerId: "container-123", cwd: projectRoot });

		const remapped = (bridge as any).remapArgsForContainer([
			"--extension", serverPiExtension,
			"--extension", serverToolExtension,
			"--extension", globalPiExtension,
			"--extension", projectPiExtension,
		]);

		assert.deepEqual(remapped, [
			"--extension", `${SERVER_MARKET_PACKS_CONTAINER_DIR}/server-pack/pi-extensions/demo/extension.ts`,
			"--extension", `${SERVER_MARKET_PACKS_CONTAINER_DIR}/server-pack/tools/demo/extension.ts`,
			"--extension", `${GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR}/global-pack/pi-extensions/demo/extension.js`,
			"--extension", `${PROJECT_MARKET_PACKS_CONTAINER_DIR}/project-pack/pi-extensions/demo/index.mjs`,
		]);
	});

	it("translates installed project pack paths when project base is known", () => {
		const hostPath = path.join(projectMarketPacksRoot, "project-pack", "pi-extensions", "demo", "index.mjs");
		const containerPath = `${PROJECT_MARKET_PACKS_CONTAINER_DIR}/project-pack/pi-extensions/demo/index.mjs`;
		assert.equal(hostPathToContainer(hostPath, { projectBase: projectRoot }), containerPath);
		assert.equal(containerPathToHost(containerPath, { projectBase: projectRoot }), hostPath);
	});

	it("translates project pack paths in named-volume sandbox mode when host pack root is known", () => {
		const hostPath = path.join(projectMarketPacksRoot, "project-pack", "pi-extensions", "demo", "index.mjs");
		const containerPath = `${PROJECT_MARKET_PACKS_CONTAINER_DIR}/project-pack/pi-extensions/demo/index.mjs`;
		assert.equal(hostPathToContainer(hostPath, { projectBase: "/workspace", projectMarketPacksRoot }), containerPath);
		assert.equal(tryHostPathToContainer(hostPath, { projectBase: "/workspace", projectMarketPacksRoot }), containerPath);
	});

	it("records runtime load diagnostics from conservative pi stderr matching", () => {
		const hostPath = path.join(projectMarketPacksRoot, "project-pack", "pi-extensions", "demo", "index.mjs");
		const diagnostics: any[] = [];
		const bridge = new RpcBridge({
			piExtensions: [{
				listName: "demo",
				entryPath: hostPath,
				entryRelativePath: "pi-extensions/demo/index.mjs",
				packRoot: path.dirname(path.dirname(path.dirname(hostPath))),
				origin: { scope: "project", packName: "project-pack", packId: "project-pack" },
			}],
			onPiExtensionDiagnostic: (diagnostic, extension) => diagnostics.push({ diagnostic, extension }),
		});

		(bridge as any).recordPiExtensionLoadFailureFromStderr(`Failed to load extension ${hostPath}: activation boom`);
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0].diagnostic.status, "runtime-load-failed");
		assert.match(diagnostics[0].diagnostic.message, /activation boom/);
	});

	it("omits sandboxed pi extensions that cannot be remapped and records a diagnostic", () => {
		const hostPath = path.join(root, "unmounted-project", ".bobbit", "config", "market-packs", "project-pack", "pi-extensions", "demo", "index.mjs");
		const diagnostics: any[] = [];
		const bridge = new RpcBridge({
			containerId: "container-123",
			cwd: "/workspace",
			piExtensions: [{
				listName: "demo",
				entryPath: hostPath,
				entryRelativePath: "pi-extensions/demo/index.mjs",
				packRoot: path.dirname(path.dirname(path.dirname(hostPath))),
				origin: { scope: "project", packName: "project-pack", packId: "project-pack" },
			}],
			onPiExtensionDiagnostic: (diagnostic, extension) => diagnostics.push({ diagnostic, extension }),
		});

		const remapped = (bridge as any).remapArgsForContainer(["--extension", hostPath, "--model", "x/y"]);
		assert.deepEqual(remapped, ["--model", "x/y"]);
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0].diagnostic.status, "remap-failed");
		assert.equal(diagnostics[0].extension.listName, "demo");
	});

	it("mounts installed market pack roots read-only for Docker sandboxes", () => {
		const args = buildDockerRunArgs({
			image: "bobbit-test:latest",
			workspaceDir: projectRoot,
			projectId: "proj-remap",
			stateDir: path.join(root, "state"),
		});

		assert.ok(args.includes(`${toDockerPath(serverMarketPacksRoot)}:${SERVER_MARKET_PACKS_CONTAINER_DIR}:ro`));
		assert.ok(args.includes(`${toDockerPath(projectMarketPacksRoot)}:${PROJECT_MARKET_PACKS_CONTAINER_DIR}:ro`));
	});

	it("mounts project market packs in named-volume project sandbox mode", () => {
		const args = buildDockerRunArgs({
			image: "bobbit-test:latest",
			workspaceDir: "",
			projectId: "proj-remap",
			projectMarketPacksRoot,
			stateDir: path.join(root, "state-named-volume"),
		});

		assert.ok(args.includes(`${toDockerPath(projectMarketPacksRoot)}:${PROJECT_MARKET_PACKS_CONTAINER_DIR}:ro`));
	});
});
