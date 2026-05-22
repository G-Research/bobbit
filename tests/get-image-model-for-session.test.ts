/**
 * Behaviour test for `SessionManager.getImageModelForSession()` (Agent B's
 * B12 simplification).
 *
 * The reviewer's prior complaint with this file was that it was a regex-on-
 * source check. We can't import the real `SessionManager` from a Node-test
 * (it transitively pulls in flexsearch, which Node 25 ESM rejects via tsx),
 * so this file does two things instead:
 *
 *   1. Asserts the documented per-session/preferences/default *contract*
 *      against a faithful re-host of the function body that consumes the
 *      same `SessionStore` + `PreferencesStore` types the production code
 *      uses. The re-host is loaded from the production source string at
 *      test time, NOT copy-pasted, so any change to the production logic
 *      is picked up automatically.
 *   2. Locks the production source against the dead-fallback regression by
 *      asserting `parseImageModelPref` is called exactly once.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts");

const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");
const { SessionStore } = await import("../src/server/agent/session-store.js");
const {
	defaultImageModelPref,
	getAvailableImageModels,
	parseImageModelPref,
	pickDefaultImageModelPref,
} = await import("../src/server/agent/image-generation.js");

type ImageModel = { provider: string; id: string };

/**
 * Extract the function body verbatim from the production source and rebuild
 * a callable that takes the same dependencies the real method does. This
 * keeps the test in lockstep with the production implementation: any edit
 * to the function body is picked up next test run.
 *
 * The real method now validates persisted overrides against the provider-aware
 * image registry, then falls back to `pickDefaultImageModelPref()` so disabled
 * or unauthenticated direct-cloud providers are not selected silently.
 */
function loadProductionFn(): (
	store: { get: (id: string) => any },
	prefs: { get: (k: string) => unknown },
	parseImageModelPref: (s: string | undefined) => ImageModel | undefined,
	pickDefaultImageModelPref: (prefs: PreferencesStore) => string | undefined,
	isKnownImageModel: (provider: string, modelId: string) => boolean,
	sessionId: string,
) => ImageModel | undefined {
	const src = fs.readFileSync(SOURCE, "utf-8");
	// Find the signature, then the *first* `{` AFTER the closing `)` of the
	// param list — the simple `indexOf("{")` after fnStart matched the brace
	// inside the return-type `{ provider: string; id: string }`.
	const sigPattern = /getImageModelForSession\(sessionId:\s*string\):\s*\{[^}]*\}\s*\|\s*undefined\s*\{/;
	const sigMatch = sigPattern.exec(src);
	assert.ok(sigMatch, "function signature for getImageModelForSession not found");
	const bodyStart = sigMatch.index + sigMatch[0].length;
	const bodyEnd = src.indexOf("\n\t}", bodyStart);
	assert.ok(bodyEnd > bodyStart, "could not locate function body end");
	let body = src.slice(bodyStart, bodyEnd);
	// Rewrite `this.<x>` references to closure variables on our adapter.
	body = body
		.replace(/this\.resolveStoreForId\(sessionId\)/g, "store")
		.replace(/this\.isKnownImageModel\(/g, "isKnownImageModel(")
		.replace(/this\.preferencesStore\?/g, "prefs")
		.replace(/this\.preferencesStore/g, "prefs")
		// Drop TS type assertions — `as string | undefined` etc.
		.replace(/\s+as\s+[^;)\n]+/g, "");
	// eslint-disable-next-line no-new-func
	return new Function(
		"store",
		"prefs",
		"parseImageModelPref",
		"pickDefaultImageModelPref",
		"isKnownImageModel",
		"sessionId",
		body,
	) as any;
}

function makeFixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-getim-"));
	const prefs = new PreferencesStore(dir);
	const store = new SessionStore(dir);
	const id = randomUUID();
	store.put({
		id,
		title: "test",
		cwd: dir,
		agentSessionFile: path.join(dir, `${id}.jsonl`),
		createdAt: Date.now(),
		lastActivity: Date.now(),
	});
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { store, prefs, id, cleanup };
}

const fn = loadProductionFn();
function enableImageProvider(prefs: PreferencesStore, provider: "openai" | "google"): void {
	prefs.set(`providerEnabled.${provider}`, true);
	prefs.set(`providerKey.${provider}`, "test-key");
}

function call(store: any, prefs: PreferencesStore, id: string): ImageModel | undefined {
	const isKnownImageModel = (provider: string, modelId: string) => (
		getAvailableImageModels(prefs).some((m) => m.provider === provider && m.id === modelId)
	);
	return fn(store, prefs, parseImageModelPref, pickDefaultImageModelPref, isKnownImageModel, id);
}

describe("SessionManager.getImageModelForSession (production logic)", () => {
	it("returns per-session override when both imageModelProvider and imageModelId are set", () => {
		const { store, prefs, id, cleanup } = makeFixture();
		try {
			enableImageProvider(prefs, "openai");
			store.update(id, { imageModelProvider: "openai", imageModelId: "gpt-image-2" });
			const got = call(store, prefs, id);
			assert.deepEqual(got, { provider: "openai", id: "gpt-image-2" });
		} finally {
			cleanup();
		}
	});

	it("falls back to `default.imageModel` preference when override absent", () => {
		const { store, prefs, id, cleanup } = makeFixture();
		try {
			enableImageProvider(prefs, "google");
			prefs.set("default.imageModel", "google/gemini-2.5-flash-image");
			const got = call(store, prefs, id);
			assert.deepEqual(got, { provider: "google", id: "gemini-2.5-flash-image" });
		} finally {
			cleanup();
		}
	});

	it("falls back to `defaultImageModelPref()` when no override and no preference", () => {
		const { store, prefs, id, cleanup } = makeFixture();
		try {
			enableImageProvider(prefs, "openai");
			const got = call(store, prefs, id);
			assert.deepEqual(got, parseImageModelPref(defaultImageModelPref()));
			assert.deepEqual(got, { provider: "openai", id: "gpt-image-2" });
		} finally {
			cleanup();
		}
	});

	it("override beats preference", () => {
		const { store, prefs, id, cleanup } = makeFixture();
		try {
			enableImageProvider(prefs, "openai");
			enableImageProvider(prefs, "google");
			prefs.set("default.imageModel", "google/gemini-2.5-flash-image");
			store.update(id, { imageModelProvider: "openai", imageModelId: "gpt-image-2" });
			const got = call(store, prefs, id);
			assert.deepEqual(got, { provider: "openai", id: "gpt-image-2" });
		} finally {
			cleanup();
		}
	});

	it("partial persisted override (only one of provider/id set) is ignored — falls back to default", () => {
		const { store, prefs, id, cleanup } = makeFixture();
		try {
			enableImageProvider(prefs, "openai");
			store.update(id, { imageModelProvider: "openai" });
			const got = call(store, prefs, id);
			assert.deepEqual(got, parseImageModelPref(defaultImageModelPref()));
		} finally {
			cleanup();
		}
	});

	it("source has the dead `|| parseImageModelPref(defaultImageModelPref())` fallback removed (B12 lock)", () => {
		const src = fs.readFileSync(SOURCE, "utf-8");
		const fnStart = src.indexOf("getImageModelForSession(sessionId: string):");
		const fnEnd = src.indexOf("\n\t}", fnStart);
		const body = src.slice(fnStart, fnEnd)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		const matches = body.match(/parseImageModelPref/g) || [];
		assert.equal(matches.length, 1, `expected exactly one parseImageModelPref call; got ${matches.length}`);
		assert.ok(!/\|\|\s*parseImageModelPref\(defaultImageModelPref\(\)\)/.test(body), "dead fallback chain still present");
	});
});
