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
type OfficialSessionMessage = {
	type: "user" | "assistant";
	uuid: string;
	session_id: string;
	message: { role?: string; content: unknown; timestamp: number };
	parent_tool_use_id: null;
	parent_agent_id: null;
};

/**
 * A deterministic implementation of the SDK Query and official session-store
 * surfaces. The history belongs to the fake SDK, not a query, so it survives
 * the production bridge replacement performed by gateway restart.
 */
class FakeOfficialQuery implements AsyncIterable<unknown> {
	readonly inputs: string[] = [];
	private readonly events: unknown[] = [];
	private readonly readers: Array<(value: IteratorResult<unknown>) => void> = [];
	private closed = false;

	constructor(readonly args: SdkQueryArgs, private readonly sdk: FakeOfficialSdk) {
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
				const assistant = this.sdk.appendFinalizedTurn(text);
				this.emit({
					type: "assistant",
					session_id: SDK_SESSION_ID,
					uuid: assistant.uuid,
					message: assistant.message,
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
	readonly history: OfficialSessionMessage[] = [];
	readonly sessionAccessCalls: Array<{ method: "info" | "messages"; sessionId: string; dir: string | undefined }> = [];
	preCompactRuns = 0;
	private turn = 0;

	appendFinalizedTurn(text: string): OfficialSessionMessage {
		const turn = ++this.turn;
		const timestamp = turn;
		this.history.push({
			type: "user",
			uuid: `sdk-user-${turn}`,
			session_id: SDK_SESSION_ID,
			message: { role: "user", content: text, timestamp },
			parent_tool_use_id: null,
			parent_agent_id: null,
		});
		const assistant: OfficialSessionMessage = {
			type: "assistant",
			uuid: `sdk-assistant-${turn}`,
			session_id: SDK_SESSION_ID,
			message: { role: "assistant", content: [{ type: "text", text: `SDK_TRANSLATED:${text}` }], timestamp },
			parent_tool_use_id: null,
			parent_agent_id: null,
		};
		this.history.push(assistant);
		return assistant;
	}

	async getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<{ sessionId: string; summary: string; lastModified: number } | undefined> {
		this.sessionAccessCalls.push({ method: "info", sessionId, dir: options?.dir });
		return sessionId === SDK_SESSION_ID ? { sessionId, summary: "deterministic fake", lastModified: this.history.length } : undefined;
	}

	async getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<OfficialSessionMessage[]> {
		this.sessionAccessCalls.push({ method: "messages", sessionId, dir: options?.dir });
		return sessionId === SDK_SESSION_ID ? this.history.map(message => ({ ...message, message: { ...message.message } })) : [];
	}

	async forkSession(): Promise<{ sessionId: string }> {
		throw new Error("Fake SDK fork is outside this restart journey");
	}

	async invokePreCompact(query: FakeOfficialQuery): Promise<void> {
		const hooks = (query.args.options.hooks as any)?.PreCompact?.[0]?.hooks;
		const hook = Array.isArray(hooks) ? hooks[0] : undefined;
		if (typeof hook !== "function") throw new Error("expected production SDK PreCompact hook");
		await hook({ custom_instructions: "deterministic compact" });
		this.preCompactRuns++;
	}

	readonly depsFactory = () => ({
		query: ((args: SdkQueryArgs) => {
			const query = new FakeOfficialQuery(args, this);
			this.queries.push(query);
			return query;
		}) as any,
		sessionAccess: { loadSdk: async () => this },
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
		const preferencesResponse = await apiFetch("/api/preferences");
		expect(preferencesResponse.status, await preferencesResponse.clone().text()).toBe(200);
		const originalPreferences = await preferencesResponse.json() as Record<string, unknown>;
		const providersResponse = await apiFetch("/api/custom-providers");
		expect(providersResponse.status, await providersResponse.clone().text()).toBe(200);
		const originalSdkProvider = (await providersResponse.json() as Array<Record<string, unknown>>)
			.find(provider => provider.id === "claude-agent-sdk");

		try {
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
				for (const text of ["SDK_BEFORE_RESTART_ONE", "SDK_BEFORE_RESTART_TWO"]) {
					const cursor = sdkConnection.messageCount();
					sdkConnection.send({ type: "prompt", text });
					await sdkConnection.waitForFrom(
						cursor,
						message => message.type === "event"
							&& message.data?.type === "message_end"
							&& message.data?.message?.role === "assistant"
							&& JSON.stringify(message.data.message.content).includes(`SDK_TRANSLATED:${text}`),
						15_000,
					);
					await sdkConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
				}
			} finally {
				sdkConnection.close();
			}
			expect(fakeSdk.queries[0].inputs).toEqual(["SDK_BEFORE_RESTART_ONE", "SDK_BEFORE_RESTART_TWO"]);
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

			// This is the normal SessionManager snapshot path. It must read finalized
			// SDK-owned rows, rather than a live Query's in-memory event stream.
			const beforeCompact = await gateway.sessionManager.getMessagesSnapshotBase(sdkLive!);
			expect(beforeCompact.success).toBe(true);
			expect(beforeCompact.data).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "sdk-user-1", role: "user" }),
				expect.objectContaining({ id: "sdk-assistant-1", role: "assistant" }),
				expect.objectContaining({ id: "sdk-user-2", role: "user" }),
				expect.objectContaining({ id: "sdk-assistant-2", role: "assistant" }),
			]));
			expect(fakeSdk.history.map(({ uuid, parent_tool_use_id, parent_agent_id }) => ({ uuid, parent_tool_use_id, parent_agent_id }))).toEqual([
				{ uuid: "sdk-user-1", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-assistant-1", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-user-2", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-assistant-2", parent_tool_use_id: null, parent_agent_id: null },
			]);
			expect(JSON.stringify(beforeCompact.data)).toContain("SDK_TRANSLATED:SDK_BEFORE_RESTART_TWO");
			expect(fakeSdk.sessionAccessCalls).toContainEqual({ method: "info", sessionId: SDK_SESSION_ID, dir: sdkLive!.cwd });
			expect(fakeSdk.sessionAccessCalls).toContainEqual({ method: "messages", sessionId: SDK_SESSION_ID, dir: sdkLive!.cwd });

			const historyBeforeCompact = structuredClone(fakeSdk.history);
			await fakeSdk.invokePreCompact(fakeSdk.queries[0]);
			expect(fakeSdk.preCompactRuns).toBe(1);
			expect(fakeSdk.history).toEqual(historyBeforeCompact);
			expect(gateway.sessionManager.getPersistedSession(sdkId)).toMatchObject({ claudeAgentSdkSessionId: SDK_SESSION_ID });
			const afterCompact = await gateway.sessionManager.getMessagesSnapshotBase(sdkLive!);
			expect(afterCompact).toEqual(beforeCompact);

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

			const restoredSdk = gateway.sessionManager.getSession(sdkId)!;
			const afterRestart = await gateway.sessionManager.getMessagesSnapshotBase(restoredSdk);
			expect(afterRestart).toEqual(beforeCompact);
			expect(JSON.stringify(afterRestart.data)).toContain("SDK_TRANSLATED:SDK_BEFORE_RESTART_ONE");

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
			const afterRestartPrompt = await gateway.sessionManager.getMessagesSnapshotBase(restoredSdk);
			expect(afterRestartPrompt.success).toBe(true);
			expect(JSON.stringify(afterRestartPrompt.data)).toContain("SDK_TRANSLATED:SDK_AFTER_RESTART");
			const messagesBeforeRestartPrompt = beforeCompact.data as Array<unknown>;
			const messagesAfterRestartPrompt = afterRestartPrompt.data as Array<unknown>;
			expect(messagesAfterRestartPrompt.slice(0, messagesBeforeRestartPrompt.length)).toEqual(messagesBeforeRestartPrompt);

			const resumedPiConnection = await connectWs(piId);
			try {
				const cursor = resumedPiConnection.messageCount();
				resumedPiConnection.send({ type: "prompt", text: "PI_AFTER_RESTART" });
				await resumedPiConnection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
			} finally {
				resumedPiConnection.close();
			}
		} finally {
			await apiFetch("/api/custom-providers/claude-agent-sdk", { method: "DELETE" }).catch(() => undefined);
			if (originalSdkProvider) {
				await apiFetch("/api/custom-providers", {
					method: "POST",
					body: JSON.stringify(originalSdkProvider),
				}).catch(() => undefined);
			}
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": originalPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": originalPreferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
		}
	});
});
