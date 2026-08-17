import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import { generateToolResultFilterExtension } from "../../src/server/agent/tool-result-filter-extension.js";
import { createToolResultFilterAttemptToken, type ToolResultFilterGateCredential } from "../../src/server/agent/tool-result-filter-attempt-credentials.js";
import { expect, test } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, defaultProject, deleteSession, rawApiFetch, readE2EToken } from "./_e2e/e2e-setup.js";

const PACK_ID = "tool-result-filter-fixture";
const FIXTURE_ROOT = path.resolve("tests2/_fixtures/tool-result-filter");
const REJECTED = "EP14_FIXTURE_REJECT__route_canary_never_fanout";
const REDACTED = "EP14_FIXTURE_REDACT__route_canary_never_fanout";
const REPLACED = "EP14_FIXTURE_REPLACE__route_canary_never_fanout";
const ORDERED = "EP14_FIXTURE_ORDER_EP14_FIXTURE_REJECT__route_canary_never_fanout";
const METADATA_CANARY = "EP14_FIXTURE_METADATA_CANARY";

function grantsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

function filterPath(sessionId: string): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/tool-result-filter`;
}

function fixturePackDir(bobbitDir: string): string {
	return path.join(bobbitDir, "config", "market-packs", PACK_ID);
}

function installFixture(bobbitDir: string): string {
	const target = fixturePackDir(bobbitDir);
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(FIXTURE_ROOT, target, { recursive: true });
	fs.writeFileSync(path.join(target, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n", "utf8");
	return target;
}

async function json(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function operatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	const cookie = setCookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session=")) ?? "";
	expect(cookie).not.toBe("");
	return cookie;
}

function result(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		content: [{ type: "text", text }],
		details: { privateCanary: text },
		isError: false,
		usage: { inputTokens: 7, outputTokens: 11 },
		...overrides,
	};
}

function consoleLine(args: unknown[]): string {
	return args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" ");
}

/** Captures only the synchronous route request window and always restores globals. */
async function captureServerConsole<T>(callback: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
	const lines: string[] = [];
	const original = { log: console.log, warn: console.warn, error: console.error };
	const collect = (level: string, write: (...args: unknown[]) => void) => (...args: unknown[]) => {
		lines.push(`[${level}] ${consoleLine(args)}`);
		Reflect.apply(write, console, args);
	};
	console.log = collect("log", original.log);
	console.warn = collect("warn", original.warn);
	console.error = collect("error", original.error);
	try {
		return { value: await callback(), lines };
	} finally {
		console.log = original.log;
		console.warn = original.warn;
		console.error = original.error;
	}
}

function expectNoCanaryInServerLogs(lines: string[]): void {
	const rendered = lines.join("\n");
	for (const canary of [REJECTED, REDACTED, REPLACED, ORDERED, METADATA_CANARY]) {
		expect(rendered).not.toContain(canary);
	}
}

let runtimeCredential: ToolResultFilterGateCredential | undefined;

async function postFilter(sessionId: string, body: unknown): Promise<any> {
	const toolCallId = body && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>).toolCallId : undefined;
	const attempt = typeof toolCallId === "string" && runtimeCredential
		? createToolResultFilterAttemptToken(runtimeCredential, sessionId, toolCallId, randomUUID())
		: undefined;
	const captured = await captureServerConsole(async () => {
		const response = await apiFetch(filterPath(sessionId), {
			method: "POST", body: JSON.stringify(body),
			headers: attempt ? { "X-Bobbit-Tool-Result-Attempt": attempt } : undefined,
		});
		expect(response.status).toBe(200);
		return json(response);
	});
	expectNoCanaryInServerLogs(captured.lines);
	return captured.value;
}

/** Loads the production-generated gate and forwards its untouched HTTP request to the live route. */
async function installLiveGeneratedGate(sessionId: string, credential: ToolResultFilterGateCredential): Promise<{
	gate: (event: unknown) => Promise<any>;
	requests: Array<{ url: string; body: string }>;
	close: () => Promise<void>;
}> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "ep14-live-result-gate-"));
	const file = path.join(temp, "gate.mjs");
	const originalFetch = globalThis.fetch;
	const originalGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
	const originalToken = process.env.BOBBIT_TOKEN;
	const requests: Array<{ url: string; body: string }> = [];
	try {
		await writeFile(file, generateToolResultFilterExtension(sessionId), "utf8");
		process.env.BOBBIT_GATEWAY_URL = base();
		process.env.BOBBIT_TOKEN = readE2EToken();
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), body: String(init?.body ?? "") });
			// Preserve the exact generated body and authentication headers; this is
			// the real route response that the generated gate then parses.
			return originalFetch(url, init);
		}) as typeof globalThis.fetch;
		const mod = await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`);
		const gate = mod.default(credential);
		if (typeof gate !== "function") throw new Error("generated result gate did not return a function");
		return {
			gate,
			requests,
			close: async () => {
				globalThis.fetch = originalFetch;
				if (originalGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
				else process.env.BOBBIT_GATEWAY_URL = originalGatewayUrl;
				if (originalToken === undefined) delete process.env.BOBBIT_TOKEN;
				else process.env.BOBBIT_TOKEN = originalToken;
				await rm(temp, { recursive: true, force: true });
			},
		};
	} catch (error) {
		globalThis.fetch = originalFetch;
		if (originalGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
		else process.env.BOBBIT_GATEWAY_URL = originalGatewayUrl;
		if (originalToken === undefined) delete process.env.BOBBIT_TOKEN;
		else process.env.BOBBIT_TOKEN = originalToken;
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
}

function expectOrdinaryPiResult(output: any): void {
	expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
	expect(Object.getPrototypeOf(output.content)).toBe(Array.prototype);
	expect(output.content.map).toBe(Array.prototype.map);
	for (const block of output.content) expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
	if (output.details !== undefined) expect(Object.getPrototypeOf(output.details)).toBe(Object.prototype);
	if (output.usage !== undefined) expect(Object.getPrototypeOf(output.usage)).toBe(Object.prototype);
}

async function grant(projectId: string, cookie: string, hookId: string): Promise<void> {
	const response = await apiFetch(grantsPath(projectId), {
		method: "PUT", headers: { Cookie: cookie },
		body: JSON.stringify({ packId: PACK_ID, hookId, capability: "filter:tool-result" }),
	});
	expect(response.status, await response.text()).toBe(200);
}

async function revoke(projectId: string, cookie: string, hookId: string): Promise<void> {
	const response = await apiFetch(`${grantsPath(projectId)}/${PACK_ID}/${hookId}/filter%3Atool-result`, {
		method: "DELETE", headers: { Cookie: cookie },
	});
	expect(response.status, await response.text()).toBe(200);
}

test.describe("tool result filter route", () => {
	let projectId = "";
	let sessionId = "";
	let cookie = "";
	let packDir = "";
	let gatewayManager: any;

	test.beforeAll(async ({ gateway }) => {
		gatewayManager = gateway.sessionManager;
		packDir = installFixture(gateway.bobbitDir);
		projectId = (await defaultProject()).id;
		cookie = await operatorCookie();
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, await activation.text()).toBe(200);
	});

	test.beforeEach(async () => {
		sessionId = await createSession({ projectId });
		runtimeCredential = gatewayManager.toolResultFilterAttemptCredentials.beginRuntime(sessionId, 0);
	});
	test.afterEach(async () => {
		if (projectId && cookie) {
			await revoke(projectId, cookie, "result-filter").catch(() => {});
			await revoke(projectId, cookie, "competing-result-filter").catch(() => {});
		}
		if (sessionId) await deleteSession(sessionId);
	});
	test.afterAll(async () => { if (packDir) fs.rmSync(packDir, { recursive: true, force: true }); });

	test("rejects a forged bearer callback before dispatcher admission or audit", async () => {
		const toolCallId = "forged-attempt-call";
		const response = await apiFetch(filterPath(sessionId), {
			method: "POST",
			body: JSON.stringify({ toolCallId, toolName: "fixture-tool", result: result(REJECTED) }),
			headers: { "X-Bobbit-Tool-Result-Attempt": "v1.bad" },
		});
		expect(response.status).toBe(200);
		const output = await json(response);
		expect(output).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(JSON.stringify(output)).not.toContain(REJECTED);
		const auditResponse = await apiFetch(`/api/sessions/${sessionId}/tool-result-filter-audit?limit=50`, { headers: { Cookie: cookie } });
		expect(auditResponse.status).toBe(200);
		expect((await json(auditResponse)).entries).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ sessionId, toolCallId }),
		]));
	});

	test("is inert without an exact grant", async () => {
		const envelope = { toolCallId: "ungranted-call", toolName: "fixture-tool", result: result(REJECTED) };
		const response = await postFilter(sessionId, envelope);
		expect(response).toEqual(envelope.result);
	});

	test("reconciles a pre-grant live runtime before returning enabled authority", async () => {
		const liveSessionId = await createSession({ projectId });
		try {
			const before = gatewayManager.getSession(liveSessionId);
			expect(before).toBeTruthy();
			expect((gatewayManager.toolResultFilterAttemptCredentials as any).runtimes.get(liveSessionId)).toBeUndefined();

			await grant(projectId, cookie, "result-filter");

			const after = gatewayManager.getSession(liveSessionId);
			expect(after).toBeTruthy();
			expect(after).not.toBe(before);
			// This credential came from the real replacement's setup path, not
			// beginRuntime in the test. A raw canary cannot reach this callback.
			runtimeCredential = (gatewayManager.toolResultFilterAttemptCredentials as any).runtimes.get(liveSessionId);
			expect(runtimeCredential).toBeTruthy();
			const output = await postFilter(liveSessionId, {
				toolCallId: "reconciled-live-call", toolName: "fixture-tool", result: result(REJECTED),
			});
			expect(output).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
			expect(JSON.stringify(output)).not.toContain(REJECTED);
		} finally {
			await deleteSession(liveSessionId);
		}
	});

	test("round-trips generated gate wire bodies through the live route with ordinary Pi-safe output", async () => {
		await grant(projectId, cookie, "result-filter");
		const live = await installLiveGeneratedGate(sessionId, runtimeCredential!);
		const cases = [
			{ id: "generated-pass-false", text: "EP14_GENERATED_PASS_FALSE", isError: false, expectedText: "EP14_GENERATED_PASS_FALSE", expectedError: false },
			{ id: "generated-pass-true", text: "EP14_GENERATED_PASS_TRUE", isError: true, expectedText: "EP14_GENERATED_PASS_TRUE", expectedError: true },
			{ id: "generated-redact", text: REDACTED, isError: true, expectedText: "EP14_SAFE_REDACTED_RESULT", expectedError: false },
			{ id: "generated-replace", text: REPLACED, isError: false, expectedText: "EP14_SAFE_REPLACED_RESULT", expectedError: true },
		] as const;
		try {
			for (const item of cases) {
				// Pi supplies its terminal error bit beside the raw result. The
				// generated gate must move it into the route's canonical result.
				const rawResult = result(item.text);
				delete rawResult.isError;
				const input = { toolCallId: item.id, toolName: "fixture-tool", isError: item.isError, result: rawResult };
				const output = await live.gate(input);
				expect(output.content).toEqual([{ type: "text", text: item.expectedText }]);
				expect(output.isError).toBe(item.expectedError);
				expectOrdinaryPiResult(output);
				if (item.text === REDACTED || item.text === REPLACED) {
					expect(output.details).toBeUndefined();
					expect(output.usage).toBeUndefined();
				} else {
					expect(output.details).toEqual({ privateCanary: item.text });
					expect(output.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
			}
			}
			for (let index = 0; index < cases.length; index++) {
				const sent = JSON.parse(live.requests[index].body);
				expect(live.requests[index].url).toBe(`${base()}/api/sessions/${sessionId}/tool-result-filter`);
				expect(sent).toEqual({
					toolCallId: cases[index].id, toolName: "fixture-tool",
					result: { ...result(cases[index].text), isError: cases[index].isError },
				});
			}
		} finally {
			await live.close();
		}
	});

	test("replaces, redacts, and rejects before the route response can fan out original bytes", async () => {
		await grant(projectId, cookie, "result-filter");
		for (const [canary, safe, error] of [
			[REDACTED, "EP14_SAFE_REDACTED_RESULT", false],
			[REPLACED, "EP14_SAFE_REPLACED_RESULT", true],
		] as const) {
			const output = await postFilter(sessionId, { toolCallId: `call-${safe}`, toolName: "fixture-tool", result: result(canary) });
			expect(output).toEqual({ content: [{ type: "text", text: safe }], isError: error });
			expect(JSON.stringify(output)).not.toContain(canary);
			expect(JSON.stringify(output)).not.toContain("privateCanary");
			expect(JSON.stringify(output)).not.toContain("inputTokens");
		}
		const rejected = await postFilter(sessionId, { toolCallId: "rejected-call", toolName: "fixture-tool", result: result(REJECTED) });
		expect(rejected).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld by project result policy \[ref: [^\]]+\]\.$/) }] });
		expect(JSON.stringify(rejected)).not.toContain(REJECTED);
	});

	test("persists bounded operator-only audit and trace metadata without result bytes", async () => {
		await grant(projectId, cookie, "result-filter");
		await postFilter(sessionId, { toolCallId: "audit-rejected-call", toolName: "fixture-tool", result: result(REJECTED) });

		const unauthorized = await rawApiFetch(`/api/sessions/${sessionId}/tool-result-filter-audit`);
		expect(unauthorized.status).toBe(403);
		const auditResponse = await apiFetch(`/api/sessions/${sessionId}/tool-result-filter-audit?limit=200`, { headers: { Cookie: cookie } });
		expect(auditResponse.status).toBe(200);
		const entries = (await json(auditResponse)).entries as Array<Record<string, unknown>>;
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ sessionId, toolCallId: "audit-rejected-call", toolName: "fixture-tool", packId: PACK_ID, hookId: "result-filter", action: "reject", outcome: "applied", reasonCode: "filter-rejected", ruleId: "result-filter" }),
		]));
		for (const entry of entries) {
			expect(entry.inputBytes).toEqual(expect.any(Number));
			expect(entry.outputBytes).toEqual(expect.any(Number));
			expect(entry.latencyMs).toEqual(expect.any(Number));
			expect(entry).not.toHaveProperty("content");
			expect(entry).not.toHaveProperty("result");
			expect(entry).not.toHaveProperty("error");
			expect(entry).not.toHaveProperty("hash");
		}
		expect(JSON.stringify(entries)).not.toContain(REJECTED);
		expect(JSON.stringify(entries)).not.toContain("privateCanary");

		const traceResponse = await apiFetch(`/api/sessions/${sessionId}/context-trace?limit=20`);
		expect(traceResponse.status).toBe(200);
		const trace = (await json(traceResponse)).entries as Array<Record<string, unknown>>;
		const outcomes = trace.flatMap(entry => Array.isArray(entry.outcomes) ? entry.outcomes : []);
		expect(outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "audit", packId: PACK_ID, hookId: "result-filter", event: "afterToolResult", outcome: "applied", reason: "Tool result withheld", value: "result-filter" }),
		]));
		expect(JSON.stringify(trace)).not.toContain(REJECTED);
		expect(JSON.stringify(trace)).not.toContain("privateCanary");
	});

	test("does not persist worker-supplied metadata identifiers", async () => {
		await grant(projectId, cookie, "result-filter");
		const output = await postFilter(sessionId, { toolCallId: "metadata-call", toolName: "fixture-tool", result: result(METADATA_CANARY) });
		expect(output.content[0].text).toMatch(/^Tool result withheld/);
		const auditResponse = await apiFetch(`/api/sessions/${sessionId}/tool-result-filter-audit?limit=200`, { headers: { Cookie: cookie } });
		expect(auditResponse.status).toBe(200);
		expect(JSON.stringify(await json(auditResponse))).not.toContain(METADATA_CANARY);
		const traceResponse = await apiFetch(`/api/sessions/${sessionId}/context-trace?limit=20`);
		expect(traceResponse.status).toBe(200);
		expect(JSON.stringify(await json(traceResponse))).not.toContain(METADATA_CANARY);
	});

	test("reject wins a competing replacement and a live revoke restores pass-through", async () => {
		await grant(projectId, cookie, "result-filter");
		await grant(projectId, cookie, "competing-result-filter");
		const rejected = await postFilter(sessionId, { toolCallId: "ordered-call", toolName: "fixture-tool", result: result(ORDERED) });
		expect(rejected.content[0].text).toMatch(/^Tool result withheld/);
		expect(JSON.stringify(rejected)).not.toContain(ORDERED);
		expect(JSON.stringify(rejected)).not.toContain("EP14_SAFE_COMPETING_REPLACEMENT");

		await revoke(projectId, cookie, "result-filter");
		await revoke(projectId, cookie, "competing-result-filter");
		const raw = result(REJECTED);
		expect(await postFilter(sessionId, { toolCallId: "revoked-call", toolName: "fixture-tool", result: raw })).toEqual(raw);
	});

	test("fails closed on malformed, oversized, structured, and image-shaped raw inputs", async () => {
		await grant(projectId, cookie, "result-filter");
		for (const raw of [
			{},
			{ toolCallId: "bad", toolName: "fixture-tool", result: { content: [{ type: "text", text: "\ud800" }], isError: false } },
			{ toolCallId: "image", toolName: "fixture-tool", result: { content: [{ type: "image", mediaType: "image/gif", data: "aW1hZ2U=" }], isError: false } },
			// Stay below the HTTP reader cap so the route can prove the canonical
			// result validator's synthetic fail-closed response.
			{ toolCallId: "large", toolName: "fixture-tool", result: { content: [{ type: "text", text: "x".repeat(64 * 1024 + 1) }], isError: false } },
		]) {
			const output = await postFilter(sessionId, raw);
			expect(output).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
			expect(JSON.stringify(output)).not.toContain(REJECTED);
		}
	});
});
