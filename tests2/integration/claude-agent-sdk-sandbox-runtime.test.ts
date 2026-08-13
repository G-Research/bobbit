// v2-native — sandbox SDK runtime composition using only deterministic SDK/Docker seams.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeAgentSdkBridge, type ClaudeAgentSdkBridgeDeps } from "../../src/server/agent/claude-agent-sdk-bridge.ts";
import { createSandboxClaudeAgentSdkSessionAccess } from "../../src/server/agent/claude-agent-sdk-session-access.ts";

const dockerSpawn = vi.fn<NonNullable<ClaudeAgentSdkBridgeDeps["createDockerSpawn"]>>();
type DockerSpawnOptions = Parameters<ReturnType<NonNullable<ClaudeAgentSdkBridgeDeps["createDockerSpawn"]>>>[0];
const dockerLaunches: Array<{
	input: Parameters<NonNullable<ClaudeAgentSdkBridgeDeps["createDockerSpawn"]>>[0];
	options: DockerSpawnOptions;
	child: FakeChild;
}> = [];

const SDK_ID = "00000000-0000-4000-8000-000000000009";
const OAUTH = "subscription-oauth-must-never-leak";

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill = vi.fn((signal?: NodeJS.Signals | number) => {
		this.killed = true;
		this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
		return true;
	});
}

class FakeQuery implements AsyncIterable<unknown> {
	readonly inputs: any[] = [];
	readonly models: string[] = [];
	readonly budgets: Array<number | null> = [];
	readonly efforts: unknown[] = [];
	interrupts = 0;
	closes = 0;
	private readonly events: unknown[] = [];
	private readonly eventWaiters: Array<(result: IteratorResult<unknown>) => void> = [];
	private closed = false;

	constructor(readonly prompt: AsyncIterable<unknown>, readonly options: any) {
		void this.collectInputs();
	}
	async initializationResult() {
		return {
			session_id: SDK_ID,
			models: [{ value: "sandbox-sonnet", supportsEffort: true, supportedEffortLevels: ["high"] }],
		};
	}
	async collectInputs() {
		for await (const input of this.prompt) this.inputs.push(input);
	}
	async setModel(model: string) { this.models.push(model); }
	async setMaxThinkingTokens(value: number | null) { this.budgets.push(value); }
	async applyFlagSettings(value: unknown) { this.efforts.push(value); }
	async interrupt() { this.interrupts++; }
	async close() {
		this.closes++;
		this.closed = true;
		for (const waiter of this.eventWaiters.splice(0)) waiter({ done: true, value: undefined });
	}
	emitSdk(event: unknown) {
		const waiter = this.eventWaiters.shift();
		if (waiter) waiter({ done: false, value: event });
		else this.events.push(event);
	}
	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				const event = this.events.shift();
				if (event !== undefined) return Promise.resolve({ done: false, value: event });
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.eventWaiters.push(resolve));
			},
		};
	}
}

async function flush(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

function launch(sessionId: string, containerId: string, cwd: string) {
	return {
		containerId,
		cwd,
		sessionId,
		sessionSecret: "session-authority",
		goalId: "goal-authority",
		gatewayToken: "scoped-gateway-authority",
		gatewayUrl: "http://gateway.test",
		oauthAccessToken: OAUTH,
	};
}

function bridgeFixture(input: { sessionId: string; containerId: string; cwd: string; resume?: string }) {
	let query!: FakeQuery;
	let queryCalls = 0;
	const bridge = new ClaudeAgentSdkBridge({
		runtime: "claude-agent-sdk",
		sandboxed: true,
		cwd: input.cwd,
		initialModel: "claude-agent-sdk/sandbox-sonnet",
		initialThinkingLevel: "high",
		env: { ANTHROPIC_API_KEY: "host-key-must-not-leak", BOBBIT_TOKEN: "host-token-must-not-leak" },
		claudeSdkSandboxLaunch: launch(input.sessionId, input.containerId, input.cwd),
		...(input.resume ? { claudeAgentSdkSessionId: input.resume } : {}),
	}, {
		query: ((request: any) => {
			queryCalls++;
			const spawned = request.options.spawnClaudeCodeProcess({
				args: ["--sdk-protocol", "opaque-sdk-argument"],
				env: { CLAUDE_AGENT_SDK_VERSION: "0.3.222", EVIL_HOST_ENV: "must-not-pass" },
				signal: new AbortController().signal,
			});
			expect(spawned.stdin).toBeDefined();
			query = new FakeQuery(request.prompt, request.options);
			return query;
		}) as never,
		clock: { now: () => 0, setTimeout, setInterval, clearTimeout, clearInterval },
		createDockerSpawn: dockerSpawn,
	});
	return { bridge, get query() { return query; }, get queryCalls() { return queryCalls; } };
}

afterEach(() => {
	dockerSpawn.mockReset();
	dockerLaunches.splice(0);
});

describe("Claude Agent SDK sandbox runtime", () => {
	it("runs fresh and worktree SDK queries in their current pooled containers with isolated state", async () => {
		const children: FakeChild[] = [];
		dockerSpawn.mockImplementation((input) => (options) => {
			const child = new FakeChild();
			children.push(child);
			dockerLaunches.push({ input, options, child });
			return child as never;
		});
		const fresh = bridgeFixture({ sessionId: "fresh-session", containerId: "container-fresh", cwd: "/workspace" });
		const worktree = bridgeFixture({ sessionId: "worktree-session", containerId: "container-worktree", cwd: "/workspace-wt/goal-branch" });

		await Promise.all([fresh.bridge.start(), worktree.bridge.start()]);
		expect(fresh.queryCalls).toBe(1);
		expect(worktree.queryCalls).toBe(1);
		expect(children).toHaveLength(2);

		const [first, second] = dockerLaunches;
		expect(first.input).toMatchObject({
			containerId: "container-fresh",
			cwd: "/workspace",
			command: ["/usr/local/bin/bobbit-claude-agent-sdk"],
		});
		expect(second.input).toMatchObject({ containerId: "container-worktree", cwd: "/workspace-wt/goal-branch" });
		expect(first.options.args).toEqual(["--sdk-protocol", "opaque-sdk-argument"]);
		expect(first.input.env).toMatchObject({
			HOME: "/home/bobbit-sdk",
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			TMPDIR: "/tmp",
			LANG: "C.UTF-8",
			CLAUDE_CONFIG_DIR: "/bobbit-state/claude-agent-sdk/fresh-session",
			CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
			CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
		});
		expect(second.input.env.CLAUDE_CONFIG_DIR).toBe("/bobbit-state/claude-agent-sdk/worktree-session");
		expect(first.input.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
		for (const launch of [first, second]) {
			const serializedInput = JSON.stringify(launch.input);
			expect(serializedInput).not.toContain("ANTHROPIC_API_KEY");
			expect(serializedInput).not.toContain("host-key-must-not-leak");
			expect(serializedInput).not.toContain("EVIL_HOST_ENV");
			expect(launch.options.args).not.toContain("switch_session");
		}
		expect(fresh.query.options.env).toMatchObject({ HOME: "/home/bobbit-sdk", BOBBIT_SESSION_ID: "fresh-session" });
		expect(fresh.query.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		await Promise.all([fresh.bridge.stop(), worktree.bridge.stop()]);
	});

	it("preserves SDK prompt, steer, interruption, model, thinking, tool, and permission behavior inside Docker", async () => {
		dockerSpawn.mockImplementation((input) => (options) => {
			const child = new FakeChild();
			dockerLaunches.push({ input, options, child });
			return child as never;
		});
		const fixture = bridgeFixture({ sessionId: "interactive", containerId: "container-live", cwd: "/workspace" });
		const events: any[] = [];
		fixture.bridge.onEvent(event => events.push(event));
		await fixture.bridge.start();

		await fixture.bridge.prompt("first prompt");
		await fixture.bridge.steer("redirect now");
		await flush();
		expect(fixture.query.inputs.map(input => [input.message.content, input.priority])).toEqual([
			["first prompt", undefined], ["redirect now", "now"],
		]);
		await fixture.bridge.abort();
		expect(fixture.query.interrupts).toBe(1);
		await fixture.bridge.setModel("claude-agent-sdk", "sandbox-sonnet");
		await fixture.bridge.setThinkingLevel("high");
		expect(fixture.query.models).toEqual(["sandbox-sonnet"]);
		expect(fixture.query.efforts).toEqual([{ effortLevel: "high" }]);
		expect(await fixture.query.options.canUseTool("Bash", {}, { signal: new AbortController().signal })).toMatchObject({ behavior: "deny" });

		fixture.query.emitSdk({ type: "assistant", uuid: "tool-message", message: { content: [
			{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "note" } },
			{ type: "tool_use", id: "permission-1", name: "Bash", input: { command: "false" } },
		], stop_reason: "tool_use" } });
		fixture.query.emitSdk({ type: "system", subtype: "permission_denied", uuid: "permission-message", tool_name: "Bash", tool_use_id: "permission-1", message: "Permission denied" });
		fixture.query.emitSdk({ type: "result", subtype: "success" });
		await flush();
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "Read" }),
			expect.objectContaining({ type: "tool_execution_end", toolCallId: "permission-1", toolName: "Bash", isError: true }),
			expect.objectContaining({ type: "agent_end" }),
		]));
		await fixture.bridge.stop();
		expect(fixture.query.closes).toBe(1);
	});

	it("reads SDK history in the pooled container with a read-only closed environment", async () => {
		const executions: string[][] = [];
		const access = createSandboxClaudeAgentSdkSessionAccess({
			containerId: "container-history",
			cwd: "/workspace-wt/history",
			bobbitSessionId: "history-session",
			exec: async (args) => {
				executions.push(args);
				return args.includes("info")
					? JSON.stringify({ sessionId: SDK_ID, summary: "SDK owned", lastModified: 1 })
					: JSON.stringify([{ type: "user", uuid: "message-1", session_id: SDK_ID, message: { role: "user", content: "container transcript" }, parent_tool_use_id: null, parent_agent_id: null }]);
			},
		});
		await expect(access.getSessionInfo(SDK_ID)).resolves.toMatchObject({ summary: "SDK owned" });
		await expect(access.getSessionMessages(SDK_ID)).resolves.toHaveLength(1);
		expect(executions).toHaveLength(2);
		for (const args of executions) {
			expect(args).toEqual(expect.arrayContaining(["exec", "-i", "-u", "bobbit-sdk", "-w", "/workspace-wt/history", "container-history", "node", "--input-type=module"]));
			expect(args.join(" ")).toContain("CLAUDE_CONFIG_DIR=/bobbit-state/claude-agent-sdk/history-session");
			expect(args.join(" ")).not.toMatch(/OAUTH|BOBBIT_TOKEN|ANTHROPIC_API_KEY/);
		}
	});

	it("prepares migrated private state once before dormant SDK history access", async () => {
		let preparations = 0;
		const access = createSandboxClaudeAgentSdkSessionAccess({
			containerId: "container-legacy-history",
			cwd: "/workspace",
			bobbitSessionId: "legacy-history",
			prepare: async () => { preparations++; },
			exec: async (args) => args.includes("info")
				? JSON.stringify({ sessionId: SDK_ID, summary: "legacy", lastModified: 1 })
				: JSON.stringify([]),
		});
		await expect(access.getSessionInfo(SDK_ID)).resolves.toMatchObject({ summary: "legacy" });
		await expect(access.getSessionMessages(SDK_ID)).resolves.toEqual([]);
		expect(preparations).toBe(1);
	});

	it("pages container history under explicit bounds so ordinary multi-megabyte histories remain readable", async () => {
		const offsets: number[] = [];
		const access = createSandboxClaudeAgentSdkSessionAccess({
			containerId: "container-history-pages",
			cwd: "/workspace",
			bobbitSessionId: "history-pages",
			exec: async (args) => {
				const operation = args.at(-6);
				if (operation === "info") return JSON.stringify({ sessionId: SDK_ID, summary: "SDK owned", lastModified: 1 });
				const offset = Number(args.at(-2));
				offsets.push(offset);
				const makeMessage = (index: number) => ({ type: "assistant", uuid: `message-${index}`, session_id: SDK_ID, message: { content: "x".repeat(15_000) }, parent_tool_use_id: null, parent_agent_id: null });
				return JSON.stringify(offset === 0 ? Array.from({ length: 100 }, (_, index) => makeMessage(index)) : [makeMessage(100)]);
			},
		});
		const messages = await access.getSessionMessages(SDK_ID);
		expect(messages).toHaveLength(101);
		expect(offsets).toEqual([0, 100]);
	});

	it("rebuilds launch authority for replacement and rejects missing image or OAuth before querying", async () => {
		dockerSpawn.mockImplementation((input) => (options) => {
			const child = new FakeChild();
			dockerLaunches.push({ input, options, child });
			return child as never;
		});
		const original = bridgeFixture({ sessionId: "replace", containerId: "container-old", cwd: "/workspace" });
		await original.bridge.start();
		await original.bridge.stop();
		const recovered = bridgeFixture({ sessionId: "replace", containerId: "container-new", cwd: "/workspace", resume: SDK_ID });
		await recovered.bridge.start();
		expect(recovered.query.options.resume).toBe(SDK_ID);
		expect(dockerLaunches[1].input.containerId).toBe("container-new");
		await recovered.bridge.stop();

		let queryCalls = 0;
		for (const badLaunch of [
			{ ...launch("bad-image", "", "/workspace") },
			{ ...launch("bad-auth", "container", "/workspace"), oauthAccessToken: "" },
		]) {
			const bridge = new ClaudeAgentSdkBridge({ runtime: "claude-agent-sdk", sandboxed: true, cwd: "/workspace", claudeSdkSandboxLaunch: badLaunch }, {
				query: (() => { queryCalls++; throw new Error("host SDK must not start"); }) as never,
				clock: { now: () => 0, setTimeout, setInterval, clearTimeout, clearInterval },
			});
			await expect(bridge.start()).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: expect.not.stringContaining(OAUTH) });
		}
		expect(queryCalls).toBe(0);
	});
});
