import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { p95 } from "./contract.mjs";
import {
	aggregateMeasuredReliability,
	closeBenchmarkBrowser,
	createBenchmarkGatewayToken,
	createInterruptingSampleWatchdog,
	getFreePort,
	launchBenchmarkBrowser,
	sanitizeBenchmarkDiagnosticText,
	sanitizeBenchmarkError,
	spawnGateway,
	stopGateway,
	waitForGatewayReady,
} from "./runtime.mjs";
import {
	EVENT_STREAM_DONE_MARKER,
	EVENT_STREAM_ERROR_OUTPUT,
	EVENT_STREAM_FIXTURE_VERSION,
	EVENT_STREAM_INTERVAL_MS,
	EVENT_STREAM_MARKER_PREFIX,
	EVENT_STREAM_PROPOSAL_SPEC,
	EVENT_STREAM_RETENTION_EVICTION_COUNT,
	EVENT_STREAM_RETENTION_EVICTION_TYPE,
	EVENT_STREAM_RETENTION_PREFILL_COUNT,
	EVENT_STREAM_RETENTION_PREFILL_TYPE,
	EVENT_STREAM_RETENTION_PROBE_TYPE,
	EVENT_STREAM_UPDATE_COUNT,
	EVENT_STREAM_VIEWPORT,
	createEventStreamFixture,
	createEventStreamRetentionFixture,
	eventStreamSemanticCounts,
	eventStreamToolPairs,
} from "./event-stream/fixture.mjs";

const CASE_NAME = `stream-${EVENT_STREAM_UPDATE_COUNT}`;
export const EVENT_STREAM_SAMPLE_TIMEOUT_MS = 120_000;
export const EVENT_STREAM_WATCHDOG_GRACE_MS = 5_000;
const EVENT_STREAM_PHASES = Object.freeze(["prepare", "saturate", "stream", "oracle", "teardown"]);
const CLI_RELATIVE = path.join("dist", "server", "cli.js");
const EVENT_BUFFER_DEFAULT_MAX_SIZE = 1_000;
const EVENT_BUFFER_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const RETENTION_DIAGNOSTIC_LABEL_PREFIX = "session-manager:emitSessionEvent:";
const MOCK_AGENT_RELATIVE = path.join("tests", "e2e", "mock-agent.mjs");
const MESSAGE_SELECTOR = "user-message, assistant-message, tool-message";

export function eventStreamGatewayArgs(repoRoot, workspace, port) {
	return [
		path.join(repoRoot, CLI_RELATIVE),
		"--cwd", workspace,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls",
		"--auth",
		"--agent-cli", path.join(repoRoot, MOCK_AGENT_RELATIVE),
	];
}

function sha256(value) {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function projectEventStreamRetentionDiagnostics(jsonl, {
	prefillCount = EVENT_STREAM_RETENTION_PREFILL_COUNT,
	evictionCount = EVENT_STREAM_RETENTION_EVICTION_COUNT,
} = {}) {
	const aggregate = new Map();
	for (const line of String(jsonl ?? "").split(/\r?\n/).filter(Boolean)) {
		const snapshot = JSON.parse(line);
		const ws = snapshot?.ws;
		if (!ws || typeof ws !== "object") continue;
		for (const type of [
			EVENT_STREAM_RETENTION_PREFILL_TYPE,
			EVENT_STREAM_RETENTION_EVICTION_TYPE,
			EVENT_STREAM_RETENTION_PROBE_TYPE,
		]) {
			const bucket = ws[`${RETENTION_DIAGNOSTIC_LABEL_PREFIX}${type}`];
			if (!bucket || typeof bucket !== "object") continue;
			const total = aggregate.get(type) ?? {};
			for (const field of ["count", "retainMs", "bufferSize", "retainedBytes"]) {
				const value = bucket[field];
				if (Number.isFinite(value)) total[field] = (total[field] ?? 0) + value;
			}
			aggregate.set(type, total);
		}
	}
	const prefill = aggregate.get(EVENT_STREAM_RETENTION_PREFILL_TYPE) ?? {};
	const eviction = aggregate.get(EVENT_STREAM_RETENTION_EVICTION_TYPE) ?? {};
	const probe = aggregate.get(EVENT_STREAM_RETENTION_PROBE_TYPE) ?? {};
	assert(prefill.count === prefillCount, `Retention prefill diagnostics counted ${prefill.count ?? 0}, expected ${prefillCount}`);
	assert(eviction.count === evictionCount, `Retention eviction diagnostics counted ${eviction.count ?? 0}, expected ${evictionCount}`);
	assert(probe.count === 1, `Retention proof diagnostics counted ${probe.count ?? 0}, expected 1`);
	assert(
		eviction.bufferSize === evictionCount * EVENT_BUFFER_DEFAULT_MAX_SIZE,
		`Retention suffix did not remain at ${EVENT_BUFFER_DEFAULT_MAX_SIZE} entries for every eviction`,
	);
	assert(probe.bufferSize === EVENT_BUFFER_DEFAULT_MAX_SIZE, `Retention proof count was ${probe.bufferSize ?? 0}`);
	assert(Number.isFinite(probe.retainedBytes) && probe.retainedBytes > 0, "Retention proof bytes were unavailable");
	assert(probe.retainedBytes < EVENT_BUFFER_DEFAULT_MAX_BYTES, `Retention proof exceeded the ${EVENT_BUFFER_DEFAULT_MAX_BYTES}-byte budget`);
	assert(Number.isFinite(eviction.retainMs) && eviction.retainMs > 0, "Retention suffix timing was unavailable");
	return {
		metrics: {
			retentionEvictionTotalMs: eviction.retainMs,
			retentionEvictionsPerSecond: (evictionCount * 1_000) / eviction.retainMs,
		},
		proof: {
			prefillEventCount: prefill.count,
			evictionEventCount: eviction.count,
			retainedCount: probe.bufferSize,
			retainedBytes: probe.retainedBytes,
			maxSize: EVENT_BUFFER_DEFAULT_MAX_SIZE,
			maxBytes: EVENT_BUFFER_DEFAULT_MAX_BYTES,
			fullCountWindowForEveryEviction: true,
			belowByteLimit: true,
		},
	};
}

export function createEventStreamSampleWatchdog(options = {}) {
	return createInterruptingSampleWatchdog({
		...options,
		label: "Event-stream sample",
		errorName: "EventStreamSampleTimeoutError",
		phaseLabel: "event-stream",
		phases: EVENT_STREAM_PHASES,
		initialPhase: "prepare",
		timeoutMs: options.timeoutMs ?? EVENT_STREAM_SAMPLE_TIMEOUT_MS,
		graceMs: options.graceMs ?? EVENT_STREAM_WATCHDOG_GRACE_MS,
	});
}

function remainingTimeout(watchdog, capMs = Number.POSITIVE_INFINITY) {
	watchdog.throwIfExpired();
	return Math.max(1, Math.min(capMs, watchdog.remainingMs()));
}

function abortableDelay(delayMs, signal) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = callback => value => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback(value);
		};
		const onAbort = finish(reject);
		const timer = setTimeout(finish(resolve), delayMs);
		if (signal?.aborted) onAbort(signal.reason);
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForValue(read, label, watchdog, maxTimeoutMs = 30_000, intervalMs = 50) {
	const timeoutMs = remainingTimeout(watchdog, maxTimeoutMs);
	const deadline = performance.now() + timeoutMs;
	let lastError;
	while (performance.now() < deadline) {
		watchdog.throwIfExpired();
		try {
			const value = await read(watchdog.signal);
			if (value) return value;
		} catch (error) {
			if (watchdog.signal.aborted) throw watchdog.signal.reason;
			lastError = error;
		}
		await abortableDelay(Math.min(intervalMs, remainingTimeout(watchdog, deadline - performance.now())), watchdog.signal);
	}
	watchdog.throwIfExpired();
	throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message ?? lastError}` : ""}`);
}

async function apiJson(baseUrl, token, apiPath, init = {}) {
	const { timeoutMs = 30_000, signal, ...requestInit } = init;
	const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
	const response = await fetch(new URL(apiPath.replace(/^\//, ""), baseUrl), {
		...requestInit,
		headers: {
			Authorization: `Bearer ${token}`,
			...(requestInit.body ? { "Content-Type": "application/json" } : {}),
			...(requestInit.headers ?? {}),
		},
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});
	const text = await response.text();
	let body = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${apiPath} failed with HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
	}
	return body;
}

async function seedGateway(baseUrl, token, workspace, watchdog) {
	const deadlineInit = () => ({ signal: watchdog.signal, timeoutMs: remainingTimeout(watchdog, 30_000) });
	await apiJson(baseUrl, token, "/api/preferences", {
		...deadlineInit(),
		method: "PUT",
		body: JSON.stringify({
			customProviders: [{
				id: "mock",
				name: "mock",
				type: "manual",
				baseUrl: "http://127.0.0.1",
				models: [{ id: "mock-model", name: "mock-model" }],
			}],
		}),
	});
	await apiJson(baseUrl, token, "/api/preferences", {
		...deadlineInit(),
		method: "PUT",
		body: JSON.stringify({
			"default.sessionModel": "mock/mock-model",
			"default.sessionThinkingLevel": "off",
		}),
	});
	const project = await apiJson(baseUrl, token, "/api/projects", {
		...deadlineInit(),
		method: "POST",
		body: JSON.stringify({
			name: "event-stream-benchmark",
			rootPath: workspace,
			upsert: true,
			acceptCanonical: true,
			seedWorkflows: true,
		}),
	});
	assert(typeof project?.id === "string", "Benchmark project creation returned no id");
	const session = await apiJson(baseUrl, token, "/api/sessions", {
		...deadlineInit(),
		method: "POST",
		body: JSON.stringify({ projectId: project.id, cwd: workspace, worktree: false }),
	});
	assert(typeof session?.id === "string", "Benchmark session creation returned no id");
	return { projectId: project.id, sessionId: session.id };
}

/** Installed before any application script. It observes native WebSocket
 * delivery and DOM commits without modifying, delaying or synthesizing either. */
function installBrowserObserver(config) {
	const NativeWebSocket = window.WebSocket;
	const state = {
		frames: [],
		arrivalByOrdinal: {},
		renderByOrdinal: {},
		longTasks: [],
		longTasksSupported: false,
		frameDeltas: [],
		lastAnimationFrame: null,
		heapInitialBytes: null,
		heapFinalBytes: null,
		heapPeakBytes: null,
		heapSupported: false,
		armed: false,
		finished: false,
		mutationQueued: false,
		observer: null,
		arm() {
			this.frames = [];
			this.arrivalByOrdinal = {};
			this.renderByOrdinal = {};
			this.longTasks = [];
			this.frameDeltas = [];
			this.lastAnimationFrame = null;
			this.finished = false;
			this.armed = true;
			const memory = performance.memory;
			if (memory && Number.isFinite(memory.usedJSHeapSize)) {
				this.heapSupported = true;
				this.heapInitialBytes = memory.usedJSHeapSize;
				this.heapPeakBytes = memory.usedJSHeapSize;
			}
		},
		finish() {
			this.finished = true;
			this.armed = false;
			const memory = performance.memory;
			if (this.heapSupported && memory && Number.isFinite(memory.usedJSHeapSize)) {
				this.heapFinalBytes = memory.usedJSHeapSize;
				this.heapPeakBytes = Math.max(this.heapPeakBytes ?? 0, memory.usedJSHeapSize);
			}
			return {
				frames: this.frames,
				arrivalByOrdinal: this.arrivalByOrdinal,
				renderByOrdinal: this.renderByOrdinal,
				longTasks: this.longTasks,
				longTasksSupported: this.longTasksSupported,
				frameDeltas: this.frameDeltas,
				heapInitialBytes: this.heapInitialBytes,
				heapFinalBytes: this.heapFinalBytes,
				heapPeakBytes: this.heapPeakBytes,
				heapSupported: this.heapSupported,
			};
		},
	};
	window.__bobbitEventStreamBenchmark = state;

	class ObservedWebSocket extends NativeWebSocket {
		constructor(url, protocols) {
			super(url, protocols);
			this.addEventListener("message", event => {
				if (!state.armed || typeof event.data !== "string") return;
				let frame;
				try { frame = JSON.parse(event.data); } catch { return; }
				const data = frame?.type === "event" ? frame.data : null;
				if (!data || typeof data.benchmarkEventId !== "string") return;
				const arrivalMs = performance.now();
				const ordinal = Number.isInteger(data.benchmarkOrdinal) ? data.benchmarkOrdinal : null;
				state.frames.push({
					id: data.benchmarkEventId,
					type: data.type,
					seq: Number.isInteger(frame.seq) ? frame.seq : null,
					serverTimestampMs: Number.isFinite(frame.ts) ? frame.ts : null,
					arrivalMs,
					ordinal,
				});
				if (ordinal !== null) state.arrivalByOrdinal[ordinal] = arrivalMs;
			});
		}
	}
	window.WebSocket = ObservedWebSocket;

	try {
		const longTaskObserver = new PerformanceObserver(list => {
			if (!state.armed) return;
			for (const entry of list.getEntries()) {
				state.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
			}
		});
		longTaskObserver.observe({ type: "longtask", buffered: true });
		state.longTasksSupported = true;
	} catch { /* metric is explicitly reported unsupported */ }

	const sampleFrame = now => {
		if (!state.finished) requestAnimationFrame(sampleFrame);
		if (!state.armed) return;
		if (state.lastAnimationFrame !== null) state.frameDeltas.push(now - state.lastAnimationFrame);
		state.lastAnimationFrame = now;
		const memory = performance.memory;
		if (state.heapSupported && memory && Number.isFinite(memory.usedJSHeapSize)) {
			state.heapPeakBytes = Math.max(state.heapPeakBytes ?? 0, memory.usedJSHeapSize);
		}
	};
	requestAnimationFrame(sampleFrame);

	const inspectMarkers = () => {
		state.mutationQueued = false;
		if (!state.armed) return;
		const text = document.body?.textContent ?? "";
		const committedAt = performance.now();
		for (let ordinal = 1; ordinal <= config.updateCount; ordinal += 1) {
			if (state.renderByOrdinal[ordinal] !== undefined) continue;
			const marker = `${config.markerPrefix}${String(ordinal).padStart(3, "0")}`;
			if (text.includes(marker)) state.renderByOrdinal[ordinal] = committedAt;
		}
	};
	const mutationObserver = new MutationObserver(() => {
		if (!state.armed || state.mutationQueued) return;
		state.mutationQueued = true;
		requestAnimationFrame(inspectMarkers);
	});
	state.observer = mutationObserver;
	const observeDocument = () => {
		mutationObserver.observe(document, { childList: true, subtree: true, characterData: true });
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
	else observeDocument();
}

function normalizedText(value) {
	return String(value ?? "")
		.replace(/\b\d+(?:\.\d+)?s\b/g, "Xs")
		.replace(/\s+/g, " ")
		.trim();
}

export function projectEventStreamFullDom(messages, proposalSpec = EVENT_STREAM_PROPOSAL_SPEC) {
	return (Array.isArray(messages) ? messages : []).map(message => ({
		role: String(message?.role ?? ""),
		text: normalizedText(String(message?.text ?? "").split(proposalSpec).join("")),
	}));
}

function orderedMarkerOccurrences(renderedText, markers) {
	const occurrences = [];
	for (const [markerOrder, marker] of [...new Set(markers)].entries()) {
		let from = 0;
		while (from <= renderedText.length) {
			const index = renderedText.indexOf(marker, from);
			if (index < 0) break;
			occurrences.push({ index, markerOrder, marker });
			from = index + marker.length;
		}
	}
	return occurrences
		.sort((left, right) => left.index - right.index || left.markerOrder - right.markerOrder)
		.map(({ marker }) => marker);
}

export function projectEventStreamMarkers(renderedText, fixture) {
	const primaryMarkers = [
		...fixture.markers,
		...fixture.finalMarkers.flatMap(marker => marker === EVENT_STREAM_ERROR_OUTPUT ? [marker, marker] : [marker]),
	];
	const settlementMarkers = [...fixture.settlementMarkers];
	const allMarkers = [...new Set([...primaryMarkers, ...settlementMarkers])];
	return {
		primary: orderedMarkerOccurrences(renderedText, primaryMarkers),
		settlement: orderedMarkerOccurrences(renderedText, settlementMarkers),
		counts: allMarkers.map(marker => ({ marker, count: renderedText.split(marker).length - 1 })),
	};
}

export function fingerprintEventStreamDom(messages, renderedText, fixture) {
	const fullDomProjection = projectEventStreamFullDom(messages);
	const markerProjection = projectEventStreamMarkers(renderedText, fixture);
	return {
		fullDomProjection,
		markerProjection,
		fullDomHash: sha256(fullDomProjection),
		markerHash: sha256(markerProjection),
	};
}

export function assertEventStreamLiveReloadParity(live, refreshed) {
	if (live.fullDomHash !== refreshed.fullDomHash) {
		const mismatch = Array.from({ length: Math.max(live.fullDomProjection.length, refreshed.fullDomProjection.length) }, (_, index) => ({
			index,
			live: live.fullDomProjection[index] ?? null,
			refreshed: refreshed.fullDomProjection[index] ?? null,
		})).find(row => !isDeepStrictEqual(row.live, row.refreshed));
		throw new Error(`Live full DOM fingerprint ${live.fullDomHash} did not match refresh ${refreshed.fullDomHash}; first mismatch ${JSON.stringify(mismatch)}`);
	}
	assert(live.markerHash === refreshed.markerHash, `Live marker fingerprint ${live.markerHash} did not match refresh ${refreshed.markerHash}`);
}

async function settleAndFingerprint(page, fixture, capturedRenderedText, watchdog) {
	const { trigger } = fixture;
	watchdog?.throwIfExpired();
	const renderedText = capturedRenderedText ?? normalizedText(await page.evaluate(() => document.body?.textContent ?? ""));
	watchdog?.throwIfExpired();
	await page.evaluate(async () => {
		const deferred = window.DeferredBlock;
		if (deferred?.forceResolveAll) {
			deferred.forceResolveAll();
			await Promise.all(Array.from(deferred.instances ?? []).map(instance => instance.updateComplete ?? Promise.resolve()));
		}
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	watchdog?.throwIfExpired();
	const result = await page.evaluate(({ selector, trigger }) => {
		const normalize = value => String(value ?? "")
			.replace(/\b\d+(?:\.\d+)?s\b/g, "Xs")
			.replace(/\s+/g, " ")
			.trim();
		const semanticPayload = value => {
			if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
			if (Array.isArray(value)) return value.map(semanticPayload);
			if (!value || typeof value !== "object") return null;
			return Object.fromEntries(Object.keys(value).sort().map(key => [key, semanticPayload(value[key])]));
		};
		const semanticMessage = message => ({
			id: typeof message?.id === "string" && message.id.startsWith("benchmark-") ? message.id : null,
			role: message?.role ?? null,
			content: Array.isArray(message?.content) ? message.content.map(block => ({
				type: block?.type ?? null,
				text: typeof block?.text === "string" ? block.text : null,
				id: block?.id ?? block?.toolCallId ?? null,
				name: block?.name ?? block?.toolName ?? null,
				arguments: semanticPayload(block?.arguments),
				input: semanticPayload(block?.input),
			})) : [],
			toolCallId: message?.toolCallId ?? null,
			toolName: message?.toolName ?? null,
			isError: typeof message?.isError === "boolean" ? message.isError : null,
		});
		const isBenchmarkMessage = (message, projected) => projected.id !== null
			|| (typeof projected.toolCallId === "string" && projected.toolCallId.startsWith("benchmark-"))
			|| projected.content.some(block => (typeof block.id === "string" && block.id.startsWith("benchmark-"))
				|| (typeof block.text === "string" && (block.text === trigger || block.text.includes("BOBBIT_BENCH_"))));
		const nodes = Array.from(document.querySelectorAll(selector));
		const messages = nodes.map(node => ({ role: node.tagName.toLowerCase(), text: normalize(node.textContent) }));
		const app = window.bobbitState ?? window.__bobbitState;
		const remote = app?.remoteAgent?.state ?? {};
		const semanticProjection = Array.isArray(remote.messages) ? remote.messages
			.map(message => ({ message, projected: semanticMessage(message) }))
			.filter(({ message, projected }) => isBenchmarkMessage(message, projected))
			.map(({ projected }) => projected) : [];
		const textarea = document.querySelector("message-editor textarea");
		const streamingContainer = document.querySelector("streaming-message-container");
		return {
			messages,
			semanticProjection,
			transcriptText: normalize(nodes.map(node => node.textContent ?? "").join(" ")),
			streamingMessageVisible: Boolean(streamingContainer?.querySelector("assistant-message")),
			streamingActive: streamingContainer?.isStreaming === true,
			streamingTimerVisible: Boolean(streamingContainer?.querySelector("live-timer")),
			pendingToolCount: remote.pendingToolCalls?.size ?? (Array.isArray(remote.pendingToolCalls) ? remote.pendingToolCalls.length : 0),
			status: remote.status ?? null,
			editorEnabled: textarea instanceof HTMLTextAreaElement && !textarea.disabled,
		};
	}, { selector: MESSAGE_SELECTOR, trigger });
	const fingerprints = fingerprintEventStreamDom(result.messages, renderedText, fixture);
	return {
		...result,
		...fingerprints,
		renderedText,
		semanticHash: sha256(result.semanticProjection),
	};
}

export function frameCadenceMetrics(frameDeltas) {
	const gaps = frameDeltas.filter(value => Number.isFinite(value) && value > 0);
	if (gaps.length === 0) return { estimatedRefreshMs: null, slowFrames: null, droppedFrames: null };
	const sorted = [...gaps].sort((a, b) => a - b);
	const estimationCount = Math.min(32, Math.max(1, Math.ceil(sorted.length / 2)));
	const lowEndCadence = sorted.slice(0, estimationCount);
	const estimatedRefreshMs = lowEndCadence[Math.floor(lowEndCadence.length / 2)];
	const slow = gaps.filter(value => value > estimatedRefreshMs * 1.5);
	const droppedFrames = slow.reduce((total, value) => total + Math.max(0, Math.round(value / estimatedRefreshMs) - 1), 0);
	return { estimatedRefreshMs, slowFrames: slow.length, droppedFrames };
}

export function longTaskMetrics(longTasks, supported) {
	if (!supported) {
		return { count: null, totalMs: null, maxMs: null, reliability: "unsupported" };
	}
	const durations = (Array.isArray(longTasks) ? longTasks : [])
		.map(task => task?.durationMs)
		.filter(Number.isFinite);
	return {
		count: durations.length,
		totalMs: durations.reduce((sum, value) => sum + value, 0),
		maxMs: durations.length ? Math.max(...durations) : 0,
		reliability: "browser-api",
	};
}

function assertFixtureFrames(observed, expected) {
	assert(observed.length === expected.length, `Expected ${expected.length} tagged events, received ${observed.length}`);
	for (let index = 0; index < expected.length; index += 1) {
		const actual = observed[index];
		const oracle = expected[index];
		assert(actual.id === oracle.id, `Event identity mismatch at ${index}: ${actual.id} != ${oracle.id}`);
		assert(actual.type === oracle.type, `Event type mismatch at ${index}: ${actual.type} != ${oracle.type}`);
		assert(actual.ordinal === oracle.ordinal, `Event ordinal mismatch at ${index}`);
		assert(Number.isInteger(actual.seq), `Event ${actual.id} did not carry a server sequence`);
		if (index > 0) {
			assert(actual.seq === observed[index - 1].seq + 1, `Event sequence gap or duplicate: ${observed[index - 1].seq} -> ${actual.seq}`);
		}
	}
}

export function assertExpectedFinalSemanticState(snapshot, fixture, label = "Final") {
	const actual = snapshot?.semanticProjection;
	assert(Array.isArray(actual), `${label} semantic projection was unavailable`);
	const actualCounts = eventStreamSemanticCounts(actual);
	assert(
		isDeepStrictEqual(actualCounts, fixture.expectedFinalSemanticCounts),
		`${label} semantic counts ${JSON.stringify(actualCounts)} did not match fixture ${JSON.stringify(fixture.expectedFinalSemanticCounts)}`,
	);
	const actualToolPairs = eventStreamToolPairs(actual);
	assert(
		isDeepStrictEqual(actualToolPairs, fixture.expectedToolPairs),
		`${label} tool pairs ${JSON.stringify(actualToolPairs)} did not match fixture ${JSON.stringify(fixture.expectedToolPairs)}`,
	);
	if (!isDeepStrictEqual(actual, fixture.expectedFinalSemanticProjection)) {
		const expected = fixture.expectedFinalSemanticProjection;
		const mismatch = Array.from({ length: Math.max(actual.length, expected.length) }, (_, index) => ({
			index,
			actual: actual[index] ?? null,
			expected: expected[index] ?? null,
		})).find(row => !isDeepStrictEqual(row.actual, row.expected));
		throw new Error(`${label} semantic projection did not match fixture ${fixture.expectedFinalSemanticHash}; first mismatch ${JSON.stringify(mismatch).slice(0, 1_500)}`);
	}
}

export function assertFinalState(snapshot, fixture, label = "Final") {
	assert(snapshot.status === "idle", `${label} client status was ${snapshot.status}, expected idle`);
	assert(snapshot.pendingToolCount === 0, `${label} UI retained ${snapshot.pendingToolCount} pending tools`);
	assert(!snapshot.streamingMessageVisible, `${label} UI retained an assistant message in the streaming container`);
	assert(!snapshot.streamingActive, `${label} streaming container remained active after agent settlement`);
	assert(!snapshot.streamingTimerVisible, `${label} UI retained a live streaming timer after agent settlement`);
	assert(snapshot.editorEnabled, `${label} message editor was not enabled`);
	const expectedRenderedMarkers = [
		...fixture.markers,
		...fixture.finalMarkers.flatMap(marker => marker === EVENT_STREAM_ERROR_OUTPUT ? [marker, marker] : [marker]),
	];
	const expectedMarkerProjection = {
		primary: expectedRenderedMarkers,
		settlement: [...fixture.settlementMarkers],
		counts: [...new Set([...expectedRenderedMarkers, ...fixture.settlementMarkers])].map(marker => ({
			marker,
			count: expectedRenderedMarkers.filter(value => value === marker).length
				+ fixture.settlementMarkers.filter(value => value === marker).length,
		})),
	};
	const actualMarkerProjection = snapshot.markerProjection ?? projectEventStreamMarkers(snapshot.renderedText, fixture);
	assert(
		isDeepStrictEqual(actualMarkerProjection, expectedMarkerProjection),
		`${label} UI marker projection omitted, duplicated, or reordered fixture markers`,
	);
	assertExpectedFinalSemanticState(snapshot, fixture, label);
}

function boundedErrorMessage(error) {
	return String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, 1_000);
}

export async function cleanupEventStreamSample({ browser, gateway, baseUrl, token }, {
	closeBrowser = closeBenchmarkBrowser,
	stopRuntime = stopGateway,
} = {}) {
	const errors = [];
	try {
		await closeBrowser(browser);
	} catch (error) {
		const cause = sanitizeBenchmarkError(error, { runtime: gateway, redactions: [token] });
		errors.push(new Error(`Browser cleanup failed: ${cause.message}`, { cause }));
	}
	try {
		await stopRuntime(gateway, { baseUrl, token });
	} catch (error) {
		const cause = sanitizeBenchmarkError(error, { runtime: gateway, redactions: [token] });
		errors.push(new Error(`Gateway cleanup failed: ${cause.message}`, { cause }));
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) {
		throw new AggregateError(errors, `Event-stream cleanup failed: ${errors.map(error => error.message).join("; ")}`);
	}
}

async function waitForSessionIdle(baseUrl, token, sessionId, watchdog) {
	return waitForValue(async signal => {
		const session = await apiJson(baseUrl, token, `/api/sessions/${encodeURIComponent(sessionId)}`, {
			signal,
			timeoutMs: remainingTimeout(watchdog, 30_000),
		});
		return session?.status === "idle" ? session : null;
	}, `session ${sessionId} to become idle`, watchdog, 30_000, 100);
}

export async function runEventStreamSample(context, entry, fixture, fixtureRoot, {
	timeoutMs = EVENT_STREAM_SAMPLE_TIMEOUT_MS,
	watchdogGraceMs = EVENT_STREAM_WATCHDOG_GRACE_MS,
	watchdogDependencies = {},
	retentionFixture = createEventStreamRetentionFixture(),
	closeBrowser = closeBenchmarkBrowser,
	stopRuntime = stopGateway,
} = {}) {
	const watchdog = createEventStreamSampleWatchdog({ timeoutMs, graceMs: watchdogGraceMs, ...watchdogDependencies });
	let gateway;
	let browser;
	let token;
	let baseUrl;
	let workspace;
	let secretsDir;
	let cpuDiagnosticsPath;
	let sampleResult;
	let sampleError;
	let cleanupError;
	const cleanupOwnedResources = async () => {
		const errors = [];
		const resources = watchdog.resources();
		if (resources.browserRuntime) {
			try {
				await closeBrowser(resources.browserRuntime);
				watchdog.registerBrowser(null);
			} catch (error) {
				errors.push(sanitizeBenchmarkError(error, { runtime: resources.gatewayRuntime, redactions: [token] }));
			}
		}
		if (resources.gatewayRuntime) {
			try {
				await stopRuntime(resources.gatewayRuntime, { baseUrl, token });
				watchdog.registerGateway(null);
			} catch (error) {
				errors.push(sanitizeBenchmarkError(error, { runtime: resources.gatewayRuntime, redactions: [token] }));
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Event-stream browser and gateway cleanup failed");
	};
	context.deferCleanup?.(cleanupOwnedResources);
	try {
		const sampleRoot = await context.createSampleRoot(entry, { fixtureRoot });
		workspace = path.join(sampleRoot, "fixture", "project");
		const gatewayDir = path.join(sampleRoot, "gateway");
		secretsDir = path.join(sampleRoot, "secrets");
		const agentDir = path.join(sampleRoot, "agent");
		const homeDir = path.join(sampleRoot, "home");
		cpuDiagnosticsPath = path.join(gatewayDir, "event-stream-cpu.jsonl");
		await Promise.all([gatewayDir, secretsDir, agentDir, homeDir].map(directory => mkdir(directory, { recursive: true })));

		const port = await getFreePort();
		baseUrl = `http://127.0.0.1:${port}/`;
		token = await createBenchmarkGatewayToken(secretsDir);
		gateway = spawnGateway({
			args: eventStreamGatewayArgs(context.repoRoot, workspace, port),
			cwd: context.repoRoot,
			redactions: [token],
			env: {
				...process.env,
				NODE_ENV: "test",
				NO_COLOR: "1",
				BOBBIT_DIR: gatewayDir,
				BOBBIT_SECRETS_DIR: secretsDir,
				BOBBIT_AGENT_DIR: agentDir,
				BOBBIT_SKIP_MCP: "1",
				BOBBIT_SKIP_WORKTREE_POOL: "1",
				BOBBIT_SKIP_TITLE_GEN: "1",
				BOBBIT_SKIP_AIGW_DISCOVERY: "1",
				BOBBIT_SKIP_NPM_CI: "1",
				BOBBIT_TEST_NO_EXTERNAL: "1",
				BOBBIT_TEST_NO_REMOTE: "1",
				BOBBIT_NO_OPEN: "1",
				BOBBIT_CPU_DIAG: "1",
				BOBBIT_CPU_DIAG_FLUSH_MS: "250",
				BOBBIT_CPU_DIAG_JSONL: cpuDiagnosticsPath,
				HOME: homeDir,
				USERPROFILE: homeDir,
			},
		});
		watchdog.registerGateway(gateway);
		await waitForGatewayReady({
			runtime: gateway,
			baseUrl,
			token,
			timeoutMs: remainingTimeout(watchdog),
			signal: watchdog.signal,
		});
		const { sessionId } = await seedGateway(baseUrl, token, workspace, watchdog);
		await waitForSessionIdle(baseUrl, token, sessionId, watchdog);

		browser = await launchBenchmarkBrowser({
			viewport: EVENT_STREAM_VIEWPORT,
			launchOptions: {
				args: ["--enable-precise-memory-info"],
				timeout: remainingTimeout(watchdog),
			},
			registerRuntime: runtime => watchdog.registerBrowser(runtime),
		});
		watchdog.throwIfExpired();
		await browser.page.addInitScript(installBrowserObserver, {
			updateCount: fixture.updateCount,
			markerPrefix: EVENT_STREAM_MARKER_PREFIX,
		});
		await browser.page.goto(`${baseUrl}?token=${encodeURIComponent(token)}#/session/${encodeURIComponent(sessionId)}`, {
			waitUntil: "domcontentloaded",
			timeout: remainingTimeout(watchdog, 30_000),
		});
		await browser.page.locator("body[data-shortcuts-ready='1']").waitFor({ state: "visible", timeout: remainingTimeout(watchdog, 30_000) });
		await browser.page.locator("message-editor textarea").first().waitFor({ state: "visible", timeout: remainingTimeout(watchdog, 20_000) });
		await browser.page.waitForFunction(id => {
			const app = window.bobbitState ?? window.__bobbitState;
			return app?.selectedSessionId === id && app?.remoteAgent?.state?.status === "idle";
		}, sessionId, { timeout: remainingTimeout(watchdog, 20_000) });

		watchdog.setPhase("saturate");
		await browser.page.evaluate(trigger => {
			const app = window.bobbitState ?? window.__bobbitState;
			if (!app?.remoteAgent?.prompt) throw new Error("Active production RemoteAgent was unavailable");
			return app.remoteAgent.prompt(trigger);
		}, retentionFixture.trigger);
		await waitForSessionIdle(baseUrl, token, sessionId, watchdog);
		await browser.page.waitForFunction(() => {
			const app = window.bobbitState ?? window.__bobbitState;
			const remote = app?.remoteAgent?.state;
			return remote?.status === "idle" && remote?.isStreaming !== true;
		}, undefined, { timeout: remainingTimeout(watchdog, 30_000) });

		watchdog.setPhase("stream");
		watchdog.throwIfExpired();
		await browser.page.evaluate(() => window.__bobbitEventStreamBenchmark.arm());
		const sampleStartedAt = performance.now();
		await browser.page.evaluate(trigger => {
			const app = window.bobbitState ?? window.__bobbitState;
			if (!app?.remoteAgent?.prompt) throw new Error("Active production RemoteAgent was unavailable");
			return app.remoteAgent.prompt(trigger);
		}, fixture.trigger);
		await browser.page.waitForFunction(done => document.body?.textContent?.includes(done), `${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`, {
			timeout: remainingTimeout(watchdog, 30_000),
		});
		await waitForSessionIdle(baseUrl, token, sessionId, watchdog);
		await browser.page.waitForFunction(() => {
			const app = window.bobbitState ?? window.__bobbitState;
			const remote = app?.remoteAgent?.state;
			return remote?.status === "idle" && remote?.isStreaming !== true;
		}, undefined, { timeout: remainingTimeout(watchdog, 20_000) });
		const liveMarkerSnapshot = await browser.page.waitForFunction(markers => {
			const text = document.body?.textContent ?? "";
			return markers.every(marker => text.includes(marker)) ? text : false;
		}, [...fixture.finalMarkers, ...fixture.settlementMarkers], { timeout: remainingTimeout(watchdog, 20_000) });
		const liveRenderedText = normalizedText(await liveMarkerSnapshot.jsonValue());
		await browser.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const observed = await browser.page.evaluate(() => window.__bobbitEventStreamBenchmark.finish());
		const elapsedMs = performance.now() - sampleStartedAt;
		const live = await settleAndFingerprint(browser.page, fixture, liveRenderedText, watchdog);

		watchdog.setPhase("oracle");
		watchdog.throwIfExpired();
		assertFixtureFrames(observed.frames, fixture.expectedFrames);
		assertFinalState(live, fixture, "Live final");
		const committedLatencies = [];
		for (let ordinal = 1; ordinal <= fixture.updateCount; ordinal += 1) {
			const arrival = observed.arrivalByOrdinal[ordinal];
			const rendered = observed.renderByOrdinal[ordinal];
			assert(Number.isFinite(arrival), `Missing browser arrival timestamp for ordinal ${ordinal}`);
			assert(Number.isFinite(rendered), `Ordinal ${ordinal} never committed to the DOM`);
			assert(rendered >= arrival, `Ordinal ${ordinal} rendered before its WebSocket arrival`);
			committedLatencies.push(rendered - arrival);
		}

		await browser.page.reload({ waitUntil: "domcontentloaded", timeout: remainingTimeout(watchdog, 30_000) });
		await browser.page.locator("message-editor textarea").first().waitFor({ state: "visible", timeout: remainingTimeout(watchdog, 20_000) });
		await browser.page.waitForFunction(done => document.body?.textContent?.includes(done), `${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`, {
			timeout: remainingTimeout(watchdog, 20_000),
		});
		const refreshedMarkerSnapshot = await browser.page.waitForFunction(markers => {
			const text = document.body?.textContent ?? "";
			return markers.every(marker => text.includes(marker)) ? text : false;
		}, [...fixture.finalMarkers, ...fixture.settlementMarkers], { timeout: remainingTimeout(watchdog, 20_000) });
		const refreshedRenderedText = normalizedText(await refreshedMarkerSnapshot.jsonValue());
		const refreshed = await settleAndFingerprint(browser.page, fixture, refreshedRenderedText, watchdog);
		assertFinalState(refreshed, fixture, "Refreshed final");
		assertEventStreamLiveReloadParity(live, refreshed);
		assert(live.semanticHash === refreshed.semanticHash, `Live semantic fingerprint ${live.semanticHash} did not match refresh ${refreshed.semanticHash}`);

		const firstArrival = observed.frames[0]?.arrivalMs;
		const lastArrival = observed.frames.at(-1)?.arrivalMs;
		const deliveryWindowMs = Number.isFinite(firstArrival) && Number.isFinite(lastArrival)
			? Math.max(0.001, lastArrival - firstArrival)
			: elapsedMs;
		const cadence = frameCadenceMetrics(observed.frameDeltas);
		const longTasks = longTaskMetrics(observed.longTasks, observed.longTasksSupported);
		const heapGrowthBytes = observed.heapSupported
			? observed.heapFinalBytes - observed.heapInitialBytes
			: null;
		const browserVersion = browser.browser.version();
		sampleResult = {
			sample: {
				case: entry.case,
				phase: entry.phase,
				cycle: entry.cycle,
				caseOrder: entry.caseOrder,
				order: entry.order,
				metrics: {
					eventToRenderP95Ms: p95(committedLatencies),
					eventThroughputPerSecond: (observed.frames.length * 1_000) / deliveryWindowMs,
					elapsedMs,
					slowFrames: cadence.slowFrames,
					droppedFrames: cadence.droppedFrames,
					longTaskCount: longTasks.count,
					longTaskTotalMs: longTasks.totalMs,
					longTaskMaxMs: longTasks.maxMs,
					heapGrowthBytes,
					peakHeapBytes: observed.heapSupported ? observed.heapPeakBytes : null,
				},
				eventToRenderLatenciesMs: committedLatencies,
				correctness: {
					expectedEventCount: fixture.expectedFrames.length,
					receivedEventCount: observed.frames.length,
					committedOrdinalCount: committedLatencies.length,
					firstSeq: observed.frames[0]?.seq ?? null,
					lastSeq: observed.frames.at(-1)?.seq ?? null,
					liveFullDomHash: live.fullDomHash,
					refreshFullDomHash: refreshed.fullDomHash,
					liveMarkerHash: live.markerHash,
					refreshMarkerHash: refreshed.markerHash,
					liveSemanticHash: live.semanticHash,
					refreshSemanticHash: refreshed.semanticHash,
					expectedSemanticHash: fixture.expectedFinalSemanticHash,
					semanticCounts: fixture.expectedFinalSemanticCounts,
				},
				metricReliability: {
					eventToRender: "reliable",
					frameCadence: cadence.estimatedRefreshMs === null ? "unsupported" : "estimated",
					longTasks: longTasks.reliability,
					heapGrowth: observed.heapSupported ? "chromium-precise-memory" : "unsupported",
					peakHeap: observed.heapSupported ? "chromium-precise-memory-lower-confidence-peak-sampling" : "unsupported",
				},
			},
			browserVersion,
			metricSupport: {
				longTasks: observed.longTasksSupported,
				frameCadence: cadence.estimatedRefreshMs !== null,
				heap: observed.heapSupported,
			},
		};
	} catch (error) {
		const redactions = [token];
		const sanitizedError = sanitizeBenchmarkError(error, { runtime: gateway, redactions });
		const reported = watchdog.timedOut
			? sanitizeBenchmarkError(watchdog.error, { runtime: gateway, redactions })
			: sanitizedError;
		const rawDetail = gateway ? gateway.stderr.text() || gateway.stdout.text() : "";
		const detail = sanitizeBenchmarkDiagnosticText(rawDetail, {
			maximumBytes: 2_000,
			redactions: [...(gateway?.diagnosticRedactions ?? []), token],
		}).text.replace(/\s+/g, " ").trim();
		sampleError = new Error(`${reported.message}${detail ? `; gateway log tail: ${detail}` : ""}`, { cause: sanitizedError });
		if (watchdog.timedOut && error !== watchdog.error) {
			sampleError = new AggregateError(
				[sampleError, sanitizedError],
				`Event-stream sample timed out and the active operation also failed: ${sanitizedError.message}`,
			);
		}
	} finally {
		watchdog.setPhase("teardown");
		try {
			await cleanupOwnedResources();
		} catch (error) {
			cleanupError = error;
		}
		try {
			await watchdog.finish();
		} catch (error) {
			const sanitized = sanitizeBenchmarkError(error, { runtime: gateway, redactions: [token] });
			cleanupError = cleanupError ? new AggregateError([cleanupError, sanitized], "Event-stream watchdog cleanup failed") : sanitized;
		}
	}
	if (!sampleError && !cleanupError && sampleResult) {
		try {
			const retention = projectEventStreamRetentionDiagnostics(await readFile(cpuDiagnosticsPath, "utf8"), {
				prefillCount: retentionFixture.prefillCount,
				evictionCount: retentionFixture.evictionCount,
			});
			Object.assign(sampleResult.sample.metrics, retention.metrics);
			sampleResult.sample.retention = retention.proof;
		} catch (error) {
			sampleError = new Error(`Retention diagnostics validation failed: ${boundedErrorMessage(error)}`, { cause: error });
		}
	}
	let failure = null;
	if (sampleError && cleanupError) {
		failure = new AggregateError(
			[sampleError, cleanupError],
			`Event-stream sample and cleanup failed: ${boundedErrorMessage(sampleError)}; ${boundedErrorMessage(cleanupError)}`,
		);
	} else {
		failure = sampleError ?? cleanupError;
	}
	if (failure) throw sanitizeBenchmarkError(failure, { runtime: gateway, redactions: [token] });
	sampleResult.sample.phaseDurationsMs = watchdog.phaseDurationsMs();
	return sampleResult;
}

export async function runJourney(context) {
	const cliPath = path.join(context.repoRoot, CLI_RELATIVE);
	const mockAgentPath = path.join(context.repoRoot, MOCK_AGENT_RELATIVE);
	await Promise.all([
		readFile(cliPath).catch(() => { throw new Error(`Built gateway entrypoint missing: ${cliPath}`); }),
		readFile(mockAgentPath).catch(() => { throw new Error(`Mock agent entrypoint missing: ${mockAgentPath}`); }),
	]);

	const fixture = createEventStreamFixture();
	const retentionFixture = createEventStreamRetentionFixture();
	const fixtureRoot = path.join(context.paths.fixtures, `event-stream-v${EVENT_STREAM_FIXTURE_VERSION}`);
	const projectRoot = path.join(fixtureRoot, "project");
	await mkdir(projectRoot, { recursive: true });
	await Promise.all([
		writeFile(path.join(projectRoot, "README.md"), "# Event stream benchmark fixture\n", "utf8"),
		writeFile(path.join(projectRoot, "AGENTS.md"), "# Benchmark fixture\n", "utf8"),
		writeFile(path.join(fixtureRoot, "manifest.json"), `${JSON.stringify({
			fixtureVersion: EVENT_STREAM_FIXTURE_VERSION,
			updateCount: fixture.updateCount,
			intervalMs: fixture.intervalMs,
			expectedFrames: fixture.expectedFrames,
			expectedFinalSemanticProjection: fixture.expectedFinalSemanticProjection,
			expectedFinalSemanticCounts: fixture.expectedFinalSemanticCounts,
			expectedToolPairs: fixture.expectedToolPairs,
			expectedFinalSemanticHash: fixture.expectedFinalSemanticHash,
			semanticHash: fixture.semanticHash,
			retentionPrefillCount: retentionFixture.prefillCount,
			retentionEvictionCount: retentionFixture.evictionCount,
			retentionSemanticHash: retentionFixture.semanticHash,
		}, null, 2)}\n`, "utf8"),
	]);

	const schedule = context.scheduleFor([CASE_NAME]);
	const samples = [];
	let browserVersion = null;
	for (const entry of schedule) {
		const result = await runEventStreamSample(context, entry, fixture, fixtureRoot, { retentionFixture });
		samples.push(result.sample);
		browserVersion ??= result.browserVersion;
	}
	const metricSupport = {
		eventToRender: aggregateMeasuredReliability(samples, "eventToRender"),
		frameCadence: aggregateMeasuredReliability(samples, "frameCadence"),
		longTasks: aggregateMeasuredReliability(samples, "longTasks"),
		heapGrowth: aggregateMeasuredReliability(samples, "heapGrowth"),
		peakHeap: aggregateMeasuredReliability(samples, "peakHeap"),
	};

	return {
		fixtureDimensions: {
			fixtureVersion: EVENT_STREAM_FIXTURE_VERSION,
			retention: {
				prefillEventCount: retentionFixture.prefillCount,
				evictionEventCount: retentionFixture.evictionCount,
				maxSize: EVENT_BUFFER_DEFAULT_MAX_SIZE,
				maxBytes: EVENT_BUFFER_DEFAULT_MAX_BYTES,
			},
			cases: [{
				name: CASE_NAME,
				updateCount: EVENT_STREAM_UPDATE_COUNT,
				intervalMs: EVENT_STREAM_INTERVAL_MS,
				taggedEventCount: fixture.expectedFrames.length,
				finalSemanticMessageCount: fixture.expectedFinalSemanticCounts.messageCount,
			}],
			viewport: EVENT_STREAM_VIEWPORT,
		},
		fixtureHashes: {
			eventSequenceSha256: fixture.semanticHash,
			finalSemanticProjectionSha256: fixture.expectedFinalSemanticHash,
			retentionSequenceSha256: retentionFixture.semanticHash,
		},
		samples,
		metricDefinitions: {
			retentionEvictionTotalMs: { unit: "ms", direction: "lower", reliability: "node-perf-hooks-production-path" },
			retentionEvictionsPerSecond: { unit: "events/s", direction: "higher", reliability: "derived-from-node-perf-hooks-production-path" },
			eventToRenderP95Ms: { unit: "ms", direction: "lower", reliability: metricSupport.eventToRender },
			eventThroughputPerSecond: { unit: "events/s", direction: "higher", reliability: metricSupport.eventToRender },
			elapsedMs: { unit: "ms", direction: "lower", reliability: metricSupport.eventToRender },
			slowFrames: { unit: "count", direction: "lower", reliability: metricSupport.frameCadence },
			droppedFrames: { unit: "count", direction: "lower", reliability: metricSupport.frameCadence },
			longTaskCount: { unit: "count", direction: "lower", reliability: metricSupport.longTasks },
			longTaskTotalMs: { unit: "ms", direction: "lower", reliability: metricSupport.longTasks },
			longTaskMaxMs: { unit: "ms", direction: "lower", reliability: metricSupport.longTasks },
			heapGrowthBytes: { unit: "bytes", direction: "lower", reliability: metricSupport.heapGrowth },
			peakHeapBytes: { unit: "bytes", direction: "lower", reliability: metricSupport.peakHeap },
		},
		environment: {
			browser: browserVersion ? `Chromium ${browserVersion}` : null,
			viewport: EVENT_STREAM_VIEWPORT,
			metricSupport,
		},
		correctness: {
			status: "passed",
			samplesPassed: samples.length,
			retentionSamplesPassed: samples.filter(sample => sample.retention?.fullCountWindowForEveryEviction && sample.retention?.belowByteLimit).length,
			expectedEventsPerSample: fixture.expectedFrames.length,
			fixtureSemanticHash: fixture.semanticHash,
			expectedFinalSemanticHash: fixture.expectedFinalSemanticHash,
			expectedFinalSemanticCounts: fixture.expectedFinalSemanticCounts,
			liveRefreshParity: true,
		},
		interpretation: "Validate retention saturation and event/live-refresh parity first. Compare direct lower retention-eviction time and higher derived throughput before treating browser metric movement as meaningful.",
		limitations: [
			"Direct retention timing sums the production emitSessionEvent push interval for a fixed tagged suffix; per-call performance.now overhead is shared by baseline and candidate.",
			"Slow and dropped frames are estimates derived from requestAnimationFrame cadence, not compositor telemetry.",
			"Long-task and heap metrics are reported only when Chromium exposes their browser APIs; unsupported values remain null. peakHeapBytes is the largest periodic precise-memory sample, so it is a sampled lower bound rather than a true high-water mark.",
			"Mutation-to-animation-frame timing measures the first committed DOM containing each cumulative marker; superseded updates remain present in protocol counts.",
		],
		noiseSources: [
			"Browser scheduling, display refresh cadence, garbage collection, CPU frequency scaling, antivirus scanning, and concurrent host load.",
		],
		comparisonMethod: "Run baseline and candidate with this identical harness on the same host, Node/Chromium version, viewport and fixture hashes; alternate revisions, confirm saturation/parity proofs, then inspect raw samples, median, p95, min/max/range, MAD and coefficient of variation.",
	};
}
