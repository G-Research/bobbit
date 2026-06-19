/**
 * Unit tests for the Google Code Assist adapter (google-gemini-cli runtime path).
 *
 * Covers the pure request/response conversion plus the completion + project
 * resolution flow with an injected fetch (no network, no real credentials).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
	buildGenerateContentBody,
	extractCodeAssistText,
	codeAssistComplete,
	ensureCodeAssistProject,
	resetCodeAssistProjectCache,
	getGoogleAccessToken,
	hasGoogleCodeAssistCredential,
	isSessionSelectableProvider,
	isSessionSelectableModelString,
	GOOGLE_GEMINI_CLI_PROVIDER,
	type FetchLike,
} from "../src/server/agent/google-code-assist.js";
import { getGoogleCodeAssistModels } from "../src/server/agent/google-code-assist-models.js";

const prevAgentDir = process.env.BOBBIT_AGENT_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "bobbit-gca-"));
	process.env.BOBBIT_AGENT_DIR = dir;
	resetCodeAssistProjectCache();
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

function writeAuth(cred: Record<string, unknown>): void {
	writeFileSync(path.join(dir, "auth.json"), JSON.stringify(cred), "utf-8");
}

function jsonFetch(payload: unknown, status = 200): FetchLike {
	return async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
}

describe("buildGenerateContentBody", () => {
	it("wraps prompt under request with model + project", () => {
		const body = buildGenerateContentBody(
			{ model: "gemini-2.5-pro", systemPrompt: "sys", userPrompt: "hi", maxTokens: 50 },
			"proj-1",
		) as any;
		assert.equal(body.model, "gemini-2.5-pro");
		assert.equal(body.project, "proj-1");
		assert.deepEqual(body.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
		assert.deepEqual(body.request.systemInstruction, { role: "user", parts: [{ text: "sys" }] });
		assert.equal(body.request.generationConfig.maxOutputTokens, 50);
	});

	it("omits systemInstruction and project when absent", () => {
		const body = buildGenerateContentBody({ model: "gemini-2.5-flash", userPrompt: "hi" }) as any;
		assert.equal(body.project, undefined);
		assert.equal(body.request.systemInstruction, undefined);
	});

	it("maps a thinking level to a thinkingConfig budget, ignores 'off'", () => {
		const high = buildGenerateContentBody({ model: "m", userPrompt: "x", thinkingLevel: "high" }) as any;
		assert.equal(high.request.generationConfig.thinkingConfig.thinkingBudget, 24576);
		const off = buildGenerateContentBody({ model: "m", userPrompt: "x", thinkingLevel: "off" }) as any;
		assert.equal(off.request.generationConfig, undefined);
	});
});

describe("extractCodeAssistText", () => {
	it("reads text from the wrapped Code Assist response", () => {
		const text = extractCodeAssistText({ response: { candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] } });
		assert.equal(text, "hello world");
	});
	it("falls back to a bare candidates shape", () => {
		assert.equal(extractCodeAssistText({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), "ok");
	});
	it("returns empty string for empty payloads", () => {
		assert.equal(extractCodeAssistText({}), "");
		assert.equal(extractCodeAssistText(null), "");
	});
});

describe("hasGoogleCodeAssistCredential / getGoogleAccessToken", () => {
	it("is false when auth.json has no google-gemini-cli entry", () => {
		writeAuth({ anthropic: { type: "oauth", access: "a" } });
		assert.equal(hasGoogleCodeAssistCredential(), false);
	});

	it("returns a fresh stored access token without refreshing", async () => {
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok-fresh", expires: Date.now() + 60_000 } });
		assert.equal(hasGoogleCodeAssistCredential(), true);
		assert.equal(await getGoogleAccessToken(), "tok-fresh");
	});

	it("returns the stored token as a last resort when expired and no refresh helper", async () => {
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok-stale", expires: Date.now() - 1000 } });
		assert.equal(await getGoogleAccessToken(), "tok-stale");
	});
});

describe("ensureCodeAssistProject", () => {
	it("returns the project from loadCodeAssist when already onboarded", async () => {
		const project = await ensureCodeAssistProject("tok", jsonFetch({ cloudaicompanionProject: "proj-loaded" }));
		assert.equal(project, "proj-loaded");
	});

	it("onboards when loadCodeAssist has no project", async () => {
		let call = 0;
		const fetchFn: FetchLike = async (url) => {
			call++;
			if (url.includes("loadCodeAssist")) return { ok: true, status: 200, text: async () => JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }) };
			return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } }) };
		};
		const project = await ensureCodeAssistProject("tok", fetchFn);
		assert.equal(project, "proj-onboarded");
		assert.ok(call >= 2);
	});
});

describe("codeAssistComplete", () => {
	it("posts to generateContent and returns assistant text", async () => {
		const calls: Array<{ url: string; body: any }> = [];
		const fetchFn: FetchLike = async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body || "{}") });
			return { ok: true, status: 200, text: async () => JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] } }] } }) };
		};
		const out = await codeAssistComplete(
			{ model: "gemini-2.5-pro", systemPrompt: "s", userPrompt: "hi", maxTokens: 5 },
			{ getToken: async () => "tok", getProject: async () => "proj-x", fetchFn },
		);
		assert.equal(out, "OK");
		assert.equal(calls.length, 1);
		assert.match(calls[0].url, /:generateContent$/);
		assert.equal(calls[0].body.project, "proj-x");
		assert.equal(calls[0].body.model, "gemini-2.5-pro");
	});

	it("throws a descriptive error when no account credential is available", async () => {
		await assert.rejects(
			() => codeAssistComplete({ model: "gemini-2.5-pro", userPrompt: "hi" }, { getToken: async () => null }),
			/No Google account credential/,
		);
	});

	it("surfaces an HTTP error body from the Code Assist API", async () => {
		const fetchFn: FetchLike = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
		await assert.rejects(
			() => codeAssistComplete({ model: "gemini-2.5-pro", userPrompt: "hi" }, { getToken: async () => "tok", getProject: async () => "p", fetchFn }),
			/HTTP 401/,
		);
	});

	it("redacts sensitive provider error bodies before surfacing them", async () => {
		const secret = "ya29." + "a".repeat(40) + "." + "b".repeat(40);
		const fetchFn: FetchLike = async () => ({ ok: false, status: 403, text: async () => `denied token=${secret}` });
		await assert.rejects(
			() => codeAssistComplete({ model: "gemini-2.5-pro", userPrompt: "hi" }, { getToken: async () => "tok", getProject: async () => "p", fetchFn }),
			(err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				assert.match(message, /HTTP 403/);
				assert.match(message, /<redacted-jwt>|<redacted-token>/);
				assert.equal(message.includes(secret), false);
				return true;
			},
		);
	});

	it("aborts and rejects when a generateContent fetch never resolves and timeoutMs elapses", async () => {
		let sawSignal = false;
		// Never-resolving fetch: only the timeout race can settle this promise.
		const fetchFn: FetchLike = (_url, init) => {
			if (init.signal) sawSignal = true;
			return new Promise(() => { /* never resolves */ });
		};
		const started = Date.now();
		await assert.rejects(
			() => codeAssistComplete(
				{ model: "gemini-2.5-pro", userPrompt: "hi", timeoutMs: 50 },
				{ getToken: async () => "tok", getProject: async () => "p", fetchFn },
			),
			/timed out after 50ms/,
		);
		assert.ok(Date.now() - started < 5000, "should reject promptly via the timeout, not hang");
		assert.ok(sawSignal, "an AbortSignal should be threaded to fetch so the real request is cancelled");
	});

	it("does not time out when the fetch resolves within timeoutMs", async () => {
		const fetchFn: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] } }] } }) });
		const out = await codeAssistComplete(
			{ model: "gemini-2.5-pro", userPrompt: "hi", timeoutMs: 1000 },
			{ getToken: async () => "tok", getProject: async () => "p", fetchFn },
		);
		assert.equal(out, "OK");
	});
});

describe("session-selectability guard", () => {
	it("flags google-gemini-cli as not session-selectable, others as selectable", () => {
		assert.equal(isSessionSelectableProvider(GOOGLE_GEMINI_CLI_PROVIDER), false);
		assert.equal(isSessionSelectableProvider("anthropic"), true);
		assert.equal(isSessionSelectableProvider("google"), true);
		assert.equal(isSessionSelectableModelString("google-gemini-cli/gemini-2.5-pro"), false);
		assert.equal(isSessionSelectableModelString("anthropic/claude-sonnet-4-5"), true);
		assert.equal(isSessionSelectableModelString("google/gemini-2.5-pro"), true);
	});

	it("malformed strings stay selectable so existing malformed-pref handling is unchanged", () => {
		assert.equal(isSessionSelectableModelString("no-slash"), true);
	});

	it("every emitted Code Assist model is sessionSelectable:false AND fails the guard (no drift)", () => {
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok", expires: Date.now() + 60_000 } });
		const models = getGoogleCodeAssistModels();
		assert.ok(models.length > 0, "expected at least one Code Assist model");
		for (const m of models) {
			assert.equal(m.sessionSelectable, false, `${m.id} should be sessionSelectable:false`);
			assert.equal(isSessionSelectableProvider(m.provider), false, `${m.provider} must fail the binding guard`);
			assert.equal(isSessionSelectableModelString(`${m.provider}/${m.id}`), false, `${m.provider}/${m.id} must fail the binding guard`);
		}
	});
});
