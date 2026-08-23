import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	closeBenchmarkBrowser,
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
export const SESSION_OPEN_FIXTURE_VERSION = 1;

const FIRST_MARKER = "BOBBIT_SESSION_OPEN_FIRST_MARKER";
const LAST_MARKER = "BOBBIT_SESSION_OPEN_LAST_MARKER";
const FIXTURE_TIME_MS = Date.parse("2024-01-01T00:00:00.000Z");
const SAMPLE_TIMEOUT_MS = 180_000;
const BODY_CHUNK_BYTES = 24 * 1024;

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
		"This assistant response exercises Markdown, code, and the production transcript renderer.",
		"```text",
		`fixture-${String(cycle).padStart(5, "0")}:${"abcdef0123456789".repeat(Math.ceil(BODY_CHUNK_BYTES / 16)).slice(0, BODY_CHUNK_BYTES)}`,
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
	let cycle = 0;
	const minimumTail = 1_024;
	for (;;) {
		const next = realisticCycle(cycle, sequence, parentId);
		const encoded = next.entries.map(jsonLine).join("");
		if (Buffer.byteLength(transcript) + Buffer.byteLength(encoded) + minimumTail > targetBytes) break;
		transcript += encoded;
		entries.push(...next.entries);
		sequence = next.nextSequence;
		parentId = next.parentId;
		cycle += 1;
	}
	const emptyTailMessage = fixtureMessage(sequence, "assistant", [{ type: "text", text: `\n${LAST_MARKER}` }], { stopReason: "stop" });
	const emptyTailEntry = transcriptEntry(sequence, parentId, emptyTailMessage);
	const markerEncodedBytes = Buffer.byteLength(jsonLine(emptyTailEntry));
	const fillerBytes = targetBytes - Buffer.byteLength(transcript) - markerEncodedBytes;
	if (fillerBytes < 0) throw new Error(`Unable to fit deterministic tail into ${targetBytes} bytes`);
	emptyTailEntry.message.content[0].text = `${"z".repeat(fillerBytes)}\n${LAST_MARKER}`;
	transcript += jsonLine(emptyTailEntry);
	entries.push(emptyTailEntry);
	const actualBytes = Buffer.byteLength(transcript);
	if (actualBytes !== targetBytes) throw new Error(`Fixture byte mismatch: expected ${targetBytes}, got ${actualBytes}`);

	const rawMessages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
	const sidecars = compactionEntries();
	const expectedMessages = [...sidecars.flatMap(syntheticCompactionMessages), ...rawMessages];
	const projection = projectSessionOpenMessages(expectedMessages);
	const toolCallIds = rawMessages.flatMap(message => message.role === "assistant"
		? message.content.filter(block => block.type === "toolCall").map(block => block.id)
		: []);
	const errorIds = rawMessages.filter(message => message.role === "toolResult" && normalizedError(message)).map(message => message.id);
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
		expectedVisibleMessageCount: expectedMessages.length,
		expectedSemanticSha256: sha256(JSON.stringify(projection)),
		expectedRenderIds: renderIds,
		expectedRenderIdsSha256: sha256(JSON.stringify(renderIds)),
		expectedToolCallIds: toolCallIds,
		expectedErrorIds: errorIds,
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

async function apiJson(baseUrl, pathname, init = {}) {
	const response = await fetch(new URL(pathname.replace(/^\//, ""), baseUrl), {
		...init,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(30_000),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} returned HTTP ${response.status}: ${body.slice(0, 1_000)}`);
	return body ? JSON.parse(body) : null;
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
	const deadline = performance.now() + timeoutMs;
	let lastError;
	while (performance.now() < deadline) {
		try {
			const result = await predicate();
			if (result) return result;
		} catch (error) { lastError = error; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function gatewayInvocation(context, sampleRoot, port) {
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
		spawn() {
			return spawnGateway({
				args: [
					path.join(context.repoRoot, "dist", "server", "cli.js"),
					"--cwd", workspace,
					"--host", "127.0.0.1",
					"--port", String(port),
					"--no-tls",
					"--static", path.join(context.repoRoot, "dist", "ui"),
					"--agent-cli", path.join(context.repoRoot, "tests", "e2e", "mock-agent.mjs"),
				],
				cwd: context.repoRoot,
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

async function prepareRestoredSession(context, sampleRoot) {
	const invocation = gatewayInvocation(context, sampleRoot, await getFreePort());
	await Promise.all([
		invocation.workspace,
		invocation.gatewayDir,
		invocation.agentDir,
		invocation.homeDir,
		invocation.secretsDir,
	].map(directory => mkdir(directory, { recursive: true })));
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
	try {
		await waitForGatewayReady({ runtime, baseUrl: invocation.baseUrl, timeoutMs: SAMPLE_TIMEOUT_MS });
		let projects = await apiJson(invocation.baseUrl, "/api/projects");
		let project = projects.find(candidate => candidate.rootPath && path.resolve(candidate.rootPath) === path.resolve(invocation.workspace));
		if (!project) {
			project = await apiJson(invocation.baseUrl, "/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "benchmark", rootPath: invocation.workspace, acceptCanonical: true }),
			});
		}
		const session = await apiJson(invocation.baseUrl, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: invocation.workspace, projectId: project.id, worktree: false }),
		});
		await waitFor(async () => {
			const current = await apiJson(invocation.baseUrl, `/api/sessions/${session.id}`);
			return current.status === "idle" ? current : null;
		}, "new benchmark session to become idle", 60_000);
		const storeFile = path.join(invocation.workspace, ".bobbit", "state", "sessions.json");
		const persisted = await waitFor(async () => {
			const store = JSON.parse(await readFile(storeFile, "utf8"));
			const rows = Array.isArray(store) ? store : store.sessions;
			return rows?.find(row => row.id === session.id && typeof row.agentSessionFile === "string") ?? null;
		}, "session transcript path to persist", 30_000);
		await stopGateway(runtime, { baseUrl: invocation.baseUrl });
		runtime = null;

		await writeFile(persisted.agentSessionFile, await readFile(path.join(sampleRoot, "fixture", "transcript.jsonl")));
		const sidecarDir = path.join(invocation.gatewayDir, "state", "compaction-sidecar");
		await mkdir(sidecarDir, { recursive: true });
		await writeFile(
			path.join(sidecarDir, `${session.id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`),
			await readFile(path.join(sampleRoot, "fixture", "compactions.jsonl")),
		);

		runtime = invocation.spawn();
		await waitForGatewayReady({ runtime, baseUrl: invocation.baseUrl, timeoutMs: SAMPLE_TIMEOUT_MS });
		await waitFor(async () => {
			const current = await apiJson(invocation.baseUrl, `/api/sessions/${session.id}`);
			return current.status === "idle" ? current : null;
		}, "restored benchmark session to become interactive", 60_000);
		return { invocation, runtime, sessionId: session.id };
	} catch (error) {
		if (runtime) await stopGateway(runtime, { baseUrl: invocation.baseUrl }).catch(() => {});
		throw error;
	}
}

function metricValue(metrics, name) {
	return metrics?.find(metric => metric.name === name)?.value ?? null;
}

async function measureBrowserSample(restored, manifest) {
	const browserRuntime = await launchBenchmarkBrowser({
		viewport: SESSION_OPEN_VIEWPORT,
		launchOptions: { args: ["--enable-precise-memory-info"] },
	});
	let snapshotFrameBytes = 0;
	try {
		await browserRuntime.context.addInitScript(() => {
			localStorage.setItem("bobbit-perf-instrumentation", "1");
			window.__bobbitSessionOpenMetrics = { longTasks: [], heap: [] };
			try {
				new PerformanceObserver(list => {
					for (const entry of list.getEntries()) window.__bobbitSessionOpenMetrics.longTasks.push(entry.duration);
				}).observe({ type: "longtask", buffered: true });
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

		await browserRuntime.page.goto(`${restored.invocation.baseUrl}#/session/${restored.sessionId}`, {
			waitUntil: "domcontentloaded",
			timeout: SAMPLE_TIMEOUT_MS,
		});
		await browserRuntime.page.waitForFunction(lastMarker => {
			const editor = document.querySelector("message-editor textarea");
			const timing = window.__bobbitBootTimings;
			return !!editor && !editor.disabled && editor.getClientRects().length > 0
				&& document.body.textContent.includes(lastMarker)
				&& timing?.marks?.some(mark => mark.name === "post-snapshot-paint");
		}, LAST_MARKER, { timeout: SAMPLE_TIMEOUT_MS });
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
				heap: [...(window.__bobbitSessionOpenMetrics?.heap ?? [])],
			};
		});
		let heapAfterInteractive = null;
		if (browserRuntime.cdp) {
			const afterInteractive = await browserRuntime.cdp.send("Performance.getMetrics");
			heapAfterInteractive = metricValue(afterInteractive.metrics, "JSHeapUsedSize");
		}

		await browserRuntime.page.evaluate(async () => {
			window.DeferredBlock?.forceResolveAll();
			for (const element of document.querySelectorAll("deferred-block, message-list, user-message, assistant-message")) {
				if (element.updateComplete) await element.updateComplete;
			}
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		});
		await browserRuntime.page.waitForFunction(expected =>
			document.querySelectorAll('[data-testid="compaction-summary-card"]').length === expected,
		manifest.expectedCompactionIds.length,
		{ timeout: 30_000 });

		const oracle = await browserRuntime.page.evaluate(async ({ firstMarker, lastMarker }) => {
			const agent = document.querySelector("agent-interface");
			const messages = agent?.session?.state?.messages;
			if (!Array.isArray(messages)) throw new Error("Interactive session did not expose a client transcript");
			const normalizeError = message => {
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
					projected.isError = normalizeError(message);
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
				uniqueIds: new Set(ids).size === ids.length,
				monotonicOrder: orders.every((order, index) => Number.isFinite(order) && (index === 0 || order > orders[index - 1])),
				toolPairCount: toolCalls.filter(id => toolResults.has(id)).length,
				toolCallCount: toolCalls.length,
				errorIds: messages.filter(message => message?.role === "toolResult" && normalizeError(message)).map(message => message.id).filter(Boolean),
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
			[oracle.uniqueIds, "unique message ids"],
			[oracle.monotonicOrder, "strict snapshot order"],
			[oracle.toolCallCount === expectedToolCount && oracle.toolPairCount === expectedToolCount, `tool call/result pairs ${oracle.toolPairCount}/${oracle.toolCallCount}/${expectedToolCount}`],
			[JSON.stringify(oracle.errorIds) === JSON.stringify(manifest.expectedErrorIds), `legacy error normalization ${oracle.errorIds.length}/${manifest.expectedErrorIds.length}`],
			[oracle.compactionCount === manifest.expectedCompactionIds.length, `compaction cards ${oracle.compactionCount}/${manifest.expectedCompactionIds.length}`],
			[oracle.firstMarkerCount === 1 && oracle.lastMarkerCount === 1, `first/last markers ${oracle.firstMarkerCount}/${oracle.lastMarkerCount}`],
		];
		const failure = assertions.find(([passed]) => !passed);
		if (failure) throw new Error(`Session-open parity failed: ${failure[1]}`);

		const longTaskTotalMs = timing.longTasks.reduce((sum, value) => sum + value, 0);
		const heapSamples = [heapBefore, heapAfterInteractive, ...timing.heap].filter(Number.isFinite);
		const serverTiming = timing.serverTiming ?? {};
		const metrics = Object.fromEntries(Object.entries({
			timeToInteractiveMs: timing.now - timing.sent,
			serverResponseLatencyMs: timing.received - timing.sent,
			transferredBytes: snapshotFrameBytes || timing.snapshotChars,
			longTaskCount: timing.longTasks.length,
			longTaskTotalMs,
			longTaskMaxMs: timing.longTasks.length ? Math.max(...timing.longTasks) : 0,
			heapGrowthBytes: Number.isFinite(heapBefore) && Number.isFinite(heapAfterInteractive) ? heapAfterInteractive - heapBefore : null,
			heapPeakBytes: heapSamples.length ? Math.max(...heapSamples) : null,
			rpcMs: serverTiming.rpcMs ?? null,
			pipelineMs: serverTiming.pipelineMs ?? null,
			stampMs: serverTiming.stampMs ?? null,
			stringifyMs: serverTiming.stringifyMs ?? null,
		}).filter(([, value]) => Number.isFinite(value)));
		return {
			metrics,
			correctness: oracle,
			browserVersion: browserRuntime.browser.version(),
			metricSupport: {
				webSocketFrames: snapshotFrameBytes > 0 ? "reliable" : "estimated-from-client-frame-chars",
				longTasks: "reliable-in-chromium",
				heap: heapSamples.length ? "chromium-precise-memory-lower-confidence-peak-sampling" : "unsupported",
			},
		};
	} finally {
		await closeBenchmarkBrowser(browserRuntime);
	}
}

async function runSample(context, entry, fixture) {
	const sampleRoot = await context.createSampleRoot(entry, { fixtureRoot: fixture.directory });
	let restored;
	try {
		restored = await prepareRestoredSession(context, sampleRoot);
		const measured = await measureBrowserSample(restored, fixture.manifest);
		return {
			case: entry.case,
			phase: entry.phase,
			cycle: entry.cycle,
			order: entry.order,
			caseOrder: entry.caseOrder,
			metrics: measured.metrics,
			correctness: {
				status: "passed",
				messageCount: measured.correctness.messageCount,
				renderCount: measured.correctness.renderCount,
				toolPairCount: measured.correctness.toolPairCount,
				errorCount: measured.correctness.errorIds.length,
				compactionCount: measured.correctness.compactionCount,
				semanticSha256: measured.correctness.semanticSha256,
				renderIdsSha256: measured.correctness.renderIdsSha256,
			},
			metricReliability: measured.metricSupport,
			browserVersion: measured.browserVersion,
		};
	} finally {
		if (restored?.runtime) {
			await stopGateway(restored.runtime, { baseUrl: restored.invocation.baseUrl });
		}
	}
}

export async function runJourney(context) {
	const fixtures = new Map();
	for (const fixtureCase of SESSION_OPEN_CASES) {
		fixtures.set(fixtureCase.name, await generateSessionOpenFixture(context.paths.fixtures, fixtureCase));
	}
	const schedule = context.scheduleFor(SESSION_OPEN_CASES.map(fixtureCase => fixtureCase.name));
	const samples = [];
	let browserVersion = null;
	let metricSupport = {};
	for (const entry of schedule) {
		const sample = await runSample(context, entry, fixtures.get(entry.case));
		browserVersion ??= sample.browserVersion;
		metricSupport = { ...metricSupport, ...sample.metricReliability };
		samples.push(sample);
	}
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
			}];
		})),
		fixtureHashes: Object.fromEntries(SESSION_OPEN_CASES.map(fixtureCase => {
			const manifest = fixtures.get(fixtureCase.name).manifest;
			return [fixtureCase.name, {
				transcriptSha256: manifest.transcriptSha256,
				semanticSha256: manifest.expectedSemanticSha256,
				renderIdsSha256: manifest.expectedRenderIdsSha256,
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
			legacyErrorNormalization: true,
			compactionParity: true,
		},
		interpretation: "Validate semantic and rendered-order hashes first. Compare time-to-interactive and response latency only across alternating runs on the same host and build.",
		limitations: [
			"Chromium heap peak is sampled and is not a process-wide memory high-water mark.",
			"WebSocket transfer bytes use CDP payload bytes when available and client frame characters otherwise.",
			"Forcing all deferred blocks is part of parity validation but occurs after the measured interactive boundary.",
		],
		noiseSources: [
			"filesystem cache and antivirus scanning",
			"browser JIT and garbage collection",
			"CPU frequency scaling, thermal state, and process scheduling",
		],
		comparisonMethod: "Use identical fixture hashes, schema, host, power state, Node and Chromium versions. Alternate baseline and candidate invocations, then inspect raw samples, median, p95, MAD, and coefficient of variation.",
	};
}
