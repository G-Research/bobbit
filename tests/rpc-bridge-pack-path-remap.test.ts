import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RpcBridge, containerPathToHost, hostPathToContainer } from "../src/server/agent/rpc-bridge.ts";
import { TOOLS_DIR } from "../src/server/agent/tool-manager.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-rpc-pack-remap-"));
const builtinToolsDir = path.join(root, "defaults", "tools");
const builtinPacksDir = path.join(root, "builtin-packs", "market-packs");
fs.mkdirSync(path.join(builtinToolsDir, "_builtins"), { recursive: true });
fs.mkdirSync(path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough"), { recursive: true });
process.env.BOBBIT_BUILTIN_PACKS_DIR = builtinPacksDir;

describe("RpcBridge Docker path remapping for built-in pack tools", () => {
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
			"--extension", "/market-packs-builtin/pr-walkthrough/tools/pr-walkthrough/extension.ts",
		]);
	});

	it("translates built-in first-party pack paths in the bind-mount table", () => {
		const hostPath = path.join(builtinPacksDir, "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts");
		const containerPath = "/market-packs-builtin/pr-walkthrough/tools/pr-walkthrough/extension.ts";
		assert.equal(hostPathToContainer(hostPath), containerPath);
		assert.equal(containerPathToHost(containerPath), hostPath);
	});
});
