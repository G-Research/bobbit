// v2-native — integration coverage for the three independent Claude SDK permission ceilings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { buildClaudeSdkExtensionManifest, ClaudeSdkExtensionDispatcher } from "../../src/server/agent/claude-sdk-tool-dispatcher.ts";
import { ToolManager } from "../../src/server/agent/tool-manager.ts";

type Grant = { granted: boolean; tools?: string[]; group?: string; mode?: "one-time" | "session-only" | "persistent"; reason?: string };

function fixture(grant: (name: string, group: string, options?: { signal: AbortSignal; toolUseId?: string }) => Promise<Grant> = async () => ({ granted: false })) {
	const dispatched: Array<{ name: string; args: unknown }> = [];
	const surface = buildClaudeSdkToolSurface({
		sessionId: "sdk-permission-session",
		restriction: "unrestricted",
		entries: [
			{ name: "read", group: "Files", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow", invoke: async args => { dispatched.push({ name: "read", args }); return { content: [{ type: "text", text: "ok" }] }; } },
			{ name: "ask_user_choices", group: "Ask", description: "Ask the user", inputSchema: { type: "object", properties: { questions: { type: "array" } } }, policy: "ask", invoke: async () => "ok" },
			{ name: "ask_other", group: "Ask", description: "Another ask", inputSchema: { type: "object", properties: {} }, policy: "ask", invoke: async () => "ok" },
			{ name: "bash", group: "Shell", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } }, policy: "never", invoke: async () => "never" },
		],
		requestToolGrant: (name, group, options) => grant(name, group, options),
	});
	return { surface, dispatched };
}

function canUse(surface: ReturnType<typeof fixture>["surface"], name: string, overrides: Record<string, unknown> = {}) {
	return (surface.canUseTool as any)(name, {}, { signal: new AbortController().signal, toolUseID: "tool-use-1", ...overrides });
}

function preUse(surface: ReturnType<typeof fixture>["surface"], name: string, toolUseId = "tool-use-1") {
	return (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: name, tool_use_id: toolUseId });
}

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workerFixture(): { root: string; cwd: string; manager: ToolManager; scope: { cwd: string; scopeKey: string } } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sdk-worker-"));
	tempRoots.push(root);
	const cwd = path.join(root, "workspace");
	const configRoot = path.join(root, "config");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(configRoot, "tools"), { recursive: true });
	return { root, cwd, manager: new ToolManager(configRoot, path.resolve("defaults/tools")), scope: { cwd, scopeKey: `cwd:${cwd}` } };
}

function workerEnv(manifest: ReturnType<typeof buildClaudeSdkExtensionManifest>): Record<string, string> {
	return { BOBBIT_BUILTIN_TOOLS: [...new Set(manifest.flatMap(entry => entry.builtinToolNames ?? []))].sort().join(",") };
}

describe("Claude SDK Bobbit tool permission integration", () => {
	it("applies registration, canUseTool, and PreToolUse ceilings independently", async () => {
		const { surface } = fixture();
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(surface.entriesByCanonicalLower.has("bash")).toBe(true);
		for (const name of ["mcp__bobbit__bash", "Bash", "mcp__foreign__read", "mcp__bobbit__", "mcp__bobbit__missing"]) {
			await expect(canUse(surface, name)).resolves.toMatchObject({ behavior: "deny" });
			expect((await preUse(surface, name)).hookSpecificOutput.permissionDecision).toBe("deny");
		}
		await expect(canUse(surface, "mcp__bobbit__read")).resolves.toMatchObject({ behavior: "allow" });
		expect((await preUse(surface, "mcp__bobbit__read")).hookSpecificOutput.permissionDecision).toBe("allow");
	});

	it("requires a current exact grant and never caches one-time approval", async () => {
		let calls = 0;
		const { surface } = fixture(async () => { calls++; return { granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }; });
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "one" })).resolves.toMatchObject({ behavior: "allow" });
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "one")).hookSpecificOutput.permissionDecision).toBe("allow");
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "two" })).resolves.toMatchObject({ behavior: "allow" });
		expect(calls).toBe(2);
		// PreToolUse runs before canUseTool, so it must preserve the ask ceiling.
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "bypass")).hookSpecificOutput.permissionDecision).toBe("ask");
	});

	it("binds approvals to their canonical tool and denies subagent hook calls", async () => {
		const { surface } = fixture(async () => ({ granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }));
		await canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "shared" });
		// A malicious same tool-use id cannot replay an ask approval for another tool.
		expect((await preUse(surface, "mcp__bobbit__ask_other", "shared")).hookSpecificOutput.permissionDecision).toBe("ask");
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "shared")).hookSpecificOutput.permissionDecision).toBe("allow");
		expect((await (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: "mcp__bobbit__read", tool_use_id: "native", agent_id: "child" })).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("passes cancellation to the grant seam and denies the abandoned request", async () => {
		let captured: AbortSignal | undefined;
		const { surface } = fixture(async (_name, _group, options?: { signal: AbortSignal }) => {
			captured = options?.signal;
			return new Promise(resolve => options?.signal.addEventListener("abort", () => resolve({ granted: false, reason: "cancelled" }), { once: true }));
		});
		const controller = new AbortController();
		const pending = (surface.canUseTool as any)("mcp__bobbit__ask_user_choices", {}, { signal: controller.signal, toolUseID: "cancelled" });
		controller.abort();
		await expect(pending).resolves.toMatchObject({ behavior: "deny" });
		expect(captured?.aborted).toBe(true);
	});

	it("dispatches and renders the canonical Bobbit name", async () => {
		const { surface, dispatched } = fixture();
		await expect(surface.invoke("mcp__bobbit__ReAd", { path: "README.md" })).resolves.toMatchObject({ content: expect.any(Array) });
		expect(dispatched).toEqual([{ name: "read", args: { path: "README.md" } }]);
		expect(surface.renderToolName("mcp__bobbit__ReAd")).toBe("read");
	});

	it("preflights exact builtin schemas and dispatches read in the selected cwd", async () => {
		const { cwd, manager, scope } = workerFixture();
		fs.writeFileSync(path.join(cwd, "note.txt"), "worker read succeeds");
		const manifest = buildClaudeSdkExtensionManifest(manager, scope, ["read"]);
		expect(manifest).toMatchObject([{ selectedToolNames: ["read"], allowedToolNames: ["read"], builtinToolNames: ["read"] }]);
		const dispatcher = new ClaudeSdkExtensionDispatcher({ cwd, env: workerEnv(manifest), manifest });
		try {
			await expect(dispatcher.start()).resolves.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "read", inputSchema: expect.objectContaining({ type: "object" }) }),
			]));
			const result = await dispatcher.invoke("read", { path: "note.txt" }, {});
			expect(JSON.stringify(result)).toContain("worker read succeeds");
		} finally {
			dispatcher.dispose();
		}
	});

	it("allows trusted shell siblings while exposing only a selected multi-tool subset", async () => {
		const { cwd, manager, scope } = workerFixture();
		const manifest = buildClaudeSdkExtensionManifest(manager, scope, ["bash", "read"]);
		const shell = manifest.find(entry => entry.selectedToolNames.includes("bash"));
		expect(shell?.allowedToolNames).toEqual(expect.arrayContaining(["bash", "bash_bg"]));
		const dispatcher = new ClaudeSdkExtensionDispatcher({ cwd, env: workerEnv(manifest), manifest });
		try {
			await expect(dispatcher.start()).resolves.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "bash" }),
				expect.objectContaining({ name: "read" }),
			]));
		} finally {
			dispatcher.dispose();
		}
	});

	it("fails closed on worker manifest collisions and forwards ctx.cwd and cancellation after startup", async () => {
		const { root, cwd } = workerFixture();
		const collision = new ClaudeSdkExtensionDispatcher({
			cwd,
			env: {},
			manifest: [
				{ extensionPath: path.resolve("defaults/tools/shell/extension.ts"), selectedToolNames: ["bash"], allowedToolNames: ["shared"] },
				{ extensionPath: path.resolve("defaults/tools/_builtins/extension.ts"), selectedToolNames: ["read"], allowedToolNames: ["shared"] },
			],
		});
		await expect(collision.start()).rejects.toThrow();
		collision.dispose();

		const probeConfig = path.join(root, "probe-config");
		const group = path.join(probeConfig, "tools", "probe");
		fs.mkdirSync(group, { recursive: true });
		fs.writeFileSync(path.join(group, "cwd_probe.yaml"), "name: cwd_probe\ndescription: probe\ngroup: Probe\nprovider:\n  type: bobbit-extension\n  extension: extension.ts\n");
		fs.writeFileSync(path.join(group, "wait_probe.yaml"), "name: wait_probe\ndescription: wait\ngroup: Probe\nprovider:\n  type: bobbit-extension\n  extension: extension.ts\n");
		fs.writeFileSync(path.join(group, "extension.ts"), `
			export default function (pi) {
				pi.registerTool({ name: "cwd_probe", label: "cwd", description: "cwd", parameters: { type: "object", properties: {} }, execute: async (_id, _args, _signal, _update, ctx) => ({ content: [{ type: "text", text: ctx.cwd }] }) });
				pi.registerTool({ name: "wait_probe", label: "wait", description: "wait", parameters: { type: "object", properties: {} }, execute: async (_id, _args, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })) });
			}
		`);
		const manager = new ToolManager(probeConfig, path.resolve("defaults/tools"));
		const scope = { cwd, scopeKey: `cwd:${cwd}` };
		const manifest = buildClaudeSdkExtensionManifest(manager, scope, ["cwd_probe", "wait_probe"]);
		const dispatcher = new ClaudeSdkExtensionDispatcher({ cwd, env: workerEnv(manifest), manifest });
		await dispatcher.start();
		await expect(dispatcher.invoke("cwd_probe", {}, {})).resolves.toMatchObject({ content: [{ text: cwd }] });
		const controller = new AbortController();
		const pending = dispatcher.invoke("wait_probe", {}, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow();
		dispatcher.dispose();
		await expect(dispatcher.invoke("cwd_probe", {}, {})).rejects.toThrow(/stopped|cancelled/i);
	});
});
