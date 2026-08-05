/** Gateway-restart acceptance coverage through the production SDK bridge. */
import { expect, test } from "./gateway-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	harnessDefaultProjectRoot,
	nonGitCwd,
	waitForSessionStatus,
} from "./e2e-setup.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SDK_MODEL = "claude-agent-sdk/sonnet-test";
const SDK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

type SdkQueryArgs = { prompt: AsyncIterable<any>; options: Record<string, unknown> };

/**
 * A deterministic implementation of only the official SDK Query surface. The
 * gateway still constructs ClaudeAgentSdkBridge and receives its translated
 * events through the normal SessionManager listener path.
 */
class FakeOfficialQuery implements AsyncIterable<unknown> {
	readonly inputs: string[] = [];
	private readonly events: unknown[] = [];
	private readonly readers: Array<(value: IteratorResult<unknown>) => void> = [];
	private closed = false;

	constructor(readonly args: SdkQueryArgs, private readonly number: number) {
		void this.consumePrompts();
	}

	async initializationResult(): Promise<{ session_id: string }> {
		return { session_id: SDK_SESSION_ID };
	}

	private async consumePrompts(): Promise<void> {
		try {
			for await (const input of this.args.prompt) {
				const content = (input as any)?.message?.content;
				const text = typeof content === "string"
					? content
					: Array.isArray(content)
						? content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n")
						: "";
				this.inputs.push(text);
				this.emit({
					type: "assistant",
					session_id: SDK_SESSION_ID,
					uuid: `sdk-${this.number}-${this.inputs.length}`,
					message: { content: [{ type: "text", text: `SDK_TRANSLATED:${text}` }] },
				});
				this.emit({ type: "result", session_id: SDK_SESSION_ID, subtype: "success" });
			}
		} catch {
			// Bridge shutdown closes the prompt iterable; it is not an SDK failure.
		}
	}

	private emit(event: unknown): void {
		const reader = this.readers.shift();
		if (reader) reader({ done: false, value: event });
		else this.events.push(event);
	}

	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				const event = this.events.shift();
				if (event !== undefined) return Promise.resolve({ done: false, value: event });
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.readers.push(resolve));
			},
		};
	}
}

class FakeOfficialSdk {
	readonly queries: FakeOfficialQuery[] = [];
	readonly depsFactory = () => ({
		query: ((args: SdkQueryArgs) => {
			const query = new FakeOfficialQuery(args, this.queries.length + 1);
			this.queries.push(query);
			return query;
		}) as any,
		clock: {
			now: () => Date.now(),
			setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
			clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
			setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
			clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
		},
	});
}

const fakeSdk = new FakeOfficialSdk();
test.use({ claudeAgentSdkBridgeDepsFactory: { create: fakeSdk.depsFactory } });
test.describe.serial("Claude Agent SDK session restart", () => {
	test.setTimeout(60_000);

	test("persists runtime and opaque SDK id, resumes through the production bridge, and leaves Pi unchanged", async ({ gateway }) => {
		const provider = await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify({
				id: "claude-agent-sdk",
				name: "claude-agent-sdk",
				type: "manual",
				baseUrl: "http://127.0.0.1:9",
				models: [{ id: "sonnet-test", name: "Deterministic Claude SDK" }],
			}),
		});
		expect(provider.status, await provider.text()).toBe(200);

		const sdkDefault = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "default.sessionModel": SDK_MODEL, "default.sessionThinkingLevel": "off" }),
		});
		expect(sdkDefault.status, await sdkDefault.text()).toBe(200);
		const sdkCreate = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), worktree: false }),
		});
		expect(sdkCreate.status, await sdkCreate.clone().text()).toBe(201);
		const sdkId = (await sdkCreate.json()).id as string;
		await waitForSessionStatus(sdkId, "idle");
		const sdkLive = gateway.sessionManager.getSession(sdkId);
		expect(sdkLive?.runtime, JSON.stringify({ runtime: sdkLive?.runtime, model: sdkLive?.spawnPinnedModel })).toBe("claude-agent-sdk");
		expect(fakeSdk.queries, "SDK selection must construct the production bridge Query").toHaveLength(1);

		const piDefault = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "default.sessionModel": "mock/mock-model", "default.sessionThinkingLevel": "off" }),
		});
		expect(piDefault.status, await piDefault.text()).toBe(200);
		const piId = await createSession({ cwd: nonGitCwd() });
		await waitForSessionStatus(piId, "idle");

		const sdkConnection = await connectWs(sdkId);
		try {
			const cursor = sdkConnection.messageCount();
			sdkConnection.send({ type: "prompt", text: "SDK_BEFORE_RESTART" });
			await sdkConnection.waitForFrom(
				cursor,
				message => message.type === "event"
					&& message.data?.type === "message_end"
					&& message.data?.message?.role === "assistant"
					&& JSON.stringify(message.data.message.content).includes("SDK_TRANSLATED:SDK_BEFORE_RESTART"),
				15_000,
			);
			await sdkConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
		} finally {
			sdkConnection.close();
		}
		await waitForSessionStatus(sdkId, "idle");

		const piConnection = await connectWs(piId);
		try {
			const cursor = piConnection.messageCount();
			piConnection.send({ type: "prompt", text: "PI_BEFORE_RESTART" });
			await piConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
		} finally {
			piConnection.close();
		}
		await waitForSessionStatus(piId, "idle");

		const persisted = gateway.sessionManager.getPersistedSession(sdkId);
		expect(persisted).toMatchObject({ runtime: "claude-agent-sdk", claudeAgentSdkSessionId: SDK_SESSION_ID });
		await gateway.sessionManager.getSessionStore(persisted.projectId).flushAsync();
		const onDisk = JSON.parse(readFileSync(join(harnessDefaultProjectRoot(), ".bobbit", "state", "sessions.json"), "utf8"));
		const onDiskSession = (Array.isArray(onDisk) ? onDisk : onDisk.sessions).find((session: any) => session.id === sdkId);
		expect(onDiskSession).toMatchObject({ runtime: "claude-agent-sdk", claudeAgentSdkSessionId: SDK_SESSION_ID });

		const piCommandsBeforeRestart = gateway.piCommandLog.length;
		await gateway.crash();
		await gateway.restart();
		await waitForSessionStatus(sdkId, "idle", 30_000);
		await waitForSessionStatus(piId, "idle", 30_000);

		expect(fakeSdk.queries).toHaveLength(2);
		expect(fakeSdk.queries[1].args.options.resume).toBe(SDK_SESSION_ID);
		expect(gateway.sessionManager.getSession(sdkId)?.runtime).toBe("claude-agent-sdk");
		expect(gateway.sessionManager.getSession(piId)?.runtime).toBe("pi");

		const restartPiCommands = gateway.piCommandLog.slice(piCommandsBeforeRestart);
		expect(restartPiCommands.filter(row => row.sessionId === sdkId)).toEqual([]);
		expect(restartPiCommands.some(row => row.sessionId === piId && (row.command as any)?.type === "switch_session")).toBe(true);

		const resumedSdkConnection = await connectWs(sdkId);
		try {
			const cursor = resumedSdkConnection.messageCount();
			resumedSdkConnection.send({ type: "prompt", text: "SDK_AFTER_RESTART" });
			await resumedSdkConnection.waitForFrom(
				cursor,
				message => message.type === "event"
					&& message.data?.type === "message_end"
					&& message.data?.message?.role === "assistant"
					&& JSON.stringify(message.data.message.content).includes("SDK_TRANSLATED:SDK_AFTER_RESTART"),
				15_000,
			);
			await resumedSdkConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
		} finally {
			resumedSdkConnection.close();
		}
		expect(fakeSdk.queries[1].inputs).toContain("SDK_AFTER_RESTART");

		const resumedPiConnection = await connectWs(piId);
		try {
			const cursor = resumedPiConnection.messageCount();
			resumedPiConnection.send({ type: "prompt", text: "PI_AFTER_RESTART" });
			await resumedPiConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
		} finally {
			resumedPiConnection.close();
		}
	});
});
