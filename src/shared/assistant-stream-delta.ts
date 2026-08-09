/**
 * Prototype wire compaction for Pi's cumulative assistant `message_update`s.
 *
 * The helpers are deliberately pure: callers keep the previously reconstructed
 * message and pass it to the next call. Unsupported or non-convergent shapes
 * are returned unchanged, making it safe to put compaction behind negotiation.
 */

export type JsonObject = Record<string, unknown>;

const COMPACT_VERSION = 1;
const SUPPORTED_TYPES = new Set([
	"start",
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

function isObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	if (Array.isArray(value)) return value.map(clone) as T;
	if (isObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
	}
	return value;
}

function comparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(comparable);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "partialJson")
			.map(([key, item]) => [key, comparable(item)]),
	);
}

function comparableAssistantPartial(value: unknown): unknown {
	const normalized = comparable(value);
	if (!isObject(normalized)) return normalized;
	// Bobbit enriches the visible `event.message` with an author after Pi creates
	// `assistantMessageEvent.partial`. The author is stable stream metadata carried
	// by the baseline, not part of Pi's token delta semantics.
	const { author: _author, ...withoutTransportEnrichment } = normalized;
	return withoutTransportEnrichment;
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left)
			&& Array.isArray(right)
			&& left.length === right.length
			&& left.every((item, index) => deepEqual(item, right[index]));
	}
	if (!isObject(left) || !isObject(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

interface ParseResult {
	value: unknown;
	present: boolean;
}

/**
 * Parse the useful prefix of a progressively streamed JSON object.
 * Incomplete strings and nested containers are retained; an incomplete
 * property with no value is omitted. Invalid input safely becomes `{}`.
 */
export function parsePartialToolArguments(input: string): JsonObject {
	let position = 0;

	const whitespace = () => {
		while (/\s/u.test(input[position] ?? "")) position++;
	};

	const string = (): ParseResult => {
		if (input[position] !== '"') return { value: undefined, present: false };
		position++;
		let value = "";
		while (position < input.length) {
			const character = input[position++]!;
			if (character === '"') return { value, present: true };
			if (character !== "\\") {
				value += character;
				continue;
			}
			if (position >= input.length) break;
			const escaped = input[position++]!;
			const simple: Record<string, string> = {
				'"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
			};
			if (escaped in simple) {
				value += simple[escaped];
			} else if (escaped === "u") {
				const digits = input.slice(position, position + 4);
				if (/^[\da-f]{4}$/iu.test(digits)) {
					value += String.fromCharCode(Number.parseInt(digits, 16));
					position += 4;
				}
			} else {
				// Match Pi's repair behavior for invalid JSON escapes.
				value += `\\${escaped}`;
			}
		}
		return { value, present: true };
	};

	const value = (): ParseResult => {
		whitespace();
		const first = input[position];
		if (first === '"') return string();
		if (first === "{") return object();
		if (first === "[") return array();
		const rest = input.slice(position);
		for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
			if (rest.length > 0 && literal.startsWith(rest)) {
				position = input.length;
				return { value: parsed, present: true };
			}
			if (rest.startsWith(literal)) {
				position += literal.length;
				return { value: parsed, present: true };
			}
		}
		const number = rest.match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d*)?/iu)?.[0];
		if (number) {
			position += number.length;
			const parsed = Number(number.replace(/[eE][+-]?$/u, ""));
			return { value: parsed, present: Number.isFinite(parsed) };
		}
		return { value: undefined, present: false };
	};

	const object = (): ParseResult => {
		if (input[position] !== "{") return { value: undefined, present: false };
		position++;
		const result: JsonObject = {};
		while (position < input.length) {
			whitespace();
			if (input[position] === "}") {
				position++;
				break;
			}
			if (input[position] === ",") {
				position++;
				continue;
			}
			const key = string();
			if (!key.present || typeof key.value !== "string") break;
			whitespace();
			if (input[position] !== ":") break;
			position++;
			const parsed = value();
			if (!parsed.present) break;
			result[key.value] = parsed.value;
			whitespace();
			if (input[position] === ",") position++;
		}
		return { value: result, present: true };
	};

	const array = (): ParseResult => {
		if (input[position] !== "[") return { value: undefined, present: false };
		position++;
		const result: unknown[] = [];
		while (position < input.length) {
			whitespace();
			if (input[position] === "]") {
				position++;
				break;
			}
			if (input[position] === ",") {
				position++;
				continue;
			}
			const parsed = value();
			if (!parsed.present) break;
			result.push(parsed.value);
			whitespace();
			if (input[position] === ",") position++;
		}
		return { value: result, present: true };
	};

	try {
		const parsed = value();
		return parsed.present && isObject(parsed.value) ? parsed.value : {};
	} catch {
		return {};
	}
}

function contentOf(message: JsonObject): unknown[] | undefined {
	return Array.isArray(message.content) ? message.content : undefined;
}

function blockWithout(block: JsonObject, field: string): JsonObject {
	return Object.fromEntries(Object.entries(block).filter(([key]) => key !== field && key !== "partialJson"));
}

function baselineFor(message: JsonObject, assistantEvent: JsonObject): JsonObject | undefined {
	const content = contentOf(message);
	if (!content) return undefined;
	const baseline = clone(message);
	const type = assistantEvent.type;
	if (type === "start") {
		baseline.content = [];
		return content.length === 0 ? baseline : undefined;
	}
	const index = assistantEvent.contentIndex;
	if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= content.length) return undefined;
	const before = clone(content.slice(0, index as number));
	const block = content[index as number];
	if (!isObject(block)) return undefined;

	if (type === "text_delta" || type === "thinking_delta") {
		const field = type === "text_delta" ? "text" : "thinking";
		const current = block[field];
		const delta = assistantEvent.delta;
		if (typeof current !== "string" || typeof delta !== "string" || !current.endsWith(delta)) return undefined;
		before.push({ ...clone(block), [field]: current.slice(0, -delta.length) });
	} else if (type === "text_end" || type === "thinking_end") {
		// A stream observed for the first time at an end event needs the completed
		// block as its baseline. Normal streams already have the preceding delta.
		before.push(clone(block));
	} else if (type === "toolcall_delta") {
		before.push({ ...clone(block), arguments: {}, partialJson: "" });
	}
	baseline.content = before;
	return baseline;
}

function checkpointFor(message: JsonObject, assistantEvent: JsonObject): JsonObject | undefined {
	const content = contentOf(message);
	const index = assistantEvent.contentIndex;
	if (!content || !Number.isInteger(index) || !isObject(content[index as number])) return undefined;
	const block = content[index as number] as JsonObject;
	switch (assistantEvent.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return clone(block);
		case "text_end":
			return blockWithout(block, "text");
		case "thinking_end":
			return blockWithout(block, "thinking");
		default:
			return undefined;
	}
}

function applyDelta(message: JsonObject, assistantEvent: JsonObject, checkpoint?: JsonObject): JsonObject | undefined {
	const next = clone(message);
	const content = contentOf(next);
	if (!content) return undefined;
	const type = assistantEvent.type;
	if (type === "start") return next;
	const index = assistantEvent.contentIndex;
	if (!Number.isInteger(index) || (index as number) < 0) return undefined;
	const at = index as number;
	const existing = content[at];

	switch (type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			if (!checkpoint || at > content.length) return undefined;
			content[at] = clone(checkpoint);
			break;
		case "text_delta":
		case "thinking_delta": {
			if (!isObject(existing) || typeof assistantEvent.delta !== "string") return undefined;
			const field = type === "text_delta" ? "text" : "thinking";
			if (typeof existing[field] !== "string") return undefined;
			content[at] = { ...existing, [field]: `${existing[field]}${assistantEvent.delta}` };
			break;
		}
		case "text_end":
		case "thinking_end": {
			if (!checkpoint || at > content.length) return undefined;
			const field = type === "text_end" ? "text" : "thinking";
			const completed = typeof assistantEvent.content === "string"
				? assistantEvent.content
				: isObject(existing) && typeof existing[field] === "string" ? existing[field] : undefined;
			if (completed === undefined) return undefined;
			content[at] = { ...clone(checkpoint), [field]: completed };
			break;
		}
		case "toolcall_delta": {
			if (!isObject(existing) || typeof assistantEvent.delta !== "string") return undefined;
			const priorJson = typeof existing.partialJson === "string" ? existing.partialJson : "";
			const partialJson = priorJson + assistantEvent.delta;
			content[at] = { ...existing, arguments: parsePartialToolArguments(partialJson), partialJson };
			break;
		}
		case "toolcall_end":
			if (!isObject(assistantEvent.toolCall) || at > content.length) return undefined;
			content[at] = clone(assistantEvent.toolCall);
			break;
		default:
			return undefined;
	}
	return next;
}

/**
 * Remove cumulative `message` and `assistantMessageEvent.partial` snapshots.
 * `previousMessage` is the preceding reconstructed message, when available.
 * A self-contained frame carries that predecessor as its live-only baseline so
 * a recipient that just discarded local reconstruction state can resume safely.
 */
export function compactAssistantStreamDelta(
	event: unknown,
	previousMessage?: unknown,
	options?: { selfContained?: boolean },
): unknown {
	if (!isObject(event) || event.type !== "message_update" || !isObject(event.message)
		|| !isObject(event.assistantMessageEvent) || typeof event.assistantMessageEvent.type !== "string"
		|| !SUPPORTED_TYPES.has(event.assistantMessageEvent.type)
		|| !isObject(event.assistantMessageEvent.partial)
		|| !deepEqual(comparableAssistantPartial(event.message), comparableAssistantPartial(event.assistantMessageEvent.partial))) {
		return event;
	}
	if ("assistantStreamDelta" in event || "assistantMessageBaseline" in event || "assistantBlockCheckpoint" in event) {
		return event;
	}

	const baseline = isObject(previousMessage)
		? clone(previousMessage)
		: baselineFor(event.message, event.assistantMessageEvent);
	if (!baseline) return event;
	const selfContained = options?.selfContained === true;
	const checkpoint = checkpointFor(event.message, event.assistantMessageEvent);
	const { partial: _partial, ...assistantMessageEvent } = event.assistantMessageEvent;
	if (assistantMessageEvent.type === "text_end" || assistantMessageEvent.type === "thinking_end") {
		delete assistantMessageEvent.content;
	}
	const { message: _message, assistantMessageEvent: _originalAssistantEvent, ...outer } = event;
	const compact: JsonObject = {
		...outer,
		assistantMessageEvent,
		assistantStreamDelta: COMPACT_VERSION,
	};
	if (selfContained || !isObject(previousMessage)) compact.assistantMessageBaseline = baseline;
	if (checkpoint) compact.assistantBlockCheckpoint = checkpoint;

	const reconstructed = reconstructAssistantStreamDelta(compact, selfContained ? undefined : previousMessage);
	return isObject(reconstructed)
		&& deepEqual(comparable(reconstructed.message), comparable(event.message))
		&& isObject(reconstructed.assistantMessageEvent)
		&& deepEqual(comparableAssistantPartial(reconstructed.assistantMessageEvent.partial), comparableAssistantPartial(event.assistantMessageEvent.partial))
		? compact
		: event;
}

/** Reconstruct the original cumulative `message_update` from a compact delta. */
export function reconstructAssistantStreamDelta(event: unknown, previousMessage?: unknown): unknown {
	if (!isObject(event) || event.assistantStreamDelta !== COMPACT_VERSION || event.type !== "message_update"
		|| !isObject(event.assistantMessageEvent)) return event;
	const base = isObject(previousMessage)
		? previousMessage
		: isObject(event.assistantMessageBaseline) ? event.assistantMessageBaseline : undefined;
	if (!base) return event;
	const checkpoint = isObject(event.assistantBlockCheckpoint) ? event.assistantBlockCheckpoint : undefined;
	const message = applyDelta(base, event.assistantMessageEvent, checkpoint);
	if (!message) return event;
	const {
		assistantStreamDelta: _version,
		assistantMessageBaseline: _baseline,
		assistantBlockCheckpoint: _checkpoint,
		assistantMessageEvent,
		...outer
	} = event;
	const expandedAssistantEvent = { ...assistantMessageEvent };
	if (expandedAssistantEvent.type === "text_end" || expandedAssistantEvent.type === "thinking_end") {
		const index = expandedAssistantEvent.contentIndex;
		const block = Number.isInteger(index) ? contentOf(message)?.[index as number] : undefined;
		const field = expandedAssistantEvent.type === "text_end" ? "text" : "thinking";
		if (isObject(block) && typeof block[field] === "string") expandedAssistantEvent.content = block[field];
	}
	return {
		...outer,
		message,
		assistantMessageEvent: { ...expandedAssistantEvent, partial: message },
	};
}

/** Return only the cumulative assistant message after applying a delta. */
export function reconstructAssistantStreamMessage(event: unknown, previousMessage?: unknown): unknown {
	const reconstructed = reconstructAssistantStreamDelta(event, previousMessage);
	return isObject(reconstructed) && "message" in reconstructed ? reconstructed.message : undefined;
}
