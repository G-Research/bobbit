import { createHash } from "node:crypto";

export const EVENT_STREAM_FIXTURE_VERSION = 2;
export const EVENT_STREAM_UPDATE_COUNT = 48;
export const EVENT_STREAM_INTERVAL_MS = 12;
export const EVENT_STREAM_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const EVENT_STREAM_MARKER_PREFIX = "BOBBIT_BENCH_STREAM_";
export const EVENT_STREAM_DONE_MARKER = "BOBBIT_BENCH_STREAM_DONE";
export const EVENT_STREAM_PROPOSAL_TITLE = "Bobbit Event Stream Benchmark";
export const EVENT_STREAM_PROPOSAL_SPEC = "Deterministic proposal emitted by the event-stream benchmark fixture.";
export const EVENT_STREAM_TOOL_OUTPUT = "BOBBIT_BENCH_TOOL_OK";
export const EVENT_STREAM_ERROR_OUTPUT = "BOBBIT_BENCH_TOOL_ERROR";
export const EVENT_STREAM_RETENTION_PREFILL_COUNT = 1_000;
export const EVENT_STREAM_RETENTION_EVICTION_COUNT = 20_000;
export const EVENT_STREAM_RETENTION_TRIGGER_UPDATE_COUNT = 200;
export const EVENT_STREAM_RETENTION_TRIGGER_INTERVAL_MS = 997;
export const EVENT_STREAM_RETENTION_PREFILL_TYPE = "benchmark_retention_prefill";
export const EVENT_STREAM_RETENTION_EVICTION_TYPE = "benchmark_retention_evict";
export const EVENT_STREAM_RETENTION_PROBE_TYPE = "benchmark_retention_probe";

function boundedInteger(value, label, minimum, maximum) {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

export function streamMarker(ordinal) {
	return `${EVENT_STREAM_MARKER_PREFIX}${String(ordinal).padStart(3, "0")}`;
}

function taggedEvent(index, type, data, extra = {}) {
	return {
		data: {
			type,
			...data,
			benchmarkEventId: `benchmark-event-${String(index).padStart(3, "0")}`,
			...extra,
		},
		delayAfterMs: 0,
		persistMessage: false,
	};
}

function semanticPayload(value) {
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
	if (Array.isArray(value)) return value.map(semanticPayload);
	if (!value || typeof value !== "object") return null;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, semanticPayload(value[key])]));
}

export function eventStreamSemanticMessage(message) {
	return {
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
	};
}

export function eventStreamSemanticCounts(projection) {
	const messages = Array.isArray(projection) ? projection : [];
	const content = messages.flatMap(message => Array.isArray(message?.content) ? message.content : []);
	const toolResults = messages.filter(message => message?.role === "toolResult");
	return {
		messageCount: messages.length,
		roles: {
			user: messages.filter(message => message?.role === "user").length,
			assistant: messages.filter(message => message?.role === "assistant").length,
			toolResult: toolResults.length,
		},
		toolCallCount: content.filter(block => block?.type === "toolCall").length,
		toolResultCount: toolResults.length,
		successfulToolResultCount: toolResults.filter(message => message?.isError === false).length,
		errorToolResultCount: toolResults.filter(message => message?.isError === true).length,
	};
}

export function eventStreamToolPairs(projection) {
	const messages = Array.isArray(projection) ? projection : [];
	const calls = new Map();
	for (const message of messages) {
		for (const block of Array.isArray(message?.content) ? message.content : []) {
			if (block?.type === "toolCall" && typeof block.id === "string") calls.set(block.id, block);
		}
	}
	return messages.filter(message => message?.role === "toolResult").map(result => ({
		toolCallId: result.toolCallId,
		toolName: calls.get(result.toolCallId)?.name ?? result.toolName,
		resultMessageId: result.id,
		isError: result.isError,
		output: result.content?.find(block => block?.type === "text")?.text ?? null,
	}));
}

/** Build the benchmark-only saturation phase. The existing mock-agent trigger
 * routes every event through the production emitSessionEvent/EventBuffer path.
 * Prefill and suffix use distinct event types so opt-in CPU diagnostics can
 * isolate only the full-window head-eviction work. */
export function createEventStreamRetentionFixture({
	prefillCount = EVENT_STREAM_RETENTION_PREFILL_COUNT,
	evictionCount = EVENT_STREAM_RETENTION_EVICTION_COUNT,
} = {}) {
	boundedInteger(prefillCount, "prefillCount", EVENT_STREAM_RETENTION_PREFILL_COUNT, 100_000);
	boundedInteger(evictionCount, "evictionCount", 1, 100_000);
	const events = [];
	for (let ordinal = 1; ordinal <= prefillCount; ordinal += 1) {
		events.push({
			data: {
				type: EVENT_STREAM_RETENTION_PREFILL_TYPE,
				benchmarkRetentionPhase: "prefill",
				benchmarkRetentionOrdinal: ordinal,
				payload: "event-buffer-saturation",
			},
			delayAfterMs: 0,
			persistMessage: false,
		});
	}
	for (let ordinal = 1; ordinal <= evictionCount; ordinal += 1) {
		events.push({
			data: {
				type: EVENT_STREAM_RETENTION_EVICTION_TYPE,
				benchmarkRetentionPhase: "eviction",
				benchmarkRetentionOrdinal: ordinal,
				payload: "event-buffer-saturation",
			},
			delayAfterMs: 0,
			persistMessage: false,
		});
	}
	events.push({
		data: {
			type: EVENT_STREAM_RETENTION_PROBE_TYPE,
			benchmarkRetentionPhase: "proof",
			benchmarkRetentionOrdinal: 1,
			payload: "event-buffer-saturation",
		},
		delayAfterMs: 0,
		persistMessage: false,
	});
	const projection = {
		prefillCount,
		evictionCount,
		prefillType: EVENT_STREAM_RETENTION_PREFILL_TYPE,
		evictionType: EVENT_STREAM_RETENTION_EVICTION_TYPE,
		probeType: EVENT_STREAM_RETENTION_PROBE_TYPE,
		payload: "event-buffer-saturation",
		eventSequenceSha256: createHash("sha256").update(JSON.stringify(events.map(entry => entry.data))).digest("hex"),
	};
	return {
		trigger: `BENCHMARK_EVENT_STREAM:${EVENT_STREAM_RETENTION_TRIGGER_UPDATE_COUNT}:${EVENT_STREAM_RETENTION_TRIGGER_INTERVAL_MS}`,
		updateCount: EVENT_STREAM_RETENTION_TRIGGER_UPDATE_COUNT,
		intervalMs: EVENT_STREAM_RETENTION_TRIGGER_INTERVAL_MS,
		events,
		prefillCount,
		evictionCount,
		semanticHash: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
	};
}

/**
 * Build the deterministic test-agent event fixture shared by the benchmark
 * driver and the test-owned mock agent. It contains only production-shape agent
 * events; the gateway still owns sequencing, buffering and WebSocket delivery.
 */
export function createEventStreamFixture({
	updateCount = EVENT_STREAM_UPDATE_COUNT,
	intervalMs = EVENT_STREAM_INTERVAL_MS,
} = {}) {
	boundedInteger(updateCount, "updateCount", 8, 200);
	boundedInteger(intervalMs, "intervalMs", 0, 1_000);
	if (updateCount === EVENT_STREAM_RETENTION_TRIGGER_UPDATE_COUNT
		&& intervalMs === EVENT_STREAM_RETENTION_TRIGGER_INTERVAL_MS) {
		return createEventStreamRetentionFixture();
	}
	const events = [];
	let index = 0;
	const add = (type, data, options = {}) => {
		const entry = taggedEvent(++index, type, data, options.extra);
		entry.delayAfterMs = options.delayAfterMs ?? 0;
		entry.persistMessage = options.persistMessage === true;
		events.push(entry);
	};

	let accumulated = "";
	for (let ordinal = 1; ordinal <= updateCount; ordinal += 1) {
		accumulated += `${ordinal === 1 ? "" : " "}${streamMarker(ordinal)}`;
		add("message_update", {
			message: {
				id: "benchmark-stream-message",
				role: "assistant",
				content: [{ type: "text", text: accumulated }],
			},
		}, { delayAfterMs: intervalMs, extra: { benchmarkOrdinal: ordinal } });
	}
	add("message_end", {
		message: {
			id: "benchmark-stream-message",
			role: "assistant",
			content: [{ type: "text", text: accumulated }],
		},
	}, { persistMessage: true });

	const proposalInput = {
		title: EVENT_STREAM_PROPOSAL_TITLE,
		workflow: "general",
		spec: EVENT_STREAM_PROPOSAL_SPEC,
	};
	add("tool_execution_start", {
		toolName: "propose_goal",
		toolId: "benchmark-proposal-tool",
		input: proposalInput,
	});
	const proposalMessage = {
		id: "benchmark-proposal-message",
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "benchmark-proposal-tool",
			name: "propose_goal",
			arguments: proposalInput,
			input: proposalInput,
		}],
	};
	add("message_update", { message: proposalMessage });
	add("message_end", { message: proposalMessage }, { persistMessage: true });
	add("tool_execution_update", {
		toolId: "benchmark-proposal-tool",
		toolName: "propose_goal",
		status: "complete",
		output: "Proposal submitted.",
	});
	add("tool_execution_end", {
		toolCallId: "benchmark-proposal-tool",
		toolName: "propose_goal",
		isError: false,
	});
	add("message_end", {
		message: {
			id: "benchmark-proposal-result",
			role: "toolResult",
			toolCallId: "benchmark-proposal-tool",
			toolName: "propose_goal",
			isError: false,
			content: [{ type: "text", text: "Proposal submitted." }],
		},
	}, { persistMessage: true });

	const successInput = { path: "benchmark-owned-fixture.txt" };
	add("tool_execution_start", {
		toolName: "Read",
		toolId: "benchmark-success-tool",
		input: successInput,
	});
	const successMessage = {
		id: "benchmark-success-message",
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "benchmark-success-tool",
			name: "Read",
			arguments: successInput,
			input: successInput,
		}],
	};
	add("message_update", { message: successMessage });
	add("message_end", { message: successMessage }, { persistMessage: true });
	add("tool_execution_update", {
		toolId: "benchmark-success-tool",
		toolName: "Read",
		status: "complete",
		output: EVENT_STREAM_TOOL_OUTPUT,
	});
	add("tool_execution_end", {
		toolCallId: "benchmark-success-tool",
		toolName: "Read",
		isError: false,
	});
	add("message_end", {
		message: {
			id: "benchmark-success-result",
			role: "toolResult",
			toolCallId: "benchmark-success-tool",
			toolName: "Read",
			isError: false,
			content: [{ type: "text", text: EVENT_STREAM_TOOL_OUTPUT }],
		},
	}, { persistMessage: true });

	const errorInput = { path: "missing-benchmark-fixture.txt" };
	add("tool_execution_start", {
		toolName: "Read",
		toolId: "benchmark-error-tool",
		input: errorInput,
	});
	const errorMessage = {
		id: "benchmark-error-message",
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "benchmark-error-tool",
			name: "Read",
			arguments: errorInput,
			input: errorInput,
		}],
	};
	add("message_update", { message: errorMessage });
	add("message_end", { message: errorMessage }, { persistMessage: true });
	add("tool_execution_update", {
		toolId: "benchmark-error-tool",
		toolName: "Read",
		status: "complete",
		output: EVENT_STREAM_ERROR_OUTPUT,
	});
	add("tool_execution_end", {
		toolCallId: "benchmark-error-tool",
		toolName: "Read",
		isError: true,
	});
	add("message_end", {
		message: {
			id: "benchmark-error-result",
			role: "toolResult",
			toolCallId: "benchmark-error-tool",
			toolName: "Read",
			isError: true,
			content: [{ type: "text", text: EVENT_STREAM_ERROR_OUTPUT }],
		},
	}, { persistMessage: true });

	add("message_end", {
		message: {
			id: "benchmark-done-message",
			role: "assistant",
			content: [{ type: "text", text: `${EVENT_STREAM_DONE_MARKER}:${updateCount}` }],
		},
	}, { persistMessage: true });

	const expectedFrames = events.map(({ data }) => ({
		id: data.benchmarkEventId,
		type: data.type,
		ordinal: data.benchmarkOrdinal ?? null,
	}));
	const trigger = `BENCHMARK_EVENT_STREAM:${updateCount}:${intervalMs}`;
	const expectedFinalSemanticProjection = [
		eventStreamSemanticMessage({ role: "user", content: [{ type: "text", text: trigger }] }),
		...events
			.filter(entry => entry.persistMessage && entry.data?.message)
			.map(entry => eventStreamSemanticMessage(entry.data.message)),
	];
	const expectedFinalSemanticCounts = eventStreamSemanticCounts(expectedFinalSemanticProjection);
	const expectedToolPairs = [
		{ toolCallId: "benchmark-proposal-tool", toolName: "propose_goal", resultMessageId: "benchmark-proposal-result", isError: false, output: "Proposal submitted." },
		{ toolCallId: "benchmark-success-tool", toolName: "Read", resultMessageId: "benchmark-success-result", isError: false, output: EVENT_STREAM_TOOL_OUTPUT },
		{ toolCallId: "benchmark-error-tool", toolName: "Read", resultMessageId: "benchmark-error-result", isError: true, output: EVENT_STREAM_ERROR_OUTPUT },
	];
	if (JSON.stringify(eventStreamToolPairs(expectedFinalSemanticProjection)) !== JSON.stringify(expectedToolPairs)) {
		throw new Error("Event-stream fixture messages did not satisfy the independent tool pairing oracle");
	}
	const semanticProjection = {
		fixtureVersion: EVENT_STREAM_FIXTURE_VERSION,
		updateCount,
		intervalMs,
		viewport: EVENT_STREAM_VIEWPORT,
		expectedFrames,
		markers: Array.from({ length: updateCount }, (_, offset) => streamMarker(offset + 1)),
		finalMarkers: [
			EVENT_STREAM_PROPOSAL_TITLE,
			EVENT_STREAM_TOOL_OUTPUT,
			EVENT_STREAM_ERROR_OUTPUT,
			`${EVENT_STREAM_DONE_MARKER}:${updateCount}`,
		],
		settlementMarkers: [EVENT_STREAM_PROPOSAL_SPEC],
		expectedFinalSemanticProjection,
		expectedFinalSemanticCounts,
		expectedToolPairs,
	};
	const semanticHash = createHash("sha256")
		.update(JSON.stringify(semanticProjection))
		.digest("hex");
	const expectedFinalSemanticHash = createHash("sha256")
		.update(JSON.stringify(expectedFinalSemanticProjection))
		.digest("hex");

	return {
		trigger,
		updateCount,
		intervalMs,
		events,
		expectedFrames,
		markers: semanticProjection.markers,
		finalMarkers: semanticProjection.finalMarkers,
		settlementMarkers: semanticProjection.settlementMarkers,
		expectedFinalSemanticProjection,
		expectedFinalSemanticCounts,
		expectedToolPairs,
		expectedFinalSemanticHash,
		semanticHash,
	};
}
