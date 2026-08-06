import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, defaultProject, deleteSession, rawApiFetch } from "./_e2e/e2e-setup.js";

const PACK_ID = "tool-result-filter-fixture";
const FIXTURE_ROOT = path.resolve("tests2/_fixtures/tool-result-filter");
const REJECTED = "EP14_FIXTURE_REJECT__route_canary_never_fanout";
const REDACTED = "EP14_FIXTURE_REDACT__route_canary_never_fanout";
const REPLACED = "EP14_FIXTURE_REPLACE__route_canary_never_fanout";
const ORDERED = "EP14_FIXTURE_ORDER_EP14_FIXTURE_REJECT__route_canary_never_fanout";

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
	// The contract deliberately reserves distinct stable identities for the
	// matching rule and its safe reason code. Keep this copied legacy fixture
	// compatible without mutating the checked-in fixture owned by another task.
	for (const module of ["result-filter.mjs", "competing-result-filter.mjs"]) {
		const file = path.join(target, "lib", module);
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll('reasonCode: "fixture-', 'reasonCode: "reason-fixture-'), "utf8");
	}
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

async function postFilter(sessionId: string, body: unknown): Promise<any> {
	const response = await apiFetch(filterPath(sessionId), { method: "POST", body: JSON.stringify(body) });
	expect(response.status).toBe(200);
	return json(response);
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

	test.beforeAll(async ({ gateway }) => {
		packDir = installFixture(gateway.bobbitDir);
		projectId = (await defaultProject()).id;
		cookie = await operatorCookie();
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, await activation.text()).toBe(200);
	});

	test.beforeEach(async () => { sessionId = await createSession({ projectId }); });
	test.afterEach(async () => {
		if (projectId && cookie) {
			await revoke(projectId, cookie, "result-filter").catch(() => {});
			await revoke(projectId, cookie, "competing-result-filter").catch(() => {});
		}
		if (sessionId) await deleteSession(sessionId);
	});
	test.afterAll(async () => { if (packDir) fs.rmSync(packDir, { recursive: true, force: true }); });

	test("is inert without an exact grant", async () => {
		const envelope = { toolCallId: "ungranted-call", toolName: "fixture-tool", result: result(REJECTED) };
		const response = await postFilter(sessionId, envelope);
		expect(response).toEqual(envelope.result);
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
			expect.objectContaining({ sessionId, toolCallId: "audit-rejected-call", toolName: "fixture-tool", packId: PACK_ID, hookId: "result-filter", action: "reject", outcome: "applied", reasonCode: "reason-fixture-reject", ruleId: "fixture-reject" }),
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
			expect.objectContaining({ kind: "audit", packId: PACK_ID, hookId: "result-filter", event: "afterToolResult", outcome: "applied", reason: "Tool result withheld", value: "fixture-reject" }),
		]));
		expect(JSON.stringify(trace)).not.toContain(REJECTED);
		expect(JSON.stringify(trace)).not.toContain("privateCanary");
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
