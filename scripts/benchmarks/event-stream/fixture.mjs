import { createHash } from "node:crypto";

export const EVENT_STREAM_FIXTURE_VERSION = 1;
export const EVENT_STREAM_UPDATE_COUNT = 48;
export const EVENT_STREAM_INTERVAL_MS = 12;
export const EVENT_STREAM_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const EVENT_STREAM_MARKER_PREFIX = "BOBBIT_BENCH_STREAM_";
export const EVENT_STREAM_DONE_MARKER = "BOBBIT_BENCH_STREAM_DONE";
export const EVENT_STREAM_PROPOSAL_TITLE = "Bobbit Event Stream Benchmark";
export const EVENT_STREAM_PROPOSAL_SPEC = "Deterministic proposal emitted by the event-stream benchmark fixture.";
export const EVENT_STREAM_TOOL_OUTPUT = "BOBBIT_BENCH_TOOL_OK";
export const EVENT_STREAM_ERROR_OUTPUT = "BOBBIT_BENCH_TOOL_ERROR";

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
	};
	const semanticHash = createHash("sha256")
		.update(JSON.stringify(semanticProjection))
		.digest("hex");

	return {
		trigger: `BENCHMARK_EVENT_STREAM:${updateCount}:${intervalMs}`,
		updateCount,
		intervalMs,
		events,
		expectedFrames,
		markers: semanticProjection.markers,
		finalMarkers: semanticProjection.finalMarkers,
		settlementMarkers: semanticProjection.settlementMarkers,
		semanticHash,
	};
}
