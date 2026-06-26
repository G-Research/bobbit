/**
 * Model-registry tests for the google-gemini-cli (Code Assist / OAuth) provider.
 *
 * Pins two invariants from docs/design/google-oauth-model-auth.md §4.5:
 *  1. An OAuth credential only authenticates OAuth-capable providers — a generic
 *     auth.json token must NOT make the API-key-only `google` provider look usable.
 *  2. google-gemini-cli Gemini models are emitted (with api "google-code-assist")
 *     only when a Google account credential is present.
 *  3. Once agent-side Code Assist runtime support exists, account models are
 *     session-selectable (no sessionSelectable:false gate).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { PreferencesStore } from "../src/server/agent/preferences-store.js";
import { clearOAuthCache, getAvailableModels, invalidateModelCache, isOAuthCapableProvider } from "../src/server/agent/model-registry.js";
import { pinAgentDirForTest, resetAgentDirForTest } from "./helpers/agent-dir.js";

const prevAgentDir = process.env.BOBBIT_AGENT_DIR;
const prevGoogleKey = process.env.GOOGLE_API_KEY;
const prevGeminiKey = process.env.GEMINI_API_KEY;
let dir: string;
let prefs: PreferencesStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "bobbit-gca-reg-"));
	process.env.BOBBIT_AGENT_DIR = dir;
	pinAgentDirForTest(dir);
	// Ensure the API-key `google` provider is NOT authenticated by ambient env.
	delete process.env.GOOGLE_API_KEY;
	delete process.env.GEMINI_API_KEY;
	prefs = new PreferencesStore(path.join(dir, "prefs"));
	invalidateModelCache();
	clearOAuthCache();
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR; else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
	if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevGoogleKey;
	if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
	resetAgentDirForTest();
	rmSync(dir, { recursive: true, force: true });
	invalidateModelCache();
});

function writeAuth(cred: Record<string, unknown>): void {
	writeFileSync(path.join(dir, "auth.json"), JSON.stringify(cred), "utf-8");
	invalidateModelCache();
	clearOAuthCache();
}

describe("isOAuthCapableProvider", () => {
	it("includes the OAuth/account providers and excludes API-key-only google", () => {
		assert.equal(isOAuthCapableProvider("anthropic"), true);
		assert.equal(isOAuthCapableProvider("openai-codex"), true);
		assert.equal(isOAuthCapableProvider("google-gemini-cli"), true);
		assert.equal(isOAuthCapableProvider("google"), false);
	});
});

describe("Google account model emission + auth isolation", () => {
	it("does not emit google-gemini-cli models when no account credential exists", async () => {
		const models = await getAvailableModels(prefs);
		assert.equal(models.some((m) => m.provider === "google-gemini-cli"), false);
	});

	it("emits authenticated google-gemini-cli Code Assist models when credential present", async () => {
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok", expires: Date.now() + 60_000 } });
		const models = await getAvailableModels(prefs);
		const account = models.filter((m) => m.provider === "google-gemini-cli");
		assert.ok(account.length > 0, "expected at least one google-gemini-cli model");
		for (const m of account) {
			assert.equal(m.api, "google-code-assist");
			assert.equal(m.authenticated, true);
			assert.match(m.id, /^gemini-/);
		}
	});

	it("marks google-gemini-cli account models as session-selectable (runtime support exists)", async () => {
		// The generated Code Assist provider extension registers a google-code-assist
		// api in the agent runtime, so account models can now be bound to a session.
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok", expires: Date.now() + 60_000 } });
		const models = await getAvailableModels(prefs);
		const account = models.filter((m) => m.provider === "google-gemini-cli");
		assert.ok(account.length > 0, "expected at least one google-gemini-cli model");
		for (const m of account) {
			assert.notEqual(m.sessionSelectable, false, `${m.id} must be selectable for sessions`);
			assert.equal(m.sessionUnavailableReason, undefined, `${m.id} must not carry an unavailable reason`);
		}
	});

	it("does not emit Developer-API-only Gemini models that Code Assist 404s on", async () => {
		// Live Code Assist probes return HTTP 404 "Requested entity not found" for
		// gemini-2.0-*, gemini-3.5-flash, and the *-latest aliases even though pi-ai's
		// `google` catalog carries them. They must be excluded from the account list.
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok", expires: Date.now() + 60_000 } });
		const models = await getAvailableModels(prefs);
		const accountIds = new Set(models.filter((m) => m.provider === "google-gemini-cli").map((m) => m.id));
		assert.ok(accountIds.size > 0, "expected at least one google-gemini-cli model");
		for (const unsupported of [
			"gemini-2.0-flash",
			"gemini-2.0-flash-lite",
			"gemini-3.5-flash",
			"gemini-flash-latest",
			"gemini-flash-lite-latest",
		]) {
			assert.equal(accountIds.has(unsupported), false, `${unsupported} must not be emitted (Code Assist 404)`);
		}
	});

	it("emits the supported Code Assist Gemini models", async () => {
		writeAuth({ "google-gemini-cli": { type: "oauth", access: "tok", expires: Date.now() + 60_000 } });
		const models = await getAvailableModels(prefs);
		const accountIds = new Set(models.filter((m) => m.provider === "google-gemini-cli").map((m) => m.id));
		// These are confirmed-serving ids that are also present in pi-ai's catalog.
		for (const supported of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.1-pro-preview"]) {
			assert.equal(accountIds.has(supported), true, `${supported} must be emitted (Code Assist supported)`);
		}
	});

	it("keeps API-key google (Gemini Developer API) models selectable for sessions", async () => {
		// The always-working API-key fallback must never be gated. Authenticate it via env.
		process.env.GOOGLE_API_KEY = "test-key";
		try {
			invalidateModelCache();
			const models = await getAvailableModels(prefs);
			const googleModels = models.filter((m) => m.provider === "google");
			assert.ok(googleModels.length > 0, "expected built-in google models");
			for (const m of googleModels) {
				assert.equal(m.authenticated, true, `${m.id} should be authenticated by GOOGLE_API_KEY`);
				assert.notEqual(m.sessionSelectable, false, `${m.id} must stay selectable for sessions`);
			}
		} finally {
			delete process.env.GOOGLE_API_KEY;
			invalidateModelCache();
		}
	});

	it("a generic OAuth token does not authenticate the API-key-only google provider", async () => {
		// Top-level token (legacy generic shape) + a google-gemini-cli entry.
		writeAuth({ access_token: "generic", "google-gemini-cli": { type: "oauth", access: "tok" } });
		const models = await getAvailableModels(prefs);
		const googleModels = models.filter((m) => m.provider === "google");
		assert.ok(googleModels.length > 0, "expected built-in google models");
		for (const m of googleModels) {
			assert.equal(m.authenticated, false, `${m.id} must not be authenticated by an OAuth token`);
		}
	});
});
