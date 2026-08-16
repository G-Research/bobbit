// v2-native — integration coverage for the three independent Claude SDK permission ceilings.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeAgentSdkQueryOptions, buildClaudeSdkToolSurface, sdkZodShape } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
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

function opaqueInput(): Record<string, unknown> {
	return Object.freeze(Object.create(null));
}

function canUse(surface: ReturnType<typeof fixture>["surface"], name: string, overrides: Record<string, unknown> = {}, input: Record<string, unknown> = opaqueInput()) {
	return (surface.canUseTool as any)(name, input, { signal: new AbortController().signal, toolUseID: "tool-use-1", ...overrides });
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

function sandboxDispatcherFixture({ ready = true }: { ready?: boolean } = {}) {
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
	const received: any[] = [];
	let input = "";
	child.stdin.on("data", (chunk: Buffer) => {
		input += chunk.toString();
		const lines = input.split("\n");
		input = lines.pop() ?? "";
		for (const line of lines) {
			const message = JSON.parse(line.slice("BOBBIT_SDK_DISPATCH:".length));
			received.push(message);
			if (ready && message.type === "init") child.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "ready", schemas: [{ name: "read", inputSchema: { type: "object" } }], omittedConditional: [] }) + "\n");
		}
	});
	const dispatcher = new ClaudeSdkExtensionDispatcher({
		cwd: "/host/must-not-run-tools",
		env: {},
		gatewayCredentials: { token: "scoped-token", url: "http://gateway.test" },
		manifest: [{ extensionPath: path.resolve("defaults/tools/_builtins/extension.ts"), selectedToolNames: ["read"], allowedToolNames: ["read"] }],
		sandbox: { containerId: "container-current", cwd: "/workspace-wt/current", builtinToolsDir: path.resolve("defaults/tools"), spawn: dockerSpawn as any, workerSource: "void 0" },
	});
	const emit = (message: unknown) => child.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify(message) + "\n");
	return { child, dispatcher, dockerSpawn, emit, received };
}

describe("Claude SDK Bobbit tool permission integration", () => {
	it("applies registration, canUseTool, and PreToolUse ceilings independently", async () => {
		const { surface } = fixture();
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		const options = buildClaudeAgentSdkQueryOptions(surface, {
			cwd: "/workspace", env: {}, abortController: new AbortController(),
		} as any) as any;
		// Agent is a required SDK programmatic-agent allow entry. The independent
		// PreToolUse policy remains authoritative when the bare allow skips canUseTool.
		expect(options.allowedTools).toEqual(["Agent", "mcp__bobbit__read"]);
		expect((await options.hooks.PreToolUse[0].hooks[0]({
			tool_name: "Agent", tool_use_id: "unadmitted-agent", tool_input: {},
		})).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(surface.entriesByCanonicalLower.has("bash")).toBe(true);
		for (const name of ["mcp__bobbit__bash", "Bash", "mcp__foreign__read", "mcp__bobbit__", "mcp__bobbit__missing"]) {
			await expect(canUse(surface, name)).resolves.toMatchObject({ behavior: "deny" });
			expect((await preUse(surface, name)).hookSpecificOutput.permissionDecision).toBe("deny");
		}
		const input = opaqueInput();
		const allowed = await canUse(surface, "mcp__bobbit__read", {}, input);
		expect(allowed).toMatchObject({ behavior: "allow" });
		expect(allowed.updatedInput).toBe(input);
		expect((await preUse(surface, "mcp__bobbit__read")).hookSpecificOutput.permissionDecision).toBe("allow");
	});

	it("requires a current exact grant and never caches one-time approval", async () => {
		let calls = 0;
		const { surface } = fixture(async () => { calls++; return { granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }; });
		const firstInput = opaqueInput();
		const first = await canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "one" }, firstInput);
		expect(first).toMatchObject({ behavior: "allow" });
		expect(first.updatedInput).toBe(firstInput);
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "one")).toEqual({ continue: true });
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "two" })).resolves.toMatchObject({ behavior: "allow" });
		expect(calls).toBe(2);
		// Root ask hooks are neutral, so canUseTool alone owns every current grant.
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "bypass")).toEqual({ continue: true });
	});

	it("keeps root ask hooks neutral without replay state and denies subagent hook calls", async () => {
		const { surface } = fixture(async () => ({ granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }));
		await canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "shared" });
		// A prior callback grant cannot alter either root ask hook.
		expect(await preUse(surface, "mcp__bobbit__ask_other", "shared")).toEqual({ continue: true });
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "shared")).toEqual({ continue: true });
		expect((await (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: "mcp__bobbit__read", tool_use_id: "native", agent_id: "child" })).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("passes cancellation to the grant seam and denies the abandoned request", async () => {
		let captured: AbortSignal | undefined;
		const { surface } = fixture(async (_name, _group, options?: { signal: AbortSignal }) => {
			captured = options?.signal;
			return new Promise(resolve => options?.signal.addEventListener("abort", () => resolve({ granted: false, reason: "cancelled" }), { once: true }));
		});
		const controller = new AbortController();
		const pending = (surface.canUseTool as any)("mcp__bobbit__ask_user_choices", opaqueInput(), { signal: controller.signal, toolUseID: "cancelled" });
		controller.abort();
		const denied = await pending;
		expect(denied).toMatchObject({ behavior: "deny" });
		expect(denied).not.toHaveProperty("updatedInput");
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

	it("frames sandbox dispatcher stdout once across split, large, and UTF-8 result chunks", async () => {
		const { child, dispatcher, dockerSpawn, emit, received } = sandboxDispatcherFixture();
		const nextInvocation = async () => {
			const pending = dispatcher.invoke("read", {}, {});
			await vi.waitFor(() => expect(received.at(-1)?.type).toBe("invoke"));
			return { pending, id: received.at(-1)!.id as number };
		};
		try {
			await expect(dispatcher.start()).resolves.toEqual([{ name: "read", inputSchema: { type: "object" } }]);
			expect(child.stdout.listenerCount("data")).toBe(1);

			const split = await nextInvocation();
			const splitFrame = "BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "result", id: split.id, result: "split-result" }) + "\n";
			const splitAt = splitFrame.indexOf("result") + 3;
			child.stdout.write(splitFrame.slice(0, splitAt));
			child.stdout.write(splitFrame.slice(splitAt));
			await expect(split.pending).resolves.toBe("split-result");

			const large = await nextInvocation();
			const largeResult = "x".repeat(65 * 1024);
			emit({ type: "result", id: large.id, result: largeResult });
			await expect(large.pending).resolves.toBe(largeResult);

			const utf8 = await nextInvocation();
			const utf8Result = "split emoji: 🙂";
			const utf8Frame = Buffer.from("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "result", id: utf8.id, result: utf8Result }) + "\n");
			const emojiOffset = utf8Frame.indexOf(Buffer.from("🙂")) + 2;
			child.stdout.write(utf8Frame.subarray(0, emojiOffset));
			child.stdout.write(utf8Frame.subarray(emojiOffset));
			await expect(utf8.pending).resolves.toBe(utf8Result);
			expect(dockerSpawn).toHaveBeenCalledOnce();
		} finally {
			dispatcher.dispose();
		}
	});

	it("maps worker failures to fixed aggregate categories without reflecting worker text", async () => {
		const { dispatcher, emit, received } = sandboxDispatcherFixture();
		const invokeFailure = async (error: unknown) => {
			const pending = dispatcher.invoke("read", {}, {});
			await vi.waitFor(() => expect(received.at(-1)?.type).toBe("invoke"));
			emit({ type: "result", id: received.at(-1)!.id, error });
			await expect(pending).rejects.toThrow("Bobbit tool execution failed");
		};
		try {
			await dispatcher.start();
			await invokeFailure("unavailable");
			await invokeFailure("invalid-arguments");
			await invokeFailure("failed");
			await invokeFailure("provider body /private/path token=private-token");
			expect(dispatcher.getToolFailureCounts()).toEqual({ unavailable: 1, "invalid-arguments": 1, "handler-failed": 2 });
			const serialized = JSON.stringify(dispatcher.getToolFailureCounts());
			for (const privateValue of ["/private/path", "private-token", "provider body"]) expect(serialized).not.toContain(privateValue);
		} finally {
			dispatcher.dispose();
		}
	});

	it("absorbs early sandbox dispatcher stdin closure and drains its stderr", async () => {
		const { child, dispatcher } = sandboxDispatcherFixture({ ready: false });
		const starting = dispatcher.start();
		try {
			expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
			child.stdin.destroy();
			expect(() => child.stdin.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }))).not.toThrow();
			expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
			child.stderr.write(Buffer.alloc(65 * 1024, "x"));
			expect(child.stderr.readableLength).toBe(0);
			expect(child.stdout.listenerCount("data")).toBe(1);
			child.emit("exit", 1, null);
			await expect(starting).rejects.toThrow("Bobbit extension dispatcher failed to start");
			expect(child.stdout.listenerCount("data")).toBe(0);
			expect(child.listenerCount("error")).toBe(0);
			expect(child.listenerCount("exit")).toBe(0);
			expect(child.kill).toHaveBeenCalledTimes(1);
			child.emit("exit", 1, null);
			expect(child.kill).toHaveBeenCalledTimes(1);
		} finally {
			dispatcher.dispose();
		}
	});

	it("fails closed and settles pending sandbox calls for malformed and oversized frames", async () => {
		const malformed = sandboxDispatcherFixture();
		try {
			await malformed.dispatcher.start();
			const pending = malformed.dispatcher.invoke("read", {}, {});
			await vi.waitFor(() => expect(malformed.received.at(-1)?.type).toBe("invoke"));
			malformed.child.stdout.write("BOBBIT_SDK_DISPATCH:{not-json}\n");
			await expect(pending).rejects.toThrow("protocol error");
			expect(malformed.child.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			malformed.dispatcher.dispose();
		}

		const oversized = sandboxDispatcherFixture();
		try {
			await oversized.dispatcher.start();
			const pending = oversized.dispatcher.invoke("read", {}, {});
			await vi.waitFor(() => expect(oversized.received.at(-1)?.type).toBe("invoke"));
			oversized.child.stdout.write("BOBBIT_SDK_DISPATCH:" + "x".repeat(5 * 1024 * 1024));
			await expect(pending).rejects.toThrow("protocol error");
			expect(oversized.child.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			oversized.dispatcher.dispose();
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
