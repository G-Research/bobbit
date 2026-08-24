import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	aggregateMeasuredReliability,
	closeBenchmarkBrowser,
	createBenchmarkGatewayToken,
	createInterruptingSampleWatchdog,
	getFreePort,
	launchBenchmarkBrowser,
	spawnGateway,
	stopGateway,
	waitForGatewayReady,
} from "./runtime.mjs";

export const SESSION_OPEN_CASES = Object.freeze([
	Object.freeze({ name: "1mb", transcriptBytes: 1_000_000 }),
	Object.freeze({ name: "10mb", transcriptBytes: 10_000_000 }),
	Object.freeze({ name: "25mb", transcriptBytes: 25_000_000 }),
]);
export const SESSION_OPEN_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const SESSION_OPEN_FIXTURE_VERSION = 2;
export const SESSION_OPEN_SAMPLE_TIMEOUT_MS = 180_000;
export const SESSION_OPEN_WATCHDOG_GRACE_MS = 5_000;
export const SESSION_OPEN_PARITY_BATCH_SIZE = 4;
export const SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES = 30 * 1024;
export const SESSION_OPEN_BALLAST_BLOCKS_PER_MESSAGE = 32;

const FIRST_MARKER = "BOBBIT_SESSION_OPEN_FIRST_MARKER";
const LAST_MARKER = "BOBBIT_SESSION_OPEN_LAST_MARKER";
const FIXTURE_TIME_MS = Date.parse("2024-01-01T00:00:00.000Z");
const REALISTIC_CYCLE_COUNT = 8;
const BALLAST_PROSE = " Deterministic plain prose exercises transfer parsing reduction and rendering in stable ordinal order.";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "").join("\n");
}

function normalizedError(message) {
	if (message?.isError === true || message?.is_error === true) return true;
	const text = messageText(message?.content).trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return false;
	try {
		const returned = JSON.parse(text);
		return returned?.isError === true || returned?.is_error === true;
	} catch {
		return false;
	}
}

export function canonicalizeRenderedText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Independent fixture-side projection of the text rows the message components
 * must commit. It intentionally knows only the fixture's small Markdown subset;
 * the browser-side projection is built separately from rendered DOM.
 */
export function projectSessionOpenRenderedText(messages) {
	const projection = [];
	for (const message of messages) {
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type !== "text" || typeof block.text !== "string" || !block.text.trim()) continue;
			const rendered = block.text
				.replace(/^```[^\n]*\n([\s\S]*?)\n```[\t ]*$/gm, "$1")
				.replace(/^ {0,3}#{1,6}[\t ]+/gm, "");
			projection.push({ role: message.role, text: canonicalizeRenderedText(rendered) });
		}
	}
	return projection;
}

/** Return Long Task overlap metrics for exactly one measured browser interval. */
export function measureLongTasksInWindow(entries, windowStart, windowEnd) {
	if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart) {
		throw new RangeError("Long Task measurement window must be finite and ordered");
	}
	const overlaps = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const startTime = entry?.startTime;
		const duration = entry?.duration;
		if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration < 0) continue;
		const overlap = Math.min(windowEnd, startTime + duration) - Math.max(windowStart, startTime);
		if (overlap > 0) overlaps.push(overlap);
	}
	return {
		count: overlaps.length,
		totalMs: overlaps.reduce((sum, duration) => sum + duration, 0),
		maxMs: overlaps.length ? Math.max(...overlaps) : 0,
	};
}

/** Preserve the declared Long Task metric shape when the browser API is unsupported. */
export function sessionOpenLongTaskMetricFields(measurement) {
	return {
		longTaskCount: measurement?.count ?? null,
		longTaskTotalMs: measurement?.totalMs ?? null,
		longTaskMaxMs: measurement?.maxMs ?? null,
	};
}

/** Construct every declared session-open metric, retaining unsupported values as null. */
export function sessionOpenMetricFields({
	timing,
	snapshotFrameBytes,
	heapBefore,
	heapAfterInteractive,
	longTaskMetrics,
}) {
	const heapSamples = [heapBefore, heapAfterInteractive, ...(timing?.heap ?? [])].filter(Number.isFinite);
	const serverTiming = timing?.serverTiming ?? {};
	return {
		timeToInteractiveMs: Number.isFinite(timing?.now) && Number.isFinite(timing?.sent) ? timing.now - timing.sent : null,
		serverResponseLatencyMs: Number.isFinite(timing?.received) && Number.isFinite(timing?.sent) ? timing.received - timing.sent : null,
		transferredBytes: Number.isFinite(snapshotFrameBytes) && snapshotFrameBytes > 0
			? snapshotFrameBytes
			: (Number.isFinite(timing?.snapshotChars) ? timing.snapshotChars : null),
		...sessionOpenLongTaskMetricFields(longTaskMetrics),
		heapGrowthBytes: Number.isFinite(heapBefore) && Number.isFinite(heapAfterInteractive)
			? heapAfterInteractive - heapBefore
			: null,
		heapPeakBytes: heapSamples.length ? Math.max(...heapSamples) : null,
		rpcMs: Number.isFinite(serverTiming.rpcMs) ? serverTiming.rpcMs : null,
		pipelineMs: Number.isFinite(serverTiming.pipelineMs) ? serverTiming.pipelineMs : null,
		stampMs: Number.isFinite(serverTiming.stampMs) ? serverTiming.stampMs : null,
		stringifyMs: Number.isFinite(serverTiming.stringifyMs) ? serverTiming.stringifyMs : null,
	};
}

/** A deliberately small, implementation-independent projection used as the parity oracle. */
export function projectSessionOpenMessages(messages) {
	return messages.map(message => {
		const projected = { id: typeof message?.id === "string" ? message.id : null, role: message?.role ?? null };
		if (Array.isArray(message?.content)) {
			projected.content = message.content.map(block => {
				if (block?.type === "text") return { type: "text", text: block.text ?? "" };
				if (block?.type === "toolCall" || block?.type === "tool_use") {
					return {
						type: "toolCall",
						id: block.id ?? null,
						name: block.name ?? null,
						arguments: block.arguments ?? block.input ?? null,
					};
				}
				return { type: block?.type ?? null };
			});
		}
		if (message?.role === "toolResult" || message?.role === "tool_result" || message?.role === "tool") {
			projected.toolCallId = message.toolCallId ?? message.tool_use_id ?? null;
			projected.toolName = message.toolName ?? message.name ?? null;
			projected.isError = normalizedError(message);
		}
		return projected;
	});
}

function compactionEntries() {
	return [
		{
			schemaVersion: 1,
			id: "c_1704067200000_hist01",
			trigger: "auto",
			tokensBefore: 96_000,
			tokensAfter: 31_000,
			durationMs: 840,
			startedAt: "2024-01-01T00:00:00.000Z",
			endedAt: "2024-01-01T00:00:00.840Z",
			success: true,
			firstKeptEntryId: "entry-000001",
		},
		{
			schemaVersion: 1,
			id: "c_1704067201000_curr01",
			trigger: "manual",
			tokensBefore: 72_000,
			tokensAfter: 28_000,
			durationMs: 620,
			startedAt: "2024-01-01T00:00:01.000Z",
			endedAt: "2024-01-01T00:00:01.620Z",
			success: true,
			firstKeptEntryId: "entry-000001",
		},
	];
}

function syntheticCompactionMessages(entry) {
	const payload = {
		schemaVersion: 1,
		trigger: entry.trigger,
		state: entry.success ? "complete" : "error",
		success: entry.success,
		timestamp: entry.endedAt,
		startedAt: entry.startedAt,
		durationMs: entry.durationMs,
		tokensBefore: entry.tokensBefore,
		tokensAfter: entry.tokensAfter,
		reductionPct: entry.tokensBefore && entry.tokensAfter != null
			? Math.round(((entry.tokensBefore - entry.tokensAfter) / entry.tokensBefore) * 1000) / 10
			: null,
		compactionId: entry.id,
	};
	const toolCallId = `compaction-summary:${entry.id}`;
	return [
		{
			id: entry.id,
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "__compaction_summary", arguments: payload }],
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "__compaction_summary",
			isError: false,
			content: [{ type: "text", text: "ok" }],
		},
	];
}

function fixtureMessage(sequence, role, content, extra = {}) {
	return {
		id: `message-${String(sequence).padStart(6, "0")}`,
		role,
		content,
		timestamp: FIXTURE_TIME_MS + sequence,
		...extra,
	};
}

function transcriptEntry(sequence, parentId, message) {
	return {
		type: "message",
		id: `entry-${String(sequence).padStart(6, "0")}`,
		parentId,
		timestamp: new Date(FIXTURE_TIME_MS + sequence).toISOString(),
		message,
	};
}

function realisticCycle(cycle, firstSequence, parentId) {
	let sequence = firstSequence;
	const toolCallId = `benchmark-tool-${String(cycle).padStart(5, "0")}`;
	const errorKind = cycle % 4;
	const userText = cycle === 0
		? `${FIRST_MARKER}\nPlease inspect deterministic fixture unit ${cycle}.`
		: `Please inspect deterministic fixture unit ${cycle}.`;
	const markdown = [
		`## Deterministic analysis ${cycle}`,
		"",
		"This assistant response exercises realistic Markdown and a small code sample.",
		"```text",
		`fixture-${String(cycle).padStart(5, "0")}: alpha beta gamma`,
		"status: deterministic",
		"```",
	].join("\n");
	const user = fixtureMessage(sequence, "user", [{ type: "text", text: userText }]);
	const userEntry = transcriptEntry(sequence++, parentId, user);
	const assistant = fixtureMessage(sequence, "assistant", [
		{ type: "text", text: markdown },
		{
			type: "toolCall",
			id: toolCallId,
			name: cycle % 2 === 0 ? "read" : "bash",
			arguments: cycle % 2 === 0
				? { path: `fixtures/unit-${String(cycle).padStart(5, "0")}.txt` }
				: { command: `printf fixture-${String(cycle).padStart(5, "0")}` },
		},
	], { stopReason: "toolUse" });
	const assistantEntry = transcriptEntry(sequence++, userEntry.id, assistant);
	let resultExtra;
	let resultText;
	if (errorKind === 1) {
		resultExtra = { isError: true };
		resultText = `modern error fixture ${cycle}`;
	} else if (errorKind === 2) {
		resultExtra = { is_error: true };
		resultText = `legacy error fixture ${cycle}`;
	} else if (errorKind === 3) {
		resultExtra = {};
		resultText = JSON.stringify({ is_error: true, error: `serialized returned error fixture ${cycle}` });
	} else {
		resultExtra = { isError: false };
		resultText = `successful deterministic tool result ${cycle}`;
	}
	const result = fixtureMessage(sequence, "toolResult", [{ type: "text", text: resultText }], {
		toolCallId,
		toolName: assistant.content[1].name,
		...resultExtra,
	});
	const resultEntry = transcriptEntry(sequence++, assistantEntry.id, result);
	return { entries: [userEntry, assistantEntry, resultEntry], nextSequence: sequence, parentId: resultEntry.id };
}

function ballastText(ordinal, byteLength, includeLastMarker = false) {
	const prefix = `Bobbit session open ballast block ${String(ordinal).padStart(6, "0")}.`;
	const suffix = includeLastMarker ? ` ${LAST_MARKER}` : "";
	const minimum = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
	if (!Number.isSafeInteger(byteLength) || byteLength < minimum || byteLength > SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES) {
		return null;
	}
	const remaining = byteLength - minimum;
	const prose = BALLAST_PROSE.repeat(Math.ceil(remaining / BALLAST_PROSE.length)).slice(0, remaining);
	return `${prefix}${prose}${suffix}`;
}

function ballastEntry(sequence, parentId, firstOrdinal, blockLengths, includeLastMarker = false) {
	const content = blockLengths.map((blockLength, index) => {
		const isLast = includeLastMarker && index === blockLengths.length - 1;
		const text = ballastText(firstOrdinal + index, blockLength, isLast);
		if (text === null) throw new Error(`Unable to construct ballast block ${firstOrdinal + index} with ${blockLength} bytes`);
		return { type: "text", text };
	});
	return transcriptEntry(sequence, parentId, fixtureMessage(sequence, "assistant", content, { stopReason: "stop" }));
}

function finalBallastCandidate(transcriptBytes, targetBytes, sequence, parentId, firstOrdinal) {
	for (let blockCount = 1; blockCount <= SESSION_OPEN_BALLAST_BLOCKS_PER_MESSAGE; blockCount += 1) {
		const minimumFinal = Buffer.byteLength(`Bobbit session open ballast block ${String(firstOrdinal + blockCount - 1).padStart(6, "0")}. ${LAST_MARKER}`);
		const blockLengths = [
			...Array.from({ length: blockCount - 1 }, () => SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES),
			minimumFinal,
		];
		const candidate = ballastEntry(sequence, parentId, firstOrdinal, blockLengths, true);
		const missingBytes = targetBytes - transcriptBytes - Buffer.byteLength(jsonLine(candidate));
		if (missingBytes < 0 || minimumFinal + missingBytes > SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES) continue;
		blockLengths[blockLengths.length - 1] += missingBytes;
		return { entry: ballastEntry(sequence, parentId, firstOrdinal, blockLengths, true), blockLengths };
	}
	return null;
}

function buildFixture(targetBytes) {
	if (!Number.isSafeInteger(targetBytes) || targetBytes < 100_000) throw new RangeError("transcript byte size is too small");
	const header = {
		type: "session",
		version: 3,
		id: `benchmark-session-${targetBytes}`,
		timestamp: "2024-01-01T00:00:00.000Z",
	};
	const entries = [];
	let transcript = jsonLine(header);
	let sequence = 1;
	let parentId = null;
	for (let cycle = 0; cycle < REALISTIC_CYCLE_COUNT; cycle += 1) {
		const next = realisticCycle(cycle, sequence, parentId);
		const encoded = next.entries.map(jsonLine).join("");
		if (Buffer.byteLength(transcript) + Buffer.byteLength(encoded) >= targetBytes) {
			throw new Error(`Realistic fixture cycles do not fit into ${targetBytes} bytes`);
		}
		transcript += encoded;
		entries.push(...next.entries);
		sequence = next.nextSequence;
		parentId = next.parentId;
	}

	let transcriptBytes = Buffer.byteLength(transcript);
	let ballastBlockCount = 0;
	const ballastBlockLengths = [];
	for (;;) {
		const fullLengths = Array.from({ length: SESSION_OPEN_BALLAST_BLOCKS_PER_MESSAGE }, () => SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES);
		const maximumFinalBytes = Buffer.byteLength(jsonLine(ballastEntry(sequence, parentId, ballastBlockCount, fullLengths, true)));
		const remainingTargetBytes = targetBytes - transcriptBytes;
		let regular = null;
		if (remainingTargetBytes > maximumFinalBytes + 1_024) {
			regular = { entry: ballastEntry(sequence, parentId, ballastBlockCount, fullLengths), lengths: fullLengths };
		} else {
			const finalCandidate = finalBallastCandidate(transcriptBytes, targetBytes, sequence, parentId, ballastBlockCount);
			if (finalCandidate) {
				const encoded = jsonLine(finalCandidate.entry);
				transcript += encoded;
				transcriptBytes += Buffer.byteLength(encoded);
				entries.push(finalCandidate.entry);
				ballastBlockLengths.push(...finalCandidate.blockLengths);
				ballastBlockCount += finalCandidate.blockLengths.length;
				break;
			}
		}

		if (!regular) {
			for (let blockCount = SESSION_OPEN_BALLAST_BLOCKS_PER_MESSAGE; blockCount >= 1; blockCount -= 1) {
				const lengths = Array.from({ length: blockCount }, () => SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES);
				const entry = ballastEntry(sequence, parentId, ballastBlockCount, lengths);
				const nextBytes = transcriptBytes + Buffer.byteLength(jsonLine(entry));
				if (nextBytes >= targetBytes) continue;
				if (finalBallastCandidate(nextBytes, targetBytes, sequence + 1, entry.id, ballastBlockCount + blockCount)) {
					regular = { entry, lengths };
					break;
				}
			}
		}
		if (!regular) throw new Error(`Unable to fit deterministic ballast into ${targetBytes} bytes`);
		const encoded = jsonLine(regular.entry);
		transcript += encoded;
		transcriptBytes += Buffer.byteLength(encoded);
		entries.push(regular.entry);
		ballastBlockLengths.push(...regular.lengths);
		ballastBlockCount += regular.lengths.length;
		parentId = regular.entry.id;
		sequence += 1;
	}

	const actualBytes = transcriptBytes;
	if (actualBytes !== targetBytes) throw new Error(`Fixture byte mismatch: expected ${targetBytes}, got ${actualBytes}`);
	if (ballastBlockLengths.some(length => length > SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES)) {
		throw new Error("Fixture ballast exceeded the production-safe block limit");
	}

	const rawMessages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
	const sidecars = compactionEntries();
	const expectedMessages = [...sidecars.flatMap(syntheticCompactionMessages), ...rawMessages];
	const projection = projectSessionOpenMessages(expectedMessages);
	const renderedTextProjection = projectSessionOpenRenderedText(expectedMessages);
	const toolCallIds = rawMessages.flatMap(message => message.role === "assistant"
		? message.content.filter(block => block.type === "toolCall").map(block => block.id)
		: []);
	const errorIds = rawMessages.filter(message => message.role === "toolResult" && normalizedError(message)).map(message => message.id);
	const modernErrorIds = rawMessages.filter(message => message.role === "toolResult" && message.isError === true).map(message => message.id);
	const legacyErrorIds = rawMessages.filter(message => message.role === "toolResult" && message.is_error === true).map(message => message.id);
	const serializedErrorIds = rawMessages.filter(message => message.role === "toolResult"
		&& message.isError !== true && message.is_error !== true && normalizedError(message)).map(message => message.id);
	const renderIds = [
		...sidecars.map(entry => entry.id),
		...rawMessages.filter(message => message.role === "user" || message.role === "assistant").map(message => message.id),
	];
	const manifest = {
		schemaVersion: SESSION_OPEN_FIXTURE_VERSION,
		targetBytes,
		transcriptBytes: actualBytes,
		transcriptSha256: sha256(transcript),
		rawEntryIds: entries.map(entry => entry.id),
		rawMessageIds: rawMessages.map(message => message.id),
		rawMessageCount: rawMessages.length,
		realisticCycleCount: REALISTIC_CYCLE_COUNT,
		ballastBlockCount,
		ballastBlockMaxBytes: Math.max(...ballastBlockLengths),
		ballastBlockLengthsSha256: sha256(JSON.stringify(ballastBlockLengths)),
		expectedVisibleMessageCount: expectedMessages.length,
		expectedSemanticSha256: sha256(JSON.stringify(projection)),
		expectedRenderIds: renderIds,
		expectedRenderIdsSha256: sha256(JSON.stringify(renderIds)),
		expectedRenderedTextCount: renderedTextProjection.length,
		expectedRenderedTextSha256: sha256(JSON.stringify(renderedTextProjection)),
		expectedToolCallIds: toolCallIds,
		expectedErrorIds: errorIds,
		expectedModernErrorIds: modernErrorIds,
		expectedLegacyErrorIds: legacyErrorIds,
		expectedSerializedErrorIds: serializedErrorIds,
		expectedCompactionIds: sidecars.map(entry => entry.id),
		firstMarker: FIRST_MARKER,
		lastMarker: LAST_MARKER,
	};
	return { transcript, manifest, sidecars };
}

/** Generate one immutable canonical fixture beneath the runner-owned fixture root. */
export async function generateSessionOpenFixture(fixtureRoot, fixtureCase) {
	const directory = path.join(fixtureRoot, fixtureCase.name);
	await mkdir(directory, { recursive: false });
	const fixture = buildFixture(fixtureCase.transcriptBytes);
	await Promise.all([
		writeFile(path.join(directory, "transcript.jsonl"), fixture.transcript, "utf8"),
		writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(fixture.manifest)}\n`, "utf8"),
		writeFile(path.join(directory, "compactions.jsonl"), fixture.sidecars.map(jsonLine).join(""), "utf8"),
	]);
	return { directory, ...fixture };
}

export const SESSION_OPEN_BROWSER_ACQUISITION_TIMEOUT_MS = 30_000;

const SESSION_OPEN_PHASES = Object.freeze([
	"prepare",
	"browserAcquire",
	"browserSetup",
	"navigate",
	"interactiveWait",
	"paritySettle",
	"oracle",
	"teardown",
]);

/** Session-open compatibility facade over the shared interrupting watchdog. */
export function createSessionOpenSampleWatchdog(options = {}) {
	const timeoutMs = options.timeoutMs ?? SESSION_OPEN_SAMPLE_TIMEOUT_MS;
	const graceMs = options.graceMs ?? SESSION_OPEN_WATCHDOG_GRACE_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Session-open sample timeout must be positive");
	if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Session-open watchdog grace must be non-negative");
	return createInterruptingSampleWatchdog({
		...options,
		label: "Session-open sample",
		errorName: "SessionOpenSampleTimeoutError",
		phaseLabel: "session-open",
		phases: SESSION_OPEN_PHASES,
		initialPhase: "prepare",
		timeoutMs,
		graceMs,
	});
}

function requestSignal(signal, timeoutMs = 30_000) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function apiJson(baseUrl, token, pathname, init = {}, signal) {
	const response = await fetch(new URL(pathname.replace(/^\//, ""), baseUrl), {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
		signal: requestSignal(signal),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} returned HTTP ${response.status}: ${body.slice(0, 1_000)}`);
	return body ? JSON.parse(body) : null;
}

async function waitFor(predicate, description, timeoutMs = 30_000, signal) {
	const deadline = performance.now() + timeoutMs;
	let lastError;
	while (performance.now() < deadline) {
		signal?.throwIfAborted();
		try {
			const result = await predicate();
			if (result) return result;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
	}
	throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

export function sessionOpenGatewayArgs(repoRoot, workspace, port) {
	return [
		path.join(repoRoot, "dist", "server", "cli.js"),
		"--cwd", workspace,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls",
		"--auth",
		"--static", path.join(repoRoot, "dist", "ui"),
		"--agent-cli", path.join(repoRoot, "tests", "e2e", "mock-agent.mjs"),
	];
}

function gatewayInvocation(context, sampleRoot, port, token) {
	const workspace = path.join(sampleRoot, "workspace");
	const gatewayDir = path.join(sampleRoot, "gateway");
	const agentDir = path.join(sampleRoot, "agent");
	const homeDir = path.join(sampleRoot, "home");
	const secretsDir = path.join(sampleRoot, "secrets");
	const baseUrl = `http://127.0.0.1:${port}/`;
	return {
		workspace,
		gatewayDir,
		agentDir,
		homeDir,
		secretsDir,
		baseUrl,
		token,
		spawn() {
			return spawnGateway({
				args: sessionOpenGatewayArgs(context.repoRoot, workspace, port),
				cwd: context.repoRoot,
				redactions: [token],
				env: {
					...process.env,
					NODE_ENV: "test",
					NO_COLOR: "1",
					BOBBIT_DEV_HARNESS: "1",
					BOBBIT_E2E: "1",
					BOBBIT_SKIP_MCP: "1",
					BOBBIT_SKIP_TITLE_GENERATION: "1",
					BOBBIT_SKIP_NPM_CI: "1",
					BOBBIT_TEST_NO_EXTERNAL: "1",
					BOBBIT_TEST_NO_REMOTE: "1",
					BOBBIT_DIR: gatewayDir,
					BOBBIT_AGENT_DIR: agentDir,
					BOBBIT_SECRETS_DIR: secretsDir,
					HOME: homeDir,
					USERPROFILE: homeDir,
				},
			});
		},
	};
}

async function prepareRestoredSession(context, sampleRoot, watchdog, {
	stopRuntime = stopGateway,
} = {}) {
	watchdog.throwIfExpired();
	const port = await getFreePort();
	const preliminary = gatewayInvocation(context, sampleRoot, port, null);
	await Promise.all([
		preliminary.workspace,
		preliminary.gatewayDir,
		preliminary.agentDir,
		preliminary.homeDir,
		preliminary.secretsDir,
	].map(directory => mkdir(directory, { recursive: true })));
	const token = await createBenchmarkGatewayToken(preliminary.secretsDir);
	const invocation = gatewayInvocation(context, sampleRoot, port, token);
	const gatewayStateDir = path.join(invocation.gatewayDir, "state");
	await mkdir(gatewayStateDir, { recursive: true });
	await Promise.all([
		writeFile(path.join(gatewayStateDir, "setup-complete"), "benchmark\n", "utf8"),
		writeFile(path.join(gatewayStateDir, "preferences.json"), JSON.stringify({
			customProviders: [{
				id: "mock",
				name: "mock",
				type: "manual",
				baseUrl: "http://127.0.0.1",
				models: [{ id: "mock-model", name: "mock-model" }],
			}],
			"default.sessionModel": "mock/mock-model",
			"default.sessionThinkingLevel": "off",
		}, null, 2), "utf8"),
	]);
	let runtime = invocation.spawn();
	watchdog.registerGateway(runtime);
	try {
		await waitForGatewayReady({ runtime, baseUrl: invocation.baseUrl, token, timeoutMs: watchdog.remainingMs() });
		watchdog.throwIfExpired();
		let projects = await apiJson(invocation.baseUrl, token, "/api/projects", {}, watchdog.signal);
		let project = projects.find(candidate => candidate.rootPath && path.resolve(candidate.rootPath) === path.resolve(invocation.workspace));
		if (!project) {
			project = await apiJson(invocation.baseUrl, token, "/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "benchmark", rootPath: invocation.workspace, acceptCanonical: true }),
			}, watchdog.signal);
		}
		const session = await apiJson(invocation.baseUrl, token, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: invocation.workspace, projectId: project.id, worktree: false }),
		}, watchdog.signal);
		await waitFor(async () => {
			const current = await apiJson(invocation.baseUrl, token, `/api/sessions/${session.id}`, {}, watchdog.signal);
			return current.status === "idle" ? current : null;
		}, "new benchmark session to become idle", Math.min(60_000, watchdog.remainingMs()), watchdog.signal);
		const storeFile = path.join(invocation.workspace, ".bobbit", "state", "sessions.json");
		const persisted = await waitFor(async () => {
			const store = JSON.parse(await readFile(storeFile, "utf8"));
			const rows = Array.isArray(store) ? store : store.sessions;
			return rows?.find(row => row.id === session.id && typeof row.agentSessionFile === "string") ?? null;
		}, "session transcript path to persist", Math.min(30_000, watchdog.remainingMs()), watchdog.signal);
		await stopRuntime(runtime, { baseUrl: invocation.baseUrl, token });
		watchdog.registerGateway(null);
		runtime = null;
		watchdog.throwIfExpired();

		await writeFile(persisted.agentSessionFile, await readFile(path.join(sampleRoot, "fixture", "transcript.jsonl")));
		const sidecarDir = path.join(invocation.gatewayDir, "state", "compaction-sidecar");
		await mkdir(sidecarDir, { recursive: true });
		await writeFile(
			path.join(sidecarDir, `${session.id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`),
			await readFile(path.join(sampleRoot, "fixture", "compactions.jsonl")),
		);

		runtime = invocation.spawn();
		watchdog.registerGateway(runtime);
		await waitForGatewayReady({ runtime, baseUrl: invocation.baseUrl, token, timeoutMs: watchdog.remainingMs() });
		watchdog.throwIfExpired();
		await waitFor(async () => {
			const current = await apiJson(invocation.baseUrl, token, `/api/sessions/${session.id}`, {}, watchdog.signal);
			return current.status === "idle" ? current : null;
		}, "restored benchmark session to become interactive", Math.min(60_000, watchdog.remainingMs()), watchdog.signal);
		return { invocation, runtime, sessionId: session.id };
	} catch (error) {
		let cleanupError = null;
		if (runtime) {
			try {
				await stopRuntime(runtime, { baseUrl: invocation.baseUrl, token });
				watchdog.registerGateway(null);
				runtime = null;
			} catch (failure) {
				cleanupError = failure;
			}
		}
		if (cleanupError) {
			throw new AggregateError([error, cleanupError], `Session-open preparation failed and gateway cleanup was incomplete: ${error.message ?? error}`);
		}
		throw error;
	}
}

function metricValue(metrics, name) {
	return metrics?.find(metric => metric.name === name)?.value ?? null;
}

export async function measureBrowserSample(restored, manifest, watchdog, {
	parityBatchSize = SESSION_OPEN_PARITY_BATCH_SIZE,
	launchBrowser = launchBenchmarkBrowser,
	closeBrowser = closeBenchmarkBrowser,
} = {}) {
	if (!Number.isInteger(parityBatchSize) || parityBatchSize < 1 || parityBatchSize > 100) {
		throw new RangeError("Session-open parity batch size must be an integer from 1 to 100");
	}
	watchdog.throwIfExpired();
	let browserRuntime;
	try {
		browserRuntime = await launchBrowser({
			viewport: SESSION_OPEN_VIEWPORT,
			launchOptions: {
				args: ["--enable-precise-memory-info"],
				timeout: Math.min(SESSION_OPEN_BROWSER_ACQUISITION_TIMEOUT_MS, watchdog.remainingMs()),
			},
			registerRuntime: runtime => watchdog.registerBrowser(runtime),
		});
	} catch (error) {
		const acquisitionError = new Error(
			`Session-open browser acquisition failed during browserAcquire phase: ${error?.message ?? error}`,
			{ cause: error },
		);
		acquisitionError.phase = "browserAcquire";
		throw acquisitionError;
	}
	watchdog.setPhase("browserSetup");
	watchdog.throwIfExpired();
	let snapshotFrameBytes = 0;
	try {
		await browserRuntime.context.addInitScript(() => {
			localStorage.setItem("bobbit-perf-instrumentation", "1");
			window.__bobbitSessionOpenMetrics = { longTasks: [], longTasksSupported: false, heap: [] };
			try {
				const supported = PerformanceObserver.supportedEntryTypes;
				if (!Array.isArray(supported) || supported.includes("longtask")) {
					new PerformanceObserver(list => {
						for (const entry of list.getEntries()) {
							window.__bobbitSessionOpenMetrics.longTasks.push({
								startTime: entry.startTime,
								duration: entry.duration,
							});
						}
					}).observe({ type: "longtask", buffered: true });
					window.__bobbitSessionOpenMetrics.longTasksSupported = true;
				}
			} catch { /* unsupported */ }
			window.setInterval(() => {
				const used = performance.memory?.usedJSHeapSize;
				if (Number.isFinite(used)) window.__bobbitSessionOpenMetrics.heap.push(used);
			}, 25);
		});
		let heapBefore = null;
		if (browserRuntime.cdp) {
			await browserRuntime.cdp.send("Network.enable");
			await browserRuntime.cdp.send("Performance.enable");
			const before = await browserRuntime.cdp.send("Performance.getMetrics");
			heapBefore = metricValue(before.metrics, "JSHeapUsedSize");
			browserRuntime.cdp.on("Network.webSocketFrameReceived", event => {
				const payload = event?.response?.payloadData;
				if (typeof payload === "string" && payload.includes('"type":"messages"')) {
					snapshotFrameBytes += Buffer.byteLength(payload, "utf8");
				}
			});
		}

		watchdog.setPhase("navigate");
		watchdog.throwIfExpired();
		await browserRuntime.page.goto(`${restored.invocation.baseUrl}?token=${encodeURIComponent(restored.invocation.token)}#/session/${restored.sessionId}`, {
			waitUntil: "domcontentloaded",
			timeout: watchdog.remainingMs(),
		});
		watchdog.setPhase("interactiveWait");
		watchdog.throwIfExpired();
		await browserRuntime.page.waitForFunction(lastMarker => {
			const editor = document.querySelector("message-editor textarea");
			const timing = window.__bobbitBootTimings;
			return !!editor && !editor.disabled && editor.getClientRects().length > 0
				&& document.body.textContent.includes(lastMarker)
				&& timing?.marks?.some(mark => mark.name === "post-snapshot-paint");
		}, LAST_MARKER, { timeout: watchdog.remainingMs() });
		const timing = await browserRuntime.page.evaluate(async () => {
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const sample = window.__bobbitBootTimings;
			const sent = sample.marks.find(mark => mark.name === "get-messages-sent")?.t;
			const received = sample.marks.find(mark => String(mark.name).startsWith("snapshot-received("))?.t;
			if (!Number.isFinite(sent) || !Number.isFinite(received)) throw new Error("Required boot timing marks were not recorded");
			return {
				now: performance.now(),
				sent,
				received,
				snapshotChars: sample.snapshotChars,
				serverTiming: sample.serverTiming,
				longTasks: [...(window.__bobbitSessionOpenMetrics?.longTasks ?? [])],
				longTasksSupported: window.__bobbitSessionOpenMetrics?.longTasksSupported === true,
				heap: [...(window.__bobbitSessionOpenMetrics?.heap ?? [])],
			};
		});
		watchdog.setPhase("paritySettle");
		watchdog.throwIfExpired();
		let heapAfterInteractive = null;
		if (browserRuntime.cdp) {
			const afterInteractive = await browserRuntime.cdp.send("Performance.getMetrics");
			heapAfterInteractive = metricValue(afterInteractive.metrics, "JSHeapUsedSize");
		}

		await browserRuntime.page.evaluate(async ({ batchSize }) => {
			const componentSelector = "message-list, user-message, assistant-message, markdown-block, tool-message, code-block";
			const settleComponents = async roots => {
				const components = new Set(document.querySelectorAll(componentSelector));
				for (const root of roots) {
					for (const component of root.querySelectorAll(componentSelector)) components.add(component);
				}
				await Promise.all(Array.from(components, component => component.updateComplete ?? Promise.resolve()));
			};
			let stablePasses = 0;
			let previousWrapperCount = -1;
			while (stablePasses < 2) {
				const wrappers = [...document.querySelectorAll("deferred-block")];
				const unresolved = wrappers.filter(wrapper => wrapper.eager !== true);
				if (unresolved.length > 0) {
					const batch = unresolved.slice(0, batchSize);
					for (const wrapper of batch) wrapper.eager = true;
					await Promise.all(batch.map(wrapper => wrapper.updateComplete ?? Promise.resolve()));
					await settleComponents(batch);
					stablePasses = 0;
				} else {
					await settleComponents(wrappers);
					stablePasses = wrappers.length === previousWrapperCount ? stablePasses + 1 : 0;
					previousWrapperCount = wrappers.length;
				}
				await new Promise(resolve => requestAnimationFrame(resolve));
			}
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		}, { batchSize: parityBatchSize });
		watchdog.throwIfExpired();
		await browserRuntime.page.waitForFunction(({ compactions, textRows }) =>
			document.querySelectorAll('[data-testid="compaction-summary-card"]').length === compactions
				&& [...document.querySelectorAll("user-message markdown-block, assistant-message markdown-block")]
					.filter(block => !block.closest("tool-message")).length === textRows,
		{ compactions: manifest.expectedCompactionIds.length, textRows: manifest.expectedRenderedTextCount },
		{ timeout: Math.min(30_000, watchdog.remainingMs()) });

		watchdog.setPhase("oracle");
		watchdog.throwIfExpired();
		const oracle = await browserRuntime.page.evaluate(async ({ firstMarker, lastMarker }) => {
			const agent = document.querySelector("agent-interface");
			const messages = agent?.session?.state?.messages;
			if (!Array.isArray(messages)) throw new Error("Interactive session did not expose a client transcript");
			const normalizeErrorForSemanticProjection = message => {
				if (message?.isError === true || message?.is_error === true) return true;
				const text = Array.isArray(message?.content)
					? message.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n").trim()
					: "";
				try {
					const value = text.startsWith("{") && text.endsWith("}") ? JSON.parse(text) : null;
					return value?.isError === true || value?.is_error === true;
				} catch { return false; }
			};
			const projection = messages.map(message => {
				const projected = { id: typeof message?.id === "string" ? message.id : null, role: message?.role ?? null };
				if (Array.isArray(message?.content)) projected.content = message.content.map(block => {
					if (block?.type === "text") return { type: "text", text: block.text ?? "" };
					if (block?.type === "toolCall" || block?.type === "tool_use") return {
						type: "toolCall", id: block.id ?? null, name: block.name ?? null,
						arguments: block.arguments ?? block.input ?? null,
					};
					return { type: block?.type ?? null };
				});
				if (message?.role === "toolResult" || message?.role === "tool_result" || message?.role === "tool") {
					projected.toolCallId = message.toolCallId ?? message.tool_use_id ?? null;
					projected.toolName = message.toolName ?? message.name ?? null;
					projected.isError = normalizeErrorForSemanticProjection(message);
				}
				return projected;
			});
			const bytes = new TextEncoder().encode(JSON.stringify(projection));
			const semanticDigest = await crypto.subtle.digest("SHA-256", bytes);
			const semanticSha256 = Array.from(new Uint8Array(semanticDigest), byte => byte.toString(16).padStart(2, "0")).join("");
			const renderIds = [...document.querySelectorAll("user-message, assistant-message")]
				.map(element => element.message?.id)
				.filter(id => typeof id === "string");
			const renderDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(renderIds)));
			const renderIdsSha256 = Array.from(new Uint8Array(renderDigest), byte => byte.toString(16).padStart(2, "0")).join("");
			const canonicalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
			const renderedTextProjection = [];
			for (const element of document.querySelectorAll("user-message, assistant-message")) {
				const role = element.tagName === "USER-MESSAGE" ? "user" : "assistant";
				for (const block of element.querySelectorAll(":scope markdown-block")) {
					if (block.closest("tool-message")) continue;
					const committed = block.cloneNode(true);
					for (const codeBlock of committed.querySelectorAll("code-block")) {
						codeBlock.replaceWith(` ${codeBlock.querySelector("pre code")?.textContent ?? ""} `);
					}
					for (const lineBreak of committed.querySelectorAll("br")) lineBreak.replaceWith(" ");
					const text = canonicalize(committed.textContent);
					if (text) renderedTextProjection.push({ role, text });
				}
			}
			const renderedTextDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(renderedTextProjection)));
			const renderedTextSha256 = Array.from(new Uint8Array(renderedTextDigest), byte => byte.toString(16).padStart(2, "0")).join("");
			const ids = messages.map(message => message?.id).filter(id => typeof id === "string");
			const orders = messages.map(message => message?._order);
			const toolCalls = messages.flatMap(message => message?.role === "assistant" && Array.isArray(message.content)
				? message.content.filter(block => block?.type === "toolCall" || block?.type === "tool_use").map(block => block.id)
				: []);
			const toolResults = new Set(messages.filter(message => message?.role === "toolResult").map(message => message.toolCallId));
			return {
				messageCount: messages.length,
				semanticSha256,
				renderCount: renderIds.length,
				renderIdsSha256,
				renderedTextCount: renderedTextProjection.length,
				renderedTextSha256,
				uniqueIds: new Set(ids).size === ids.length,
				monotonicOrder: orders.every((order, index) => Number.isFinite(order) && (index === 0 || order > orders[index - 1])),
				toolPairCount: toolCalls.filter(id => toolResults.has(id)).length,
				toolCallCount: toolCalls.length,
				canonicalErrorIds: messages.filter(message => message?.role === "toolResult" && message.isError === true).map(message => message.id).filter(Boolean),
				compactionCount: document.querySelectorAll('[data-testid="compaction-summary-card"]').length,
				firstMarkerCount: document.body.textContent.split(firstMarker).length - 1,
				lastMarkerCount: document.body.textContent.split(lastMarker).length - 1,
			};
		}, { firstMarker: FIRST_MARKER, lastMarker: LAST_MARKER });

		const expectedToolCount = manifest.expectedToolCallIds.length + manifest.expectedCompactionIds.length;
		const assertions = [
			[oracle.messageCount === manifest.expectedVisibleMessageCount, `visible message count ${oracle.messageCount}/${manifest.expectedVisibleMessageCount}`],
			[oracle.semanticSha256 === manifest.expectedSemanticSha256, `semantic projection hash ${oracle.semanticSha256}/${manifest.expectedSemanticSha256}`],
			[oracle.renderCount === manifest.expectedRenderIds.length, `rendered role count ${oracle.renderCount}/${manifest.expectedRenderIds.length}`],
			[oracle.renderIdsSha256 === manifest.expectedRenderIdsSha256, `rendered role order ${oracle.renderIdsSha256}/${manifest.expectedRenderIdsSha256}`],
			[oracle.renderedTextCount === manifest.expectedRenderedTextCount, `rendered text count ${oracle.renderedTextCount}/${manifest.expectedRenderedTextCount}`],
			[oracle.renderedTextSha256 === manifest.expectedRenderedTextSha256, `rendered role/text projection ${oracle.renderedTextSha256}/${manifest.expectedRenderedTextSha256}`],
			[oracle.uniqueIds, "unique message ids"],
			[oracle.monotonicOrder, "strict snapshot order"],
			[oracle.toolCallCount === expectedToolCount && oracle.toolPairCount === expectedToolCount, `tool call/result pairs ${oracle.toolPairCount}/${oracle.toolCallCount}/${expectedToolCount}`],
			[JSON.stringify(oracle.canonicalErrorIds) === JSON.stringify(manifest.expectedErrorIds), `canonical isError normalization ${oracle.canonicalErrorIds.length}/${manifest.expectedErrorIds.length} (modern ${manifest.expectedModernErrorIds.length}, legacy ${manifest.expectedLegacyErrorIds.length}, serialized ${manifest.expectedSerializedErrorIds.length})`],
			[oracle.compactionCount === manifest.expectedCompactionIds.length, `compaction cards ${oracle.compactionCount}/${manifest.expectedCompactionIds.length}`],
			[oracle.firstMarkerCount === 1 && oracle.lastMarkerCount === 1, `first/last markers ${oracle.firstMarkerCount}/${oracle.lastMarkerCount}`],
		];
		const failure = assertions.find(([passed]) => !passed);
		if (failure) throw new Error(`Session-open parity failed: ${failure[1]}`);

		const longTaskMetrics = timing.longTasksSupported
			? measureLongTasksInWindow(timing.longTasks, timing.sent, timing.now)
			: null;
		const heapSamples = [heapBefore, heapAfterInteractive, ...timing.heap].filter(Number.isFinite);
		const metrics = sessionOpenMetricFields({
			timing,
			snapshotFrameBytes,
			heapBefore,
			heapAfterInteractive,
			longTaskMetrics,
		});
		return {
			metrics,
			correctness: oracle,
			browserVersion: browserRuntime.browser.version(),
			metricSupport: {
				webSocketFrames: snapshotFrameBytes > 0 ? "reliable" : "estimated-from-client-frame-chars",
				longTasks: timing.longTasksSupported ? "reliable-measurement-window-overlap" : "unsupported",
				heap: heapSamples.length ? "chromium-precise-memory-lower-confidence-peak-sampling" : "unsupported",
			},
		};
	} finally {
		watchdog.setPhase("teardown");
		await closeBrowser(browserRuntime);
		watchdog.registerBrowser(null);
	}
}

async function cleanupSessionOpenResources(watchdog, {
	closeBrowser = closeBenchmarkBrowser,
	stopRuntime = stopGateway,
	baseUrl,
	token,
} = {}) {
	const failures = [];
	const { browserRuntime, gatewayRuntime } = watchdog.resources();
	if (browserRuntime) {
		try {
			await closeBrowser(browserRuntime);
			watchdog.registerBrowser(null);
		} catch (error) {
			failures.push(error);
		}
	}
	if (gatewayRuntime) {
		try {
			await stopRuntime(gatewayRuntime, { baseUrl, token });
			watchdog.registerGateway(null);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Session-open browser and gateway cleanup failed");
}

function combineSessionOpenOperationErrors(watchdogError, interruptedOperationError) {
	if (!watchdogError || !interruptedOperationError) return watchdogError ?? interruptedOperationError ?? null;
	const phase = watchdogError.phase ?? "unknown";
	const combined = new AggregateError(
		[watchdogError, interruptedOperationError],
		`Session-open sample operation was interrupted during ${phase} phase: ${interruptedOperationError.message ?? interruptedOperationError}`,
		{ cause: watchdogError },
	);
	combined.phase = watchdogError.phase;
	combined.phaseDurationsMs = watchdogError.phaseDurationsMs;
	return combined;
}

function combineSessionOpenCleanupErrors(firstCleanupError, secondCleanupError) {
	if (firstCleanupError && secondCleanupError) {
		return new AggregateError([firstCleanupError, secondCleanupError], "Session-open cleanup failed in multiple operations");
	}
	return firstCleanupError ?? secondCleanupError ?? null;
}

function combineSessionOpenErrors(operationError, cleanupError) {
	if (operationError && cleanupError) {
		return new AggregateError(
		[operationError, cleanupError],
		`Session-open sample failed and cleanup was incomplete: ${operationError.message ?? operationError}`,
		{ cause: operationError },
		);
	}
	return operationError ?? cleanupError ?? null;
}

export async function runSessionOpenSample(context, entry, fixture, {
	timeoutMs = SESSION_OPEN_SAMPLE_TIMEOUT_MS,
	watchdogGraceMs = SESSION_OPEN_WATCHDOG_GRACE_MS,
	parityBatchSize = SESSION_OPEN_PARITY_BATCH_SIZE,
	watchdogDependencies = {},
	prepare = prepareRestoredSession,
	measure = measureBrowserSample,
	launchBrowser = launchBenchmarkBrowser,
	closeBrowser = closeBenchmarkBrowser,
	stopRuntime = stopGateway,
} = {}) {
	const watchdog = createSessionOpenSampleWatchdog({
		timeoutMs,
		graceMs: watchdogGraceMs,
		...watchdogDependencies,
	});
	let restored;
	let measured;
	let operationError = null;
	let cleanupError = null;
	const cleanupOwnedResources = () => cleanupSessionOpenResources(watchdog, {
		closeBrowser,
		stopRuntime,
		baseUrl: restored?.invocation?.baseUrl,
		token: restored?.invocation?.token,
	});
	context.deferCleanup?.(cleanupOwnedResources);
	try {
		const sampleRoot = await context.createSampleRoot(entry, { fixtureRoot: fixture.directory });
		watchdog.throwIfExpired();
		restored = await prepare(context, sampleRoot, watchdog, { stopRuntime });
		watchdog.setPhase("browserAcquire");
		watchdog.throwIfExpired();
		measured = await measure(restored, fixture.manifest, watchdog, { parityBatchSize, launchBrowser, closeBrowser });
	} catch (error) {
		operationError = watchdog.timedOut && error !== watchdog.error
			? combineSessionOpenOperationErrors(watchdog.error, error)
			: (watchdog.timedOut ? watchdog.error : error);
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
			cleanupError = combineSessionOpenCleanupErrors(cleanupError, error);
		}
	}
	operationError ??= watchdog.timedOut ? watchdog.error : null;
	const failure = combineSessionOpenErrors(operationError, cleanupError);
	if (failure) throw failure;
	return {
		case: entry.case,
		phase: entry.phase,
		cycle: entry.cycle,
		order: entry.order,
		caseOrder: entry.caseOrder,
		metrics: measured.metrics,
		phaseDurationsMs: watchdog.phaseDurationsMs(),
		correctness: {
			status: "passed",
			messageCount: measured.correctness.messageCount,
			renderCount: measured.correctness.renderCount,
			toolPairCount: measured.correctness.toolPairCount,
			errorCount: measured.correctness.canonicalErrorIds.length,
			compactionCount: measured.correctness.compactionCount,
			semanticSha256: measured.correctness.semanticSha256,
			renderIdsSha256: measured.correctness.renderIdsSha256,
			renderedTextSha256: measured.correctness.renderedTextSha256,
		},
		metricReliability: measured.metricSupport,
		browserVersion: measured.browserVersion,
	};
}

export async function runJourney(context, dependencies = {}) {
	const fixtures = new Map();
	for (const fixtureCase of SESSION_OPEN_CASES) {
		fixtures.set(fixtureCase.name, await generateSessionOpenFixture(context.paths.fixtures, fixtureCase));
	}
	const schedule = context.scheduleFor(SESSION_OPEN_CASES.map(fixtureCase => fixtureCase.name));
	const samples = [];
	let browserVersion = null;
	for (const entry of schedule) {
		const sample = await runSessionOpenSample(context, entry, fixtures.get(entry.case), dependencies);
		browserVersion ??= sample.browserVersion;
		samples.push(sample);
	}
	const metricSupport = {
		webSocketFrames: aggregateMeasuredReliability(samples, "webSocketFrames"),
		longTasks: aggregateMeasuredReliability(samples, "longTasks"),
		heap: aggregateMeasuredReliability(samples, "heap"),
	};
	return {
		fixtureDimensions: Object.fromEntries(SESSION_OPEN_CASES.map(fixtureCase => {
			const fixture = fixtures.get(fixtureCase.name);
			return [fixtureCase.name, {
				transcriptBytes: fixtureCase.transcriptBytes,
				rawMessageCount: fixture.manifest.rawMessageCount,
				visibleMessageCount: fixture.manifest.expectedVisibleMessageCount,
				toolCallCount: fixture.manifest.expectedToolCallIds.length,
				errorCount: fixture.manifest.expectedErrorIds.length,
				compactionCount: fixture.manifest.expectedCompactionIds.length,
				realisticCycleCount: fixture.manifest.realisticCycleCount,
				ballastBlockCount: fixture.manifest.ballastBlockCount,
				ballastBlockMaxBytes: fixture.manifest.ballastBlockMaxBytes,
			}];
		})),
		fixtureHashes: Object.fromEntries(SESSION_OPEN_CASES.map(fixtureCase => {
			const manifest = fixtures.get(fixtureCase.name).manifest;
			return [fixtureCase.name, {
				transcriptSha256: manifest.transcriptSha256,
				semanticSha256: manifest.expectedSemanticSha256,
				renderIdsSha256: manifest.expectedRenderIdsSha256,
				renderedTextSha256: manifest.expectedRenderedTextSha256,
			}];
		})),
		schedule,
		samples,
		metricDefinitions: {
			timeToInteractiveMs: { unit: "ms", direction: "lower", reliability: "reliable" },
			serverResponseLatencyMs: { unit: "ms", direction: "lower", reliability: "reliable" },
			transferredBytes: { unit: "bytes", direction: "lower", reliability: metricSupport.webSocketFrames },
			longTaskCount: { unit: "count", direction: "lower", reliability: metricSupport.longTasks },
			longTaskTotalMs: { unit: "ms", direction: "lower", reliability: metricSupport.longTasks },
			longTaskMaxMs: { unit: "ms", direction: "lower", reliability: metricSupport.longTasks },
			heapGrowthBytes: { unit: "bytes", direction: "lower", reliability: metricSupport.heap },
			heapPeakBytes: { unit: "bytes", direction: "lower", reliability: metricSupport.heap },
			rpcMs: { unit: "ms", direction: "lower", reliability: "dev-harness-server-timing" },
			pipelineMs: { unit: "ms", direction: "lower", reliability: "dev-harness-server-timing" },
			stampMs: { unit: "ms", direction: "lower", reliability: "dev-harness-server-timing" },
			stringifyMs: { unit: "ms", direction: "lower", reliability: "dev-harness-server-timing" },
		},
		environment: {
			browser: browserVersion,
			viewport: SESSION_OPEN_VIEWPORT,
			metricSupport,
		},
		correctness: {
			status: "passed",
			sampleCount: samples.length,
			semanticParity: true,
			renderedOrderParity: true,
			renderedTextParity: true,
			legacyErrorNormalization: true,
			compactionParity: true,
		},
		interpretation: "Validate semantic and rendered-order hashes first. Compare time-to-interactive and response latency only across alternating runs on the same host and build.",
		limitations: [
			"Chromium heap peak is sampled and is not a process-wide memory high-water mark.",
			"WebSocket transfer bytes use CDP payload bytes when available and client frame characters otherwise.",
			"Long Task totals clip task overlap to the get_messages send through interactive measurement window; unsupported observers produce no numeric Long Task metrics.",
			"Resolving all deferred blocks in bounded eager batches is part of parity validation but occurs after the measured interactive boundary.",
		],
		noiseSources: [
			"filesystem cache and antivirus scanning",
			"browser JIT and garbage collection",
			"CPU frequency scaling, thermal state, and process scheduling",
		],
		comparisonMethod: "Use identical fixture hashes, schema, host, power state, Node and Chromium versions. Alternate baseline and candidate invocations, then inspect raw samples, median, p95, MAD, and coefficient of variation.",
	};
}
