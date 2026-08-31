import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiAssistantStreamNormalizer } from "../../../src/shared/assistant-stream-delta.ts";

const SELECTED_PI_VERSION = "0.84.1";
const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
] as const;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function installedPackageRoot(packageName: string): string {
	let current = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
	while (true) {
		const candidate = path.join(current, "package.json");
		if (fs.existsSync(candidate)) {
			const metadata = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
			if (metadata.name === packageName) return current;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`Could not locate installed package root for ${packageName}`);
		current = parent;
	}
}

function installedVersion(packageName: string): string {
	const metadata = JSON.parse(
		fs.readFileSync(path.join(installedPackageRoot(packageName), "package.json"), "utf8"),
	) as { version: string };
	return metadata.version;
}

function userMessage(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function messageText(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text")
		.map((block: any) => block.text)
		.join("");
}

async function loadInstalledJsonEventAdapter(): Promise<{ toJsonEvent(event: any): any }> {
	const packageRoot = installedPackageRoot("@earendil-works/pi-coding-agent");
	const adapterPath = path.join(packageRoot, "dist", "modes", "json-event.js");
	if (!fs.existsSync(adapterPath)) return { toJsonEvent: (event: any) => event };
	return await import(pathToFileURL(adapterPath).href) as { toJsonEvent(event: any): any };
}

describe("installed Pi runtime contract for reliable agent turns", () => {
	it("keeps the installed Pi trio on the selected common compatible release", () => {
		const versions = Object.fromEntries(PI_PACKAGES.map((name) => [name, installedVersion(name)]));
		expect(versions, "PI_CONTRACT_VERSION_MISMATCH: upgrade the Pi trio together").toEqual({
			"@earendil-works/pi-ai": SELECTED_PI_VERSION,
			"@earendil-works/pi-agent-core": SELECTED_PI_VERSION,
			"@earendil-works/pi-coding-agent": SELECTED_PI_VERSION,
		});
	});

	it("emits delta-only JSON message_update frames and preserves exact terminal authority", async () => {
		const { toJsonEvent } = await loadInstalledJsonEventAdapter();
		const cumulativePartial = {
			role: "assistant",
			content: [{ type: "text", text: "cumulative text that must stay off the wire" }],
		};
		const update = toJsonEvent({
			type: "message_update",
			message: cumulativePartial,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "delta only",
				partial: cumulativePartial,
			},
		});

		expect(update, "PI_CONTRACT_MESSAGE_UPDATE_NOT_DELTA_ONLY").toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta only" },
		});
		expect(update).not.toHaveProperty("message");
		expect(update.assistantMessageEvent).not.toHaveProperty("partial");

		const exactTerminal = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "provider-authoritative final text" }],
				stopReason: "stop",
				provider: "contract",
				model: "terminal",
			},
		};
		expect(toJsonEvent(exactTerminal)).toBe(exactTerminal);
	});

	it("reconstructs installed Pi delta-only updates while keeping message_end terminal-authoritative", async () => {
		const { toJsonEvent } = await loadInstalledJsonEventAdapter();
		const normalizer = new PiAssistantStreamNormalizer();
		const baseline = {
			role: "assistant",
			content: [],
			api: "contract",
			provider: "contract",
			model: "delta-only",
			timestamp: 1_735_000_000_000,
		};
		const start = toJsonEvent({ type: "message_start", message: baseline });
		expect(normalizer.normalize(start)).toBe(start);

		const cumulative = structuredClone(baseline) as any;
		cumulative.content.push({ type: "text", text: "" });
		const rawUpdates: any[] = [
			{
				type: "message_update",
				message: structuredClone(cumulative),
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: structuredClone(cumulative) },
			},
		];
		cumulative.content[0].text = "live ";
		rawUpdates.push({
			type: "message_update",
			message: structuredClone(cumulative),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live ", partial: structuredClone(cumulative) },
		});
		cumulative.content[0].text = "live delta";
		rawUpdates.push({
			type: "message_update",
			message: structuredClone(cumulative),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta", partial: structuredClone(cumulative) },
		});

		const reconstructed = rawUpdates.map((raw) => {
			const installedFrame = toJsonEvent(raw);
			expect(installedFrame).not.toHaveProperty("message");
			expect(installedFrame.assistantMessageEvent).not.toHaveProperty("partial");
			return normalizer.normalize(installedFrame) as any;
		});
		expect(reconstructed.map((event) => messageText(event.message))).toEqual(["", "live ", "live delta"]);
		expect(reconstructed.at(-1)?.assistantMessageEvent.partial).toEqual(reconstructed.at(-1)?.message);

		const terminal = toJsonEvent({
			type: "message_end",
			message: {
				...baseline,
				content: [{ type: "text", text: "provider-authoritative final" }],
				stopReason: "stop",
			},
		});
		expect(normalizer.normalize(terminal), "PI_CONTRACT_TERMINAL_NOT_AUTHORITATIVE").toBe(terminal);
		expect(messageText(terminal.message)).toBe("provider-authoritative final");

		const postTerminalDelta = toJsonEvent(rawUpdates[1]);
		expect(normalizer.normalize(postTerminalDelta)).not.toHaveProperty("message");
	});

	it("clears the active-run guard before emitting agent_settled to installed-runtime observers", async () => {
		const observations: Array<{ observer: "extension" | "session"; type: string; isStreaming: boolean }> = [];
		const receiver: any = Object.create(AgentSession.prototype);
		Object.assign(receiver, {
			_isAgentRunActive: false,
			_eventListeners: [
				(event: any) => observations.push({
					observer: "session",
					type: event.type,
					isStreaming: receiver.isStreaming,
				}),
			],
			_extensionRunner: {
				emit: vi.fn(async (event: any) => {
					observations.push({
						observer: "extension",
						type: event.type,
						isStreaming: receiver.isStreaming,
					});
				}),
			},
			_flushPendingBashMessages: vi.fn(),
			_handlePostAgentRun: vi.fn(async () => false),
			agent: {
				prompt: vi.fn(async () => {
					receiver._emit({ type: "agent_end", messages: [] });
				}),
				continue: vi.fn(),
			},
		});

		await (AgentSession.prototype as any)._runAgentPrompt.call(receiver, [userMessage("settlement contract")]);

		expect(observations, "PI_CONTRACT_AGENT_SETTLED_BEFORE_ACTIVE_RUN_RELEASE").toEqual([
			{ observer: "session", type: "agent_end", isStreaming: true },
			{ observer: "extension", type: "agent_settled", isStreaming: false },
			{ observer: "session", type: "agent_settled", isStreaming: false },
		]);
		expect(receiver.agent.prompt).toHaveBeenCalledOnce();
		expect(receiver._handlePostAgentRun).toHaveBeenCalledOnce();
		expect(receiver.isIdle).toBe(true);
	});

	it("orders manual compaction events and releases its controller before compaction_end", async () => {
		const observations: Array<{ event: any; controllerReleased: boolean }> = [];
		const receiver: any = {
			abort: vi.fn(async () => undefined),
			model: undefined,
			_emit(event: any) {
				observations.push({ event, controllerReleased: receiver._compactionAbortController === undefined });
			},
		};

		await expect((AgentSession.prototype as any).compact.call(receiver)).rejects.toThrow(/model/i);

		expect(observations.map(({ event }) => event.type), "PI_CONTRACT_COMPACTION_EVENT_ORDER").toEqual([
			"compaction_start",
			"compaction_end",
		]);
		expect(observations[0].controllerReleased).toBe(false);
		expect(observations[1]).toMatchObject({
			controllerReleased: true,
			event: { reason: "manual", aborted: false, willRetry: false },
		});
	});

	it("rejects direct prompt submission while manual compaction is active", async () => {
		const preflight = vi.fn();
		const receiver: any = { _compactionAbortController: new AbortController() };

		await expect(
			(AgentSession.prototype as any).prompt.call(receiver, "must remain above the Pi boundary", {
				expandPromptTemplates: false,
				preflightResult: preflight,
			}),
		).rejects.toThrow(
			"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
		);
		expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("removes a recoverable length tail, compacts with willRetry, and retries at most once", async () => {
		const firstTail: any = {
			...fauxAssistantMessage("truncated first response", { stopReason: "length" }),
			usage: {
				input: 900,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 904,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const priorUser = userMessage("original interrupted input");
		const events: any[] = [];
		const runAutoCompaction = vi.fn(async (_reason: string, _willRetry: boolean) => true);
		const receiver: any = {
			settingsManager: { getCompactionSettings: () => ({ enabled: true }) },
			model: { provider: "faux", id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 },
			sessionManager: { getBranch: () => [] },
			agent: { state: { messages: [priorUser, firstTail] } },
			_overflowRecoveryAttempted: false,
			_runAutoCompaction: runAutoCompaction,
			_emit: (event: any) => events.push(event),
		};
		const checkCompaction = (AgentSession.prototype as any)._checkCompaction;

		await expect(checkCompaction.call(receiver, firstTail)).resolves.toBe(true);
		expect(receiver.agent.state.messages, "PI_CONTRACT_LENGTH_TAIL_NOT_REMOVED").toEqual([priorUser]);
		expect(runAutoCompaction).toHaveBeenCalledExactlyOnceWith("overflow", true);
		expect(receiver._overflowRecoveryAttempted).toBe(true);

		const secondTail: any = {
			...firstTail,
			content: [{ type: "text", text: "truncated retry" }],
			timestamp: firstTail.timestamp + 1,
		};
		receiver.agent.state.messages = [priorUser, secondTail];
		await expect(checkCompaction.call(receiver, secondTail)).resolves.toBe(false);
		expect(runAutoCompaction).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual(expect.objectContaining({
			type: "compaction_end",
			reason: "overflow",
			willRetry: false,
			errorMessage: expect.stringContaining("failed after one compact-and-retry attempt"),
		}));
	});

	it("emits overflow compaction start/end with willRetry and removes a restored truncated tail", async () => {
		const now = Date.now();
		const priorUser = userMessage("context before overflow");
		priorUser.timestamp = now - 1_000;
		const truncatedTail: any = {
			...fauxAssistantMessage("truncated overflow tail", { stopReason: "length", timestamp: now }),
			usage: {
				input: 1_000,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_004,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const branch: any[] = [
			{
				type: "message",
				id: "contract-user",
				parentId: null,
				timestamp: new Date(priorUser.timestamp).toISOString(),
				message: priorUser,
			},
			{
				type: "message",
				id: "contract-tail",
				parentId: "contract-user",
				timestamp: new Date(truncatedTail.timestamp).toISOString(),
				message: truncatedTail,
			},
		];
		const events: any[] = [];
		const receiver: any = {
			model: { provider: "faux", id: "faux-1", contextWindow: 8_192, maxTokens: 100 },
			thinkingLevel: "off",
			settingsManager: {
				getCompactionSettings: () => ({ enabled: true, reserveTokens: 0, keepRecentTokens: 1 }),
			},
			_getSummarizationRequestAuth: vi.fn(async (model: any) => ({ model })),
			sessionManager: {
				getBranch: () => branch,
				appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number) {
					branch.push({
						type: "compaction",
						id: "contract-compaction",
						parentId: "contract-tail",
						timestamp: new Date(now + 1).toISOString(),
						summary,
						firstKeptEntryId,
						tokensBefore,
					});
				},
				getEntries: () => branch,
				buildSessionContext: () => ({ messages: [priorUser, truncatedTail] }),
			},
			_extensionRunner: {
				hasHandlers: (name: string) => name === "session_before_compact",
				emit: vi.fn(async (event: any) => event.type === "session_before_compact" ? {
					compaction: {
						summary: "overflow contract summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				} : undefined),
			},
			agent: {
				state: { messages: [priorUser] },
				streamFunction: vi.fn(),
				hasQueuedMessages: () => false,
			},
			_emit: (event: any) => events.push(event),
		};

		await expect(
			(AgentSession.prototype as any)._runAutoCompaction.call(receiver, "overflow", true),
		).resolves.toBe(true);
		expect(events.map((event) => event.type), "PI_CONTRACT_OVERFLOW_COMPACTION_EVENT_ORDER").toEqual([
			"compaction_start",
			"compaction_end",
		]);
		expect(events[1]).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
			result: { summary: "overflow contract summary" },
		});
		expect(receiver.agent.state.messages).toEqual([priorUser]);
		expect(receiver._autoCompactionAbortController).toBeUndefined();
	});

	it("keeps a steer queued until the active response releases, then echoes it before the next model call", async () => {
		const firstRequestStarted = deferred<void>();
		const releaseFirstResponse = deferred<void>();
		const faux = createFauxCore({
			models: [{ id: "faux-1", contextWindow: 8_192, maxTokens: 1_024 }],
		});
		faux.setResponses([
			async () => {
				firstRequestStarted.resolve();
				await releaseFirstResponse.promise;
				return fauxAssistantMessage("first response");
			},
			fauxAssistantMessage("response after steer"),
		]);
		const agent = new Agent({
			streamFn: faux.streamSimple,
			initialState: {
				model: faux.getModel(),
				systemPrompt: "contract test",
				tools: [],
				thinkingLevel: "off",
			},
		});
		const events: any[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		const run = agent.prompt("initial input");
		await firstRequestStarted.promise;
		const steer = userMessage("held steer occurrence");
		const acknowledgementBoundary = events.length;
		expect(agent.steer(steer), "Pi steer admission is synchronous acknowledgement only").toBeUndefined();
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(
			events.some((event) => event.type === "message_start" && messageText(event.message) === "held steer occurrence"),
			"PI_CONTRACT_STEER_SETTLED_AT_ACK",
		).toBe(false);

		releaseFirstResponse.resolve();
		await run;

		const steerStartIndexes = events.flatMap((event, index) =>
			event.type === "message_start" && messageText(event.message) === "held steer occurrence" ? [index] : [],
		);
		expect(steerStartIndexes).toHaveLength(1);
		expect(steerStartIndexes[0]).toBeGreaterThanOrEqual(acknowledgementBoundary);
		expect(faux.state.callCount).toBe(2);
		expect(agent.hasQueuedMessages()).toBe(false);
	});
});
