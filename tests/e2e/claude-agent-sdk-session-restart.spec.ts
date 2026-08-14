/** Gateway-restart acceptance coverage through the production SDK bridge. */
import { expect, test } from "./gateway-harness.js";
import {
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	harnessDefaultProjectRoot,
	nonGitCwd,
	waitForSessionStatus,
} from "./e2e-setup.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SDK_MODEL = "claude-agent-sdk/sonnet-test";
const SDK_UNAVAILABLE_MODEL = "claude-agent-sdk/unavailable-test";
const SDK_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FIDELITY_GATE_ID = "sdk-fidelity-proof";

type SdkQueryArgs = { prompt: AsyncIterable<any>; options: Record<string, unknown> };
type OfficialSessionMessage = {
	type: "user" | "assistant";
	uuid: string;
	session_id: string;
	message: { role?: string; model?: string; usage?: Record<string, number>; content: unknown; timestamp: number };
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
		this.emitSdkEvent({ type: "system", subtype: "init", session_id: SDK_SESSION_ID });
		void this.consumePrompts();
	}

	async initializationResult(): Promise<Record<string, never>> {
		if (this.sdk.unavailableModels.has(String(this.args.options.model))) {
			throw new Error("DETERMINISTIC_SDK_PROVIDER_UNAVAILABLE");
		}
		return {};
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
				const { assistant, result } = this.sdk.appendFinalizedTurn(text);
				this.emitSdkEvent({
					type: "assistant",
					session_id: SDK_SESSION_ID,
					uuid: assistant.uuid,
					message: assistant.message,
				});
				this.emitSdkEvent(result);
			}
		} catch {
			// Bridge shutdown closes the prompt iterable; it is not an SDK failure.
		}
	}

	emitSdkEvent(event: unknown): void {
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

	appendFinalizedTurn(text: string): { assistant: OfficialSessionMessage; result: Record<string, unknown> } {
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
		// The official SDK owns this raw audit trail. Its history adapter must
		// preserve the tool call/result while canonicalizing the Bobbit MCP name.
		if (turn === 1) {
			this.history.push({
				type: "assistant",
				uuid: "sdk-read-call-1",
				session_id: SDK_SESSION_ID,
				message: { role: "assistant", content: [{ type: "tool_use", id: "sdk-read-tool-1", name: "mcp__bobbit__read", input: { path: "README.md" } }], timestamp },
				parent_tool_use_id: null,
				parent_agent_id: null,
			});
			this.history.push({
				type: "user",
				uuid: "sdk-read-result-1",
				session_id: SDK_SESSION_ID,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sdk-read-tool-1", content: "DETERMINISTIC_BOBBIT_READ" }], timestamp },
				parent_tool_use_id: null,
				parent_agent_id: null,
			});
		}
		const assistant: OfficialSessionMessage = {
			type: "assistant",
			uuid: `sdk-assistant-${turn}`,
			session_id: SDK_SESSION_ID,
			// Unlike result.modelUsage, this is the completed request's raw occupancy.
			message: {
				role: "assistant", model: "sonnet-test",
				usage: { input_tokens: turn * 100, output_tokens: turn * 4, cache_read_input_tokens: turn * 20, cache_creation_input_tokens: turn * 3 },
				content: [{ type: "text", text: `SDK_TRANSLATED:${text}` }], timestamp,
			},
			parent_tool_use_id: null,
			parent_agent_id: null,
		};
		this.history.push(assistant);
		return {
			assistant,
			result: {
				type: "result", session_id: SDK_SESSION_ID, uuid: `sdk-result-${turn}`, subtype: "success",
				usage: { input_tokens: turn * 10, output_tokens: turn * 4, cache_read_input_tokens: turn * 2, cache_creation_input_tokens: turn },
				total_cost_usd: turn / 1_000,
				modelUsage: {
					"sonnet-test": {
						inputTokens: turn * 10, outputTokens: turn * 4, cacheReadInputTokens: turn * 2, cacheCreationInputTokens: turn,
						costUSD: turn / 1_000, contextWindow: 200_000, maxOutputTokens: 8_192,
					},
				},
			},
		};
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

	readonly unavailableModels = new Set<string>();

	replayRootResult(query: FakeOfficialQuery, turn: number): void {
		query.emitSdkEvent({
			type: "result", session_id: SDK_SESSION_ID, uuid: `sdk-result-${turn}`, subtype: "success",
			usage: { input_tokens: turn * 10, output_tokens: turn * 4, cache_read_input_tokens: turn * 2, cache_creation_input_tokens: turn },
			total_cost_usd: turn / 1_000,
			modelUsage: { "sonnet-test": { inputTokens: turn * 10, outputTokens: turn * 4, cacheReadInputTokens: turn * 2, cacheCreationInputTokens: turn, costUSD: turn / 1_000, contextWindow: 200_000, maxOutputTokens: 8_192 } },
		});
	}

	async invokePreCompact(query: FakeOfficialQuery): Promise<void> {
		const hooks = (query.args.options.hooks as any)?.PreCompact?.[0]?.hooks;
		const hook = Array.isArray(hooks) ? hooks[0] : undefined;
		if (typeof hook !== "function") throw new Error("expected production SDK PreCompact hook");
		await hook({ trigger: "auto", custom_instructions: "deterministic compact" });
		this.preCompactRuns++;
	}

	completeCompaction(): void {
		// The fake SDK, like the real provider, retains only its compacted tail.
		this.history.splice(0, this.history.length, ...this.history.filter(message =>
			message.uuid === "sdk-user-2" || message.uuid === "sdk-assistant-2",
		));
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

async function sessionTranscript(connection: Awaited<ReturnType<typeof connectWs>>): Promise<unknown[]> {
	const cursor = connection.messageCount();
	connection.send({ type: "get_messages" });
	const frame = await connection.waitForFrom(cursor, message => message.type === "messages", 15_000);
	return Array.isArray(frame.data) ? frame.data : (frame.data as any)?.messages ?? [];
}

function fidelityWorkflowId(): string {
	return `sdk-fidelity-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createFidelityWorkflow(projectId: string, id: string): Promise<void> {
	const response = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id,
			name: "SDK Fidelity Demonstration",
			gates: [{
				id: FIDELITY_GATE_ID,
				name: "SDK Fidelity Proof",
				depends_on: [],
				verify: [{ name: "Deterministic parent verification", type: "command", run: "echo sdk-fidelity-ok" }],
			}],
		}),
	});
	expect(response.status, await response.text()).toBe(201);
}

async function waitForGatePass(goalId: string): Promise<void> {
	await expect.poll(async () => {
		const response = await apiFetch(`/api/goals/${goalId}/gates/${FIDELITY_GATE_ID}?view=summary`);
		return response.ok ? (await response.json()).status : undefined;
	}, { timeout: 15_000, intervals: [100, 250, 500] }).toBe("passed");
}

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
		let fidelityGoalId: string | undefined;
		let fidelityWorkflow: string | undefined;
		let fidelityProjectId: string | undefined;

		try {
			const provider = await apiFetch("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [
						{ id: "sonnet-test", name: "Deterministic Claude SDK" },
						{ id: "unavailable-test", name: "Deterministic unavailable Claude SDK" },
					],
				}),
			});
			expect(provider.status, await provider.text()).toBe(200);

			const sdkDefault = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": SDK_MODEL, "default.sessionThinkingLevel": "off" }),
			});
			expect(sdkDefault.status, await sdkDefault.text()).toBe(200);
			const projectId = await defaultProjectId();
			expect(projectId).toBeTruthy();
			fidelityProjectId = projectId;
			fidelityWorkflow = fidelityWorkflowId();
			await createFidelityWorkflow(projectId!, fidelityWorkflow);
			const fidelityGoal = await createGoal({
				title: `SDK transcript fidelity ${Date.now()}`,
				workflowId: fidelityWorkflow,
				projectId,
				worktree: false,
			});
			fidelityGoalId = fidelityGoal.id;
			const sdkCreate = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, projectId, goalId: fidelityGoalId }),
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

			// A real workflow verification must settle while the Claude session is
			// live; this avoids treating a synthetic gate row as parent proof.
			const gateSignal = await apiFetch(`/api/goals/${fidelityGoalId}/gates/${FIDELITY_GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Deterministic SDK parent fidelity demonstration." }),
			});
			expect(gateSignal.status, await gateSignal.text()).toBe(201);
			await waitForGatePass(fidelityGoalId!);

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
				{ uuid: "sdk-read-call-1", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-read-result-1", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-assistant-1", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-user-2", parent_tool_use_id: null, parent_agent_id: null },
				{ uuid: "sdk-assistant-2", parent_tool_use_id: null, parent_agent_id: null },
			]);
			expect(JSON.stringify(beforeCompact.data)).toContain("SDK_TRANSLATED:SDK_BEFORE_RESTART_TWO");
			expect(JSON.stringify(beforeCompact.data)).toContain("DETERMINISTIC_BOBBIT_READ");
			expect(beforeCompact.data).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "sdk-read-call-1", role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "read" })]) }),
				expect.objectContaining({ id: "sdk-read-result-1", role: "toolResult", toolName: "read" }),
			]));
			expect(gateway.sessionManager.getSessionCost(sdkId)).toMatchObject({
				inputTokens: 30,
				outputTokens: 12,
				cacheReadTokens: 6,
				cacheWriteTokens: 3,
				totalCost: null,
				notionalCostUsd: 0.003,
				costBasis: "subscription-notional",
				byModel: { "sonnet-test": expect.objectContaining({ inputTokens: 30, outputTokens: 12, contextWindow: 200_000, maxOutputTokens: 8_192 }) },
				context: expect.objectContaining({ currentTokens: 246, highWaterTokens: 246, highWaterModel: "sonnet-test" }),
			});
			expect(fakeSdk.sessionAccessCalls).toContainEqual({ method: "info", sessionId: SDK_SESSION_ID, dir: sdkLive!.cwd });
			expect(fakeSdk.sessionAccessCalls).toContainEqual({ method: "messages", sessionId: SDK_SESSION_ID, dir: sdkLive!.cwd });

			const historyBeforeCompact = structuredClone(fakeSdk.history);
			const compactionConnection = await connectWs(sdkId);
			try {
				const cursor = compactionConnection.messageCount();
				await fakeSdk.invokePreCompact(fakeSdk.queries[0]);
				expect(fakeSdk.preCompactRuns).toBe(1);
				expect(fakeSdk.history).toEqual(historyBeforeCompact);
				// A changed official history, not PreCompact alone, resolves the durable
				// checkpoint. Replay the root result to exercise its normal observation seam.
				fakeSdk.completeCompaction();
				fakeSdk.replayRootResult(fakeSdk.queries[0], 2);
				await compactionConnection.waitForFrom(cursor, message => message.type === "event"
					&& message.data?.type === "compaction_end", 15_000);
			} finally {
				compactionConnection.close();
			}
			expect(gateway.sessionManager.getPersistedSession(sdkId)).toMatchObject({ claudeAgentSdkSessionId: SDK_SESSION_ID });
			const afterCompact = await gateway.sessionManager.getMessagesSnapshotBase(sdkLive!);
			expect(afterCompact.success).toBe(true);
			expect(afterCompact.data).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "sdk-user-2" }),
				expect.objectContaining({ id: "sdk-assistant-2" }),
				expect.objectContaining({ id: expect.stringMatching(/^sdkc_/), role: "assistant" }),
			]));
			const checkpointRow = (afterCompact.data as any[]).find(row => typeof row?.id === "string" && row.id.startsWith("sdkc_"));
			const checkpointId = checkpointRow?.content?.[0]?.arguments?.compactionId;
			expect(checkpointId).toMatch(/^sdkc_/);
			const preCompactionHistory = await apiFetch(`/api/sessions/${sdkId}/transcript/before-compaction?compactionId=${checkpointId}&limit=50&verbose=1`);
			expect(preCompactionHistory.status, await preCompactionHistory.clone().text()).toBe(200);
			expect((await preCompactionHistory.json()).messages).toEqual(expect.arrayContaining([
				expect.objectContaining({ message: expect.objectContaining({ id: "sdk-user-1" }) }),
			]));

			await gateway.sessionManager.getSessionStore(persisted.projectId).flushAsync();
			const onDisk = JSON.parse(readFileSync(join(harnessDefaultProjectRoot(), ".bobbit", "state", "sessions.json"), "utf8"));
			const onDiskSession = (Array.isArray(onDisk) ? onDisk : onDisk.sessions).find((session: any) => session.id === sdkId);
			expect(onDiskSession).toMatchObject({ runtime: "claude-agent-sdk", claudeAgentSdkSessionId: SDK_SESSION_ID });

			const preRestartReloadConnection = await connectWs(sdkId);
			let preRestartReloadTranscript: unknown[];
			try {
				preRestartReloadTranscript = await sessionTranscript(preRestartReloadConnection);
			} finally {
				preRestartReloadConnection.close();
			}

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
			expect(afterRestart.data).toEqual(afterCompact.data);
			expect(JSON.stringify(afterRestart.data)).toContain("SDK_TRANSLATED:SDK_BEFORE_RESTART_TWO");

			// The replacement bridge can replay the terminal SDK result. Its durable
			// source UUID ledger must leave cost, per-model totals, and context intact.
			fakeSdk.replayRootResult(fakeSdk.queries[1], 2);
			await expect.poll(() => gateway.sessionManager.getSessionCost(sdkId)?.inputTokens, { timeout: 5_000 }).toBe(30);
			expect(gateway.sessionManager.getSessionCost(sdkId)).toMatchObject({
				outputTokens: 12,
				notionalCostUsd: 0.003,
				byModel: { "sonnet-test": expect.objectContaining({ inputTokens: 30 }) },
				context: expect.objectContaining({ highWaterTokens: 246 }),
			});

			const reloadConnection = await connectWs(sdkId);
			try {
				expect(await sessionTranscript(reloadConnection)).toEqual(preRestartReloadTranscript);
			} finally {
				reloadConnection.close();
			}

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
			// SDK owns the compacted history. A resumed prompt extends the canonical
			// post-compaction checkpoint snapshot, not the provider-discarded prefix.
			const messagesBeforeRestartPrompt = afterCompact.data as Array<unknown>;
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

			// A provider start failure must settle rather than leave a queued session.
			fakeSdk.unavailableModels.add("unavailable-test");
			const unavailableDefault = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": SDK_UNAVAILABLE_MODEL, "default.sessionThinkingLevel": "off" }),
			});
			expect(unavailableDefault.status, await unavailableDefault.text()).toBe(200);
			const unavailableQueriesBefore = fakeSdk.queries.length;
			const unavailableCreate = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false }),
			});
			const unavailableBody = await unavailableCreate.text();
			expect(unavailableCreate.status).toBe(503);
			expect(JSON.parse(unavailableBody)).toEqual({
				error: "SDK_SESSION_UNAVAILABLE",
				code: "SDK_SESSION_UNAVAILABLE",
			});
			expect(unavailableBody).not.toContain("DETERMINISTIC_SDK_PROVIDER_UNAVAILABLE");
			expect(fakeSdk.queries).toHaveLength(unavailableQueriesBefore + 1);
			expect(fakeSdk.queries.at(-1)?.args.options.model).toBe("unavailable-test");
			// Returning a stable unavailable category proves it settled instead of
			// leaving a live prompt/queue hung or leaking provider diagnostics.
		} finally {
			if (fidelityGoalId) await deleteGoal(fidelityGoalId);
			if (fidelityWorkflow && fidelityProjectId) {
				await apiFetch(`/api/workflows/${encodeURIComponent(fidelityWorkflow)}?projectId=${encodeURIComponent(fidelityProjectId)}`, { method: "DELETE" }).catch(() => undefined);
			}
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
