import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	base,
	createSession,
	deleteSession,
	readE2ETokenAsync,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import {
	EVENT_STREAM_DONE_MARKER,
	EVENT_STREAM_MARKER_PREFIX,
	EVENT_STREAM_VIEWPORT,
	createEventStreamFixture,
} from "../../../scripts/benchmarks/event-stream/fixture.mjs";

const SESSION_FIRST = "BOBBIT_BROWSER_BENCH_SESSION_FIRST";
const SESSION_LAST = "BOBBIT_BROWSER_BENCH_SESSION_LAST";
const SESSION_COMPACTION_ID = "c_browser_benchmark_smoke";
const SESSION_RAW_IDS = [
	"browser-benchmark-user-first",
	"browser-benchmark-assistant-success",
	"browser-benchmark-result-success",
	"browser-benchmark-user-middle",
	"browser-benchmark-assistant-error",
	"browser-benchmark-result-error",
	"browser-benchmark-assistant-last",
] as const;
const SESSION_TOOL_IDS = ["browser-benchmark-tool-success", "browser-benchmark-tool-error"] as const;
const MESSAGE_SELECTOR = "user-message, assistant-message, tool-message";

type MetricSupport = "reliable" | "browser-api" | "estimated" | "unsupported";

type SessionOpenMetrics = {
	timeToInteractiveMs: number;
	serverResponseLatencyMs: number;
	transferredBytes: number;
	longTaskCount: number;
	longTaskTotalMs: number;
	longTaskMaxMs: number;
	heapGrowthBytes: number | null;
	heapPeakBytes: number | null;
	metricReliability: {
		webSocketFrames: MetricSupport;
		longTasks: MetricSupport;
		heap: MetricSupport;
	};
};

type EventMetrics = {
	eventThroughputPerSecond: number;
	eventToRenderP95Ms: number;
	droppedFrames: number;
	slowFrames: number;
	longTaskCount: number;
	longTaskTotalMs: number;
	longTaskMaxMs: number;
	heapGrowthBytes: number | null;
	peakHeapBytes: number | null;
	metricReliability: {
		eventToRender: MetricSupport;
		frameCadence: MetricSupport;
		longTasks: MetricSupport;
		heap: MetricSupport;
	};
};

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function transcriptEntry(id: string, parentId: string | null, message: Record<string, unknown>, offset: number) {
	return {
		type: "message",
		id: `entry-${id}`,
		parentId,
		timestamp: new Date(Date.parse("2024-01-01T00:00:00.000Z") + offset).toISOString(),
		message: { id, timestamp: Date.parse("2024-01-01T00:00:00.000Z") + offset, ...message },
	};
}

function reducedSessionTranscript(): string {
	const messages = [
		{
			id: SESSION_RAW_IDS[0],
			role: "user",
			content: [{ type: "text", text: `${SESSION_FIRST}\nInspect the deterministic browser fixture.` }],
		},
		{
			id: SESSION_RAW_IDS[1],
			role: "assistant",
			content: [
				{ type: "text", text: "## Fixture analysis\n\nThe production renderer must preserve this message." },
				{ type: "toolCall", id: SESSION_TOOL_IDS[0], name: "Read", arguments: { path: "fixture.txt" } },
			],
			stopReason: "toolUse",
		},
		{
			id: SESSION_RAW_IDS[2],
			role: "toolResult",
			toolCallId: SESSION_TOOL_IDS[0],
			toolName: "Read",
			isError: false,
			content: [{ type: "text", text: "deterministic tool result" }],
		},
		{
			id: SESSION_RAW_IDS[3],
			role: "user",
			content: [{ type: "text", text: "Exercise legacy tool-result normalization." }],
		},
		{
			id: SESSION_RAW_IDS[4],
			role: "assistant",
			content: [
				{ type: "text", text: "The legacy error follows." },
				{ type: "toolCall", id: SESSION_TOOL_IDS[1], name: "Read", arguments: { path: "missing.txt" } },
			],
			stopReason: "toolUse",
		},
		{
			id: SESSION_RAW_IDS[5],
			role: "toolResult",
			toolCallId: SESSION_TOOL_IDS[1],
			toolName: "Read",
			is_error: true,
			content: [{ type: "text", text: "legacy deterministic error" }],
		},
		{
			id: SESSION_RAW_IDS[6],
			role: "assistant",
			content: [{ type: "text", text: SESSION_LAST }],
			stopReason: "stop",
		},
	];
	let parentId: string | null = null;
	const entries = messages.map((message, index) => {
		const entry = transcriptEntry(message.id, parentId, message, index + 1);
		parentId = entry.id;
		return entry;
	});
	return [
		JSON.stringify({ type: "session", version: 3, id: "browser-benchmark-session", timestamp: "2024-01-01T00:00:00.000Z" }),
		...entries.map(entry => JSON.stringify(entry)),
	].join("\n") + "\n";
}

function installSessionOpenObserver(): void {
	const state = {
		startedAt: performance.now(),
		responseAt: null as number | null,
		transferredBytes: 0,
		longTasks: [] as number[],
		heapInitialBytes: Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null,
		heapSamples: [] as number[],
	};
	(window as any).__browserBenchmarkSessionOpen = state;
	const NativeWebSocket = window.WebSocket;
	class ObservedWebSocket extends NativeWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.addEventListener("message", event => {
				if (typeof event.data !== "string") return;
				let frame: any;
				try { frame = JSON.parse(event.data); } catch { return; }
				if (frame?.type !== "messages" || state.responseAt !== null) return;
				state.responseAt = performance.now();
				state.transferredBytes = new TextEncoder().encode(event.data).byteLength;
			});
		}
	}
	window.WebSocket = ObservedWebSocket;
	try {
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
		}).observe({ type: "longtask", buffered: true });
	} catch { /* unsupported browser metric */ }
	window.setInterval(() => {
		const heap = performance.memory?.usedJSHeapSize;
		if (Number.isFinite(heap)) state.heapSamples.push(heap);
	}, 25);
}

function installEventObserver(config: { markerPrefix: string; updateCount: number }): void {
	const state = {
		armed: false,
		frames: [] as Array<{ id: string; type: string; seq: number | null; ordinal: number | null; arrivalMs: number }>,
		arrivalByOrdinal: {} as Record<number, number>,
		renderByOrdinal: {} as Record<number, number>,
		longTasks: [] as number[],
		frameDeltas: [] as number[],
		lastFrameAt: null as number | null,
		heapInitialBytes: null as number | null,
		heapFinalBytes: null as number | null,
		heapPeakBytes: null as number | null,
		arm() {
			this.armed = true;
			this.frames = [];
			this.arrivalByOrdinal = {};
			this.renderByOrdinal = {};
			this.longTasks = [];
			this.frameDeltas = [];
			this.lastFrameAt = null;
			this.heapInitialBytes = Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null;
			this.heapPeakBytes = this.heapInitialBytes;
		},
	};
	(window as any).__browserBenchmarkEventStream = state;
	const NativeWebSocket = window.WebSocket;
	class ObservedWebSocket extends NativeWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.addEventListener("message", event => {
				if (!state.armed || typeof event.data !== "string") return;
				let frame: any;
				try { frame = JSON.parse(event.data); } catch { return; }
				const data = frame?.type === "event" ? frame.data : null;
				if (typeof data?.benchmarkEventId !== "string") return;
				const arrivalMs = performance.now();
				const ordinal = Number.isInteger(data.benchmarkOrdinal) ? data.benchmarkOrdinal : null;
				state.frames.push({ id: data.benchmarkEventId, type: data.type, seq: frame.seq ?? null, ordinal, arrivalMs });
				if (ordinal !== null) state.arrivalByOrdinal[ordinal] = arrivalMs;
			});
		}
	}
	window.WebSocket = ObservedWebSocket;
	try {
		new PerformanceObserver(list => {
			if (state.armed) for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
		}).observe({ type: "longtask", buffered: true });
	} catch { /* unsupported browser metric */ }
	const sampleFrame = (now: number) => {
		requestAnimationFrame(sampleFrame);
		if (!state.armed) return;
		if (state.lastFrameAt !== null) state.frameDeltas.push(now - state.lastFrameAt);
		state.lastFrameAt = now;
		const heap = performance.memory?.usedJSHeapSize;
		if (Number.isFinite(heap)) state.heapPeakBytes = Math.max(state.heapPeakBytes ?? 0, heap);
	};
	requestAnimationFrame(sampleFrame);
	let queued = false;
	new MutationObserver(() => {
		if (!state.armed || queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			const text = document.body?.textContent ?? "";
			for (let ordinal = 1; ordinal <= config.updateCount; ordinal += 1) {
				if (state.renderByOrdinal[ordinal] !== undefined) continue;
				const marker = `${config.markerPrefix}${String(ordinal).padStart(3, "0")}`;
				if (text.includes(marker)) state.renderByOrdinal[ordinal] = performance.now();
			}
		});
	}).observe(document, { childList: true, subtree: true, characterData: true });
}

async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		(window as any).DeferredBlock?.forceResolveAll?.();
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
}

async function transcriptFingerprint(page: Page) {
	return page.evaluate((selector) => {
		const normalize = (value: unknown) => String(value ?? "").replace(/\b\d+(?:\.\d+)?s\b/g, "Xs").replace(/\s+/g, " ").trim();
		const nodes = Array.from(document.querySelectorAll(selector)) as any[];
		const messages = nodes.map(node => ({ tag: node.tagName.toLowerCase(), id: node.message?.id ?? null, text: normalize(node.textContent) }));
		const agent = document.querySelector("agent-interface") as any;
		const clientMessages = Array.isArray(agent?.session?.state?.messages) ? agent.session.state.messages : [];
		return {
			messages,
			clientMessages: clientMessages.map((message: any) => ({
				id: message?.id ?? null,
				role: message?.role ?? null,
				toolCallId: message?.toolCallId ?? null,
				isError: message?.isError ?? false,
				text: Array.isArray(message?.content)
					? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n")
					: "",
			})),
		};
	}, MESSAGE_SELECTOR);
}

function expectFiniteMetric(value: unknown, label: string): asserts value is number {
	expect(Number.isFinite(value), `${label} must be a finite number`).toBe(true);
}

function expectSessionMetricContract(metrics: SessionOpenMetrics): void {
	for (const [name, value] of Object.entries(metrics).filter(([name]) => name !== "metricReliability")) {
		if (name.startsWith("heap") && value === null) continue;
		expectFiniteMetric(value, name);
	}
	expect(metrics.transferredBytes).toBeGreaterThan(0);
	expect(metrics.metricReliability).toEqual({
		webSocketFrames: "reliable",
		longTasks: "browser-api",
		heap: expect.stringMatching(/^(estimated|unsupported)$/),
	});
}

function expectEventMetricContract(metrics: EventMetrics): void {
	for (const [name, value] of Object.entries(metrics).filter(([name]) => name !== "metricReliability")) {
		if ((name === "heapGrowthBytes" || name === "peakHeapBytes") && value === null) continue;
		expectFiniteMetric(value, name);
	}
	expect(metrics.metricReliability).toEqual({
		eventToRender: "reliable",
		frameCadence: "estimated",
		longTasks: "browser-api",
		heap: expect.stringMatching(/^(estimated|unsupported)$/),
	});
}

test.describe("durable Bobbit browser benchmarks", () => {
	test.describe.configure({ retries: 0 });
	test.setTimeout(90_000);

	test("reduced session-open traverses get_messages, preserves exact parity, and reloads", async ({ page, gateway }) => {
		const sessionId = await createSession();
		const transcriptFile = path.join(gateway.bobbitDir, "state", `browser-benchmark-session-${sessionId}.jsonl`);
		const sidecarFile = path.join(gateway.bobbitDir, "state", "compaction-sidecar", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
		try {
			await waitForSessionStatus(sessionId, "idle");
			const manager = gateway.sessionManager as any;
			const session = manager.getSession(sessionId);
			expect(session, "live benchmark fixture session must exist").toBeTruthy();
			let persisted: any;
			await expect.poll(() => {
				persisted = manager.getPersistedSession(sessionId);
				return persisted?.projectId;
			}, { timeout: 15_000, message: "session-open fixture must be persisted before seeding" }).toEqual(expect.any(String));
			manager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: transcriptFile });
			mkdirSync(path.dirname(transcriptFile), { recursive: true });
			writeFileSync(transcriptFile, reducedSessionTranscript(), "utf8");
			await session.rpcClient.sendCommand({ type: "switch_session", sessionPath: transcriptFile });
			mkdirSync(path.dirname(sidecarFile), { recursive: true });
			writeFileSync(sidecarFile, `${JSON.stringify({
				schemaVersion: 1,
				id: SESSION_COMPACTION_ID,
				trigger: "manual",
				tokensBefore: 10_000,
				tokensAfter: 4_000,
				durationMs: 25,
				startedAt: "2024-01-01T00:00:00.000Z",
				endedAt: "2024-01-01T00:00:00.025Z",
				success: true,
				firstKeptEntryId: `entry-${SESSION_RAW_IDS[0]}`,
			})}\n`, "utf8");

			await page.setViewportSize(EVENT_STREAM_VIEWPORT);
			await page.addInitScript(installSessionOpenObserver);
			const token = await readE2ETokenAsync();
			await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(SESSION_LAST, { exact: true })).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1, { timeout: 20_000 });
			await settle(page);

			const first = await transcriptFingerprint(page);
			const rawOrder = first.clientMessages.map(message => message.id).filter(id => SESSION_RAW_IDS.includes(id as any));
			expect(rawOrder, "snapshot must preserve every raw fixture id in order").toEqual(SESSION_RAW_IDS);
			expect(new Set(rawOrder).size, "snapshot must not duplicate fixture ids").toBe(SESSION_RAW_IDS.length);
			expect(first.clientMessages.filter(message => message.id === SESSION_COMPACTION_ID)).toHaveLength(1);
			expect(first.clientMessages.find(message => message.id === SESSION_RAW_IDS[5])).toMatchObject({
				role: "toolResult",
				toolCallId: SESSION_TOOL_IDS[1],
				isError: true,
			});
			const renderedFixtureOrder = first.messages
				.filter(message => message.tag !== "tool-message")
				.map(message => message.id)
				.filter(id => SESSION_RAW_IDS.includes(id as any));
			expect(renderedFixtureOrder).toEqual([
				SESSION_RAW_IDS[0],
				SESSION_RAW_IDS[1],
				SESSION_RAW_IDS[3],
				SESSION_RAW_IDS[4],
				SESSION_RAW_IDS[6],
			]);

			const metrics = await page.evaluate(async () => {
				const state = (window as any).__browserBenchmarkSessionOpen;
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				if (!Number.isFinite(state.responseAt)) throw new Error("messages WebSocket response was not observed");
				const interactiveAt = performance.now();
				const heapFinal = Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null;
				const heapValues = [state.heapInitialBytes, heapFinal, ...state.heapSamples].filter(Number.isFinite);
				return {
					timeToInteractiveMs: interactiveAt - state.startedAt,
					serverResponseLatencyMs: state.responseAt - state.startedAt,
					transferredBytes: state.transferredBytes,
					longTaskCount: state.longTasks.length,
					longTaskTotalMs: state.longTasks.reduce((sum: number, value: number) => sum + value, 0),
					longTaskMaxMs: state.longTasks.length ? Math.max(...state.longTasks) : 0,
					heapGrowthBytes: state.heapInitialBytes !== null && heapFinal !== null ? heapFinal - state.heapInitialBytes : null,
					heapPeakBytes: heapValues.length ? Math.max(...heapValues) : null,
					metricReliability: {
						webSocketFrames: "reliable",
						longTasks: "browser-api",
						heap: heapValues.length ? "estimated" : "unsupported",
					},
				};
			}) as SessionOpenMetrics;
			expectSessionMetricContract(metrics);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByText(SESSION_LAST, { exact: true })).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1, { timeout: 20_000 });
			await settle(page);
			const refreshed = await transcriptFingerprint(page);
			expect(sha256(refreshed), "session-open DOM/client projection must be identical after reload").toBe(sha256(first));
		} finally {
			await deleteSession(sessionId);
			expect((await apiFetch(`/api/sessions/${sessionId}`)).status, "session-open fixture session must be deleted").toBe(404);
			rmSync(transcriptFile, { force: true });
			rmSync(sidecarFile, { force: true });
			expect(existsSync(transcriptFile) || existsSync(sidecarFile), "session-open fixture files must be removed").toBe(false);
		}
	});

	test("reduced event stream preserves exact protocol order, final state, metrics, and reload parity", async ({ page }) => {
		const fixture = createEventStreamFixture({ updateCount: 8, intervalMs: 25 });
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await page.setViewportSize(EVENT_STREAM_VIEWPORT);
			await page.addInitScript(installEventObserver, {
				markerPrefix: EVENT_STREAM_MARKER_PREFIX,
				updateCount: fixture.updateCount,
			});
			await openApp(page);
			await page.evaluate(id => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await page.waitForFunction(id => {
				const app = (window as any).bobbitState ?? (window as any).__bobbitState;
				return app?.selectedSessionId === id && app?.remoteAgent?.state?.status === "idle";
			}, sessionId, { timeout: 20_000 });
			await page.evaluate(() => (window as any).__browserBenchmarkEventStream.arm());
			await sendMessage(page, fixture.trigger);
			await expect(page.getByText(`${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`, { exact: true })).toBeVisible({ timeout: 30_000 });
			await waitForSessionStatus(sessionId, "idle", 30_000);
			await page.waitForFunction(() => {
				const app = (window as any).bobbitState ?? (window as any).__bobbitState;
				const remote = app?.remoteAgent?.state;
				return remote?.status === "idle" && remote?.isStreaming !== true;
			}, undefined, { timeout: 20_000 });
			await settle(page);

			const observed = await page.evaluate(() => {
				const state = (window as any).__browserBenchmarkEventStream;
				state.armed = false;
				state.heapFinalBytes = Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null;
				return state;
			});
			expect(observed.frames.map((frame: any) => ({ id: frame.id, type: frame.type, ordinal: frame.ordinal }))).toEqual(fixture.expectedFrames);
			const sequences = observed.frames.map((frame: any) => frame.seq);
			expect(sequences.every((seq: unknown) => Number.isInteger(seq)), "every tagged event must carry a sequence").toBe(true);
			expect(sequences.slice(1).every((seq: number, index: number) => seq === sequences[index] + 1), "event sequences must be gap-free, unique, and ordered").toBe(true);

			const finalUi = await page.evaluate(() => {
				const app = (window as any).bobbitState ?? (window as any).__bobbitState;
				const remote = app?.remoteAgent?.state;
				const editor = document.querySelector("message-editor textarea") as HTMLTextAreaElement | null;
				const streaming = document.querySelector("streaming-message-container") as any;
				return {
					status: remote?.status ?? null,
					pendingTools: remote?.pendingToolCalls?.size ?? remote?.pendingToolCalls?.length ?? 0,
					streaming: remote?.isStreaming === true || streaming?.isStreaming === true,
					editorEnabled: Boolean(editor && !editor.disabled),
				};
			});
			expect(finalUi).toEqual({ status: "idle", pendingTools: 0, streaming: false, editorEnabled: true });

			const live = await transcriptFingerprint(page);
			const benchmarkIds = live.clientMessages.map(message => message.id).filter(id => typeof id === "string" && id.startsWith("benchmark-"));
			expect(benchmarkIds).toEqual([
				"benchmark-stream-message",
				"benchmark-proposal-message",
				"benchmark-proposal-result",
				"benchmark-success-message",
				"benchmark-success-result",
				"benchmark-error-message",
				"benchmark-error-result",
				"benchmark-done-message",
			]);
			expect(new Set(benchmarkIds).size).toBe(benchmarkIds.length);
			for (const marker of fixture.markers) {
				const count = live.clientMessages.filter(message => message.text.includes(marker)).length;
				expect(count, `${marker} must occur in exactly one final message`).toBe(1);
			}
			expect(live.clientMessages.find(message => message.id === "benchmark-error-result")).toMatchObject({ isError: true });

			const committedLatencies = Array.from({ length: fixture.updateCount }, (_, index) => {
				const ordinal = index + 1;
				const arrival = observed.arrivalByOrdinal[ordinal];
				const render = observed.renderByOrdinal[ordinal];
				expectFiniteMetric(arrival, `arrival ordinal ${ordinal}`);
				expectFiniteMetric(render, `render ordinal ${ordinal}`);
				expect(render).toBeGreaterThanOrEqual(arrival);
				return render - arrival;
			});
			const sortedLatencies = [...committedLatencies].sort((a, b) => a - b);
			const frameDeltas = observed.frameDeltas.filter((value: number) => Number.isFinite(value) && value > 0 && value < 100);
			const refreshEstimate = [...frameDeltas].sort((a: number, b: number) => a - b)[Math.floor(frameDeltas.length / 2)];
			expectFiniteMetric(refreshEstimate, "estimated refresh interval");
			const slowFrames = frameDeltas.filter((value: number) => value > refreshEstimate * 1.5);
			const deliveryMs = Math.max(0.001, observed.frames.at(-1).arrivalMs - observed.frames[0].arrivalMs);
			const metrics: EventMetrics = {
				eventThroughputPerSecond: observed.frames.length * 1_000 / deliveryMs,
				eventToRenderP95Ms: sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1],
				droppedFrames: slowFrames.reduce((sum: number, value: number) => sum + Math.max(0, Math.round(value / refreshEstimate) - 1), 0),
				slowFrames: slowFrames.length,
				longTaskCount: observed.longTasks.length,
				longTaskTotalMs: observed.longTasks.reduce((sum: number, value: number) => sum + value, 0),
				longTaskMaxMs: observed.longTasks.length ? Math.max(...observed.longTasks) : 0,
				heapGrowthBytes: observed.heapInitialBytes !== null && observed.heapFinalBytes !== null
					? observed.heapFinalBytes - observed.heapInitialBytes
					: null,
				peakHeapBytes: observed.heapPeakBytes,
				metricReliability: {
					eventToRender: "reliable",
					frameCadence: "estimated",
					longTasks: "browser-api",
					heap: observed.heapInitialBytes !== null ? "estimated" : "unsupported",
				},
			};
			expectEventMetricContract(metrics);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByText(`${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`, { exact: true })).toBeVisible({ timeout: 20_000 });
			await settle(page);
			const refreshed = await transcriptFingerprint(page);
			expect(sha256(refreshed), "event-stream DOM/client projection must be identical after reload").toBe(sha256(live));
		} finally {
			await deleteSession(sessionId);
			expect((await apiFetch(`/api/sessions/${sessionId}`)).status, "event-stream fixture session must be deleted").toBe(404);
		}
	});
});
