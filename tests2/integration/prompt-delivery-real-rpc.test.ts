import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { RpcBridge } from "../../src/server/agent/rpc-bridge.js";
import { SessionStore } from "../../src/server/agent/session-store.js";

const PI_VERSION = "0.82.1";
const toolsRoot = path.resolve("defaults/tools");
const cliPath = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const dockerReady = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
	&& spawnSync("docker", ["image", "inspect", "bobbit-agent"], { stdio: "ignore" }).status === 0;
const containers = new Set<string>();
const tempRoots = new Set<string>();

function toolManager(): any {
	return {
		getBuiltinToolsDir: () => toolsRoot,
		getExtensionPath: (name: string, entry: string) => path.join(toolsRoot, name, entry),
	};
}

function pinnedHostPiVersion(): string {
	return JSON.parse(fs.readFileSync(path.resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
}

async function waitForStopped(bridge: RpcBridge): Promise<void> {
	for (let attempt = 0; attempt < 100 && bridge.running; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(bridge.running).toBe(false);
}

afterEach(() => {
	for (const id of containers) spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
	containers.clear();
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
	tempRoots.clear();
});

describe("real prompt-delivery RPC generations", () => {
	it("loads the exact extension through the pinned direct Pi runtime", async () => {
		expect(pinnedHostPiVersion()).toBe(PI_VERSION);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-direct-"));
		tempRoots.add(cwd);
		const bridge = new RpcBridge({ cwd, cliPath, toolManager: toolManager() });
		try {
			await bridge.start();
			expect(bridge.promptDeliveryProtocol).toBe("v1");
			expect((await bridge.getState())?.success).toBe(true);
		} finally {
			await bridge.stop();
			fs.rmSync(cwd, { recursive: true, force: true });
			tempRoots.delete(cwd);
		}
	}, 20_000);

	it.skipIf(!dockerReady)("keeps a durable awaiting-ACK row across a real Docker Pi crash", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-docker-"));
		tempRoots.add(root);
		const stateDir = path.join(root, "state");
		const store = new SessionStore(stateDir);
		const sessionId = "docker-prompt-crash";
		store.put({
			id: sessionId,
			title: sessionId,
			cwd: "/workspace",
			agentSessionFile: "/workspace/session.jsonl",
			createdAt: 1,
			lastActivity: 1,
			messageQueue: [{
				id: "stable-row",
				text: "survive docker crash",
				isSteered: false,
				createdAt: 1,
				deliveryState: "awaiting-ack",
				deliveryAttempt: 1,
				deliveryPromptId: "stable-row",
			} as any],
		});
		await store.flushAsync();

		const started = spawnSync("docker", [
			"run", "-d", "--rm",
			"--mount", `type=bind,source=${toolsRoot},target=/tools-builtin,readonly`,
			"--mount", `type=bind,source=${root},target=/workspace`,
			"bobbit-agent", "sh", "-c", "while :; do sleep 3600; done",
		], { encoding: "utf8" });
		expect(started.status, started.stderr).toBe(0);
		const containerId = started.stdout.trim();
		containers.add(containerId);
		const version = spawnSync("docker", ["exec", containerId, "node", "-p", "require('/node_modules/@earendil-works/pi-coding-agent/package.json').version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		expect(version.stdout.trim()).toBe(PI_VERSION);

		const bridge = new RpcBridge({ containerId, cwd: "/workspace", toolManager: toolManager() });
		await bridge.start();
		expect(bridge.promptDeliveryProtocol).toBe("v1");
		expect((await bridge.getState())?.success).toBe(true);

		spawnSync("docker", ["kill", containerId], { stdio: "ignore" });
		containers.delete(containerId);
		await waitForStopped(bridge);
		const restored = new SessionStore(stateDir).get(sessionId);
		expect(restored?.messageQueue).toEqual([
			expect.objectContaining({ id: "stable-row", deliveryPromptId: "stable-row" }),
		]);
		fs.rmSync(root, { recursive: true, force: true });
		tempRoots.delete(root);
	}, 60_000);
});
