// v2-native — integration coverage for the three independent Claude SDK permission ceilings.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeSdkToolSurface, sdkZodShape } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { buildClaudeSdkExtensionManifest, buildClaudeSdkWorkerEnv, ClaudeSdkExtensionDispatcher, createMcpMetaToolHandler } from "../../src/server/agent/claude-sdk-tool-dispatcher.ts";
import { buildMetaToolInputSchema } from "../../src/server/mcp/mcp-meta.ts";
import { ToolManager } from "../../src/server/agent/tool-manager.ts";
import { buildClaudeSdkSurfaceAfterPreflight, deriveClaudeSdkMcpAggregates, resolveClaudeSdkWorkerGatewayCredentials } from "../../src/server/agent/session-setup.ts";
import { buildClaudeAgentSdkEnv } from "../../src/server/agent/claude-agent-sdk-bridge.ts";

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

	it("starts an allow plus never surface without requiring a never schema and disposes failed preflight", async () => {
		const entries = [
			{ name: "read", group: "Files", description: "Read", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "read" },
			{ name: "bash", group: "Shell", description: "Bash", inputSchema: { type: "object", properties: {} }, policy: "never" as const, invoke: async () => "bash" },
		];
		const dispatcher = {
			start: vi.fn(async () => [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]),
			dispose: vi.fn(),
		};
		const surface = await buildClaudeSdkSurfaceAfterPreflight(
			dispatcher,
			entries,
			new Map([["read", { type: "builtin" }], ["bash", { type: "builtin" }]]),
			() => buildClaudeSdkToolSurface({ sessionId: "allow-never", restriction: "restricted", entries, requestToolGrant: async () => ({ granted: false }) }),
		);
		expect(dispatcher.start).toHaveBeenCalledOnce();
		expect(entries[0].inputSchema.properties).toHaveProperty("path");
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		await expect(canUse(surface, "mcp__bobbit__bash")).resolves.toMatchObject({ behavior: "deny" });

		const failedDispatcher = { start: vi.fn(async () => { throw new Error("preflight failed"); }), dispose: vi.fn() };
		await expect(buildClaudeSdkSurfaceAfterPreflight(
			failedDispatcher,
			entries,
			new Map([["read", { type: "builtin" }], ["bash", { type: "builtin" }]]),
			() => { throw new Error("must not build"); },
		)).rejects.toThrow("preflight failed");
		expect(failedDispatcher.dispose).toHaveBeenCalledOnce();
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

	it("runs a sandbox dispatcher through the current container instead of a host Worker", async () => {
		const child = new EventEmitter() as any;
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.killed = false;
		child.exitCode = null;
		child.signalCode = null;
		child.kill = vi.fn(() => true);
		const dockerSpawn = vi.fn((_command: string, args: string[]) => {
			expect(args).toEqual(expect.arrayContaining(["exec", "-i", "-w", "/workspace-wt/current", "container-current", "node"]));
			expect(args.join(" ")).toContain("BOBBIT_TOKEN=scoped-token");
			return child;
		});
		let input = "";
		child.stdin.on("data", (chunk: Buffer) => {
			input += chunk.toString();
			const lines = input.split("\n");
			input = lines.pop() ?? "";
			for (const line of lines) {
				const message = JSON.parse(line.slice("BOBBIT_SDK_DISPATCH:".length));
				if (message.type === "init") child.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "ready", schemas: [{ name: "read", inputSchema: { type: "object" } }], omittedConditional: [] }) + "\n");
				if (message.type === "invoke") child.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "result", id: message.id, result: "container-result" }) + "\n");
			}
		});
		const dispatcher = new ClaudeSdkExtensionDispatcher({
			cwd: "/host/must-not-run-tools",
			env: {},
			gatewayCredentials: { token: "scoped-token", url: "http://gateway.test" },
			manifest: [{ extensionPath: path.resolve("defaults/tools/_builtins/extension.ts"), selectedToolNames: ["read"], allowedToolNames: ["read"] }],
			sandbox: { containerId: "container-current", cwd: "/workspace-wt/current", builtinToolsDir: path.resolve("defaults/tools"), spawn: dockerSpawn as any, workerSource: "void 0" },
		});
		try {
			await expect(dispatcher.start()).resolves.toEqual([{ name: "read", inputSchema: { type: "object" } }]);
			await expect(dispatcher.invoke("read", {}, {})).resolves.toBe("container-result");
			expect(dockerSpawn).toHaveBeenCalledOnce();
		} finally {
			dispatcher.dispose();
		}
	});

	it("dispatches mixed-case MCP owners exactly and rejects forged never operations", async () => {
		const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
		const handler = createMcpMetaToolHandler("PlayWright", undefined, { callTool } as any, [
			{ operation: "browser_snapshot", toolName: "mcp__PlayWright__browser_snapshot" },
		]);
		await expect(handler({ operation: "browser_snapshot", args: {} }, {})).resolves.toMatchObject({ content: expect.any(Array) });
		expect(callTool).toHaveBeenCalledWith("mcp__PlayWright__browser_snapshot", {});
		await expect(handler({ operation: "browser_delete_everything", args: {} }, {})).rejects.toThrow("unavailable");
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it("rejects canonical aggregate collisions across distinct raw MCP owners", () => {
		expect(() => deriveClaudeSdkMcpAggregates([
			{ name: "mcp__PlayWright__browser_snapshot", inputSchema: { type: "object" } },
			{ name: "mcp__playwright__browser_click", inputSchema: { type: "object" } },
		], {
			"mcp__PlayWright__browser_snapshot": { policy: "allow" },
			"mcp__playwright__browser_click": { policy: "allow" },
		})).toThrow(/aggregate collision/i);
	});

	it("preserves nested ask and MCP enum schemas in the SDK Zod shape", () => {
		const askShape = sdkZodShape({
			type: "object",
			required: ["questions"],
			properties: {
				questions: {
					type: "array", minItems: 1, maxItems: 5, description: "Questions to ask.",
					items: {
						type: "object", required: ["question", "options"], additionalProperties: false,
						properties: {
							question: { type: "string", minLength: 1 },
							options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1 } },
							tab_label: { type: "string", maxLength: 24 },
							min: { type: "integer", minimum: 1 },
						},
					},
				},
			},
		});
		expect(askShape.questions.safeParse([{ question: "Pick", options: ["A", "B"], min: 1 }]).success).toBe(true);
		expect(askShape.questions.safeParse([{ question: "", options: ["A"] }]).success).toBe(false);
		expect(askShape.questions.safeParse([{ question: "Pick", options: ["A", "B"], min: 1.5 }]).success).toBe(false);
		expect((askShape.questions as any).description).toBe("Questions to ask.");

		const mcpShape = sdkZodShape(buildMetaToolInputSchema([
			{ name: "list", inputSchema: { type: "object", properties: {} } },
			{ name: "create", inputSchema: { type: "object", properties: {} } },
		] as any));
		expect(mcpShape.operation.safeParse("list").success).toBe(true);
		expect(mcpShape.operation.safeParse("delete").success).toBe(false);
	});

	it("requires wired scoped authority for sandbox dispatch without changing direct-worker fallback", () => {
		const adminToken = "admin-token-must-not-be-used";
		expect(() => resolveClaudeSdkWorkerGatewayCredentials({
			sandboxed: true,
			env: { BOBBIT_TOKEN: adminToken, BOBBIT_GATEWAY_URL: "http://host-env.test" },
		})).toThrow(/current scoped gateway authority/i);
		expect(resolveClaudeSdkWorkerGatewayCredentials({
			sandboxed: true,
			gatewayToken: "scoped-session-token",
			gatewayUrl: "http://scoped-gateway.test",
			env: { BOBBIT_TOKEN: adminToken, BOBBIT_GATEWAY_URL: "http://host-env.test" },
		})).toEqual({ token: "scoped-session-token", url: "http://scoped-gateway.test" });
	});

	it("reads fallback worker credentials from serverSecretsDir, never state/token, and omits them from the SDK child", async () => {
		const { root, cwd, manager, scope } = workerFixture();
		const secretsDir = path.join(root, "secrets");
		fs.mkdirSync(secretsDir, { recursive: true });
		const token = "a".repeat(64);
		fs.writeFileSync(path.join(secretsDir, "token"), token);
		const previousSecretsDir = process.env.BOBBIT_SECRETS_DIR;
		process.env.BOBBIT_SECRETS_DIR = secretsDir;
		const manifest = buildClaudeSdkExtensionManifest(manager, scope, ["task_list", "team_list", "activate_skill"]);
		const env = {
			BOBBIT_SESSION_ID: "sdk-worker-session",
			BOBBIT_GOAL_ID: "sdk-worker-goal",
			BOBBIT_GATEWAY_URL: "http://127.0.0.1:1",
		};
		try {
			const gatewayCredentials = resolveClaudeSdkWorkerGatewayCredentials({ env });
			expect(gatewayCredentials).toEqual({ token, url: "http://127.0.0.1:1" });
			expect(buildClaudeSdkWorkerEnv(env, gatewayCredentials)).toMatchObject({ BOBBIT_SESSION_ID: "sdk-worker-session", BOBBIT_TOKEN: token, BOBBIT_GATEWAY_URL: "http://127.0.0.1:1" });
			expect(buildClaudeAgentSdkEnv({ env: { ...env, BOBBIT_TOKEN: token } } as any)).not.toHaveProperty("BOBBIT_TOKEN");
			const dispatcher = new ClaudeSdkExtensionDispatcher({ cwd, env, gatewayCredentials, manifest });
			try {
				await expect(dispatcher.start()).resolves.toEqual(expect.arrayContaining([
					expect.objectContaining({ name: "task_list" }),
					expect.objectContaining({ name: "team_list" }),
					expect.objectContaining({ name: "activate_skill" }),
				]));
			} finally {
				dispatcher.dispose();
			}
		} finally {
			if (previousSecretsDir === undefined) delete process.env.BOBBIT_SECRETS_DIR;
			else process.env.BOBBIT_SECRETS_DIR = previousSecretsDir;
		}
	});

	it("retains TypeBox validation in the worker before handlers execute", async () => {
		const { root, cwd } = workerFixture();
		const extensionPath = path.join(root, "validation-extension.ts");
		fs.writeFileSync(extensionPath, `
			export default function (pi) {
				pi.registerTool({ name: "integer_probe", label: "integer", description: "integer", parameters: { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 } } }, execute: async (_id, args) => ({ content: [{ type: "text", text: String(args.count) }] }) });
			}
		`);
		const dispatcher = new ClaudeSdkExtensionDispatcher({
			cwd,
			env: {},
			manifest: [{ extensionPath, selectedToolNames: ["integer_probe"], allowedToolNames: ["integer_probe"] }],
		});
		try {
			await dispatcher.start();
			await expect(dispatcher.invoke("integer_probe", { count: 1.5 }, {})).rejects.toThrow("Bobbit tool execution failed");
			await expect(dispatcher.invoke("integer_probe", { count: 2 }, {})).resolves.toMatchObject({ content: [{ text: "2" }] });
		} finally {
			dispatcher.dispose();
		}
	});

	it("rejects pending calls when a worker exits cleanly", async () => {
		const { root, cwd } = workerFixture();
		const extensionPath = path.join(root, "exit-extension.ts");
		fs.writeFileSync(extensionPath, `
			export default function (pi) {
				pi.registerTool({ name: "exit_probe", label: "exit", description: "exit", parameters: { type: "object", properties: {} }, execute: async () => { process.exit(0); } });
			}
		`);
		const dispatcher = new ClaudeSdkExtensionDispatcher({
			cwd,
			env: {},
			manifest: [{ extensionPath, selectedToolNames: ["exit_probe"], allowedToolNames: ["exit_probe"] }],
		});
		try {
			await dispatcher.start();
			await expect(dispatcher.invoke("exit_probe", {}, {})).rejects.toThrow("Bobbit extension dispatcher exited");
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

	it("keeps lifecycle registration inert and omits conditionally absent extension tools", async () => {
		const { root, cwd } = workerFixture();
		const extensionPath = path.join(root, "conditional-extension.ts");
		fs.writeFileSync(extensionPath, `
			export default function (pi) {
				pi.on("session_shutdown", () => {});
				pi.registerCommand("unused", () => {});
				pi.registerTool({ name: "present_probe", label: "present", description: "present", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "present" }] }) });
			}
		`);
		const dispatcher = new ClaudeSdkExtensionDispatcher({
			cwd,
			env: {},
			manifest: [{
				extensionPath,
				selectedToolNames: ["present_probe", "conditional_probe"],
				allowedToolNames: ["present_probe", "conditional_probe"],
			}],
		});
		const entries = [
			{ name: "present_probe", group: "Probe", description: "present", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "present" },
			{ name: "conditional_probe", group: "Probe", description: "conditional", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "conditional" },
		];
		try {
			const surface = await buildClaudeSdkSurfaceAfterPreflight(
				dispatcher,
				entries,
				new Map([["present_probe", { type: "bobbit-extension" }], ["conditional_probe", { type: "bobbit-extension" }]]),
				() => buildClaudeSdkToolSurface({ sessionId: "conditional", restriction: "restricted", entries, requestToolGrant: async () => ({ granted: false }) }),
			);
			expect(entries.map(entry => entry.name)).toEqual(["present_probe"]);
			expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__present_probe"]);
			const missingCore = { start: vi.fn(async () => []), dispose: vi.fn() };
			await expect(buildClaudeSdkSurfaceAfterPreflight(
				missingCore,
				[{ name: "read", group: "Files", description: "read", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "read" }],
				new Map([["read", { type: "builtin" }]]),
				() => undefined,
			)).rejects.toThrow("did not provide a schema for read");
			expect(missingCore.dispose).toHaveBeenCalledOnce();
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
