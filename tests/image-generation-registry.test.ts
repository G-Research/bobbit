import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { canonicalImageModelPref, defaultImageModelPref, generateImage, getAvailableImageModels, getImageModelByPref, imageModelMentionedInText, parseImageModelPref } from "../src/server/agent/image-generation.js";
import { PreferencesStore } from "../src/server/agent/preferences-store.js";

function withPrefs<T>(fn: (prefs: PreferencesStore) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-image-models-"));
	try {
		const result = fn(new PreferencesStore(dir));
		if (result && typeof (result as any).finally === "function") {
			return (result as Promise<unknown>).finally(() => {
				rmSync(dir, { recursive: true, force: true });
			}) as T;
		}
		rmSync(dir, { recursive: true, force: true });
		return result;
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

test("image model registry includes GPT Image 2 and Google image models", () => {
	withPrefs((prefs) => {
		const models = getAvailableImageModels(prefs);
		assert.ok(models.some((m) => m.provider === "openai" && m.id === "gpt-image-2"));
		assert.ok(models.some((m) => m.provider === "google" && m.id === "gemini-3.1-flash-image-preview"));
		assert.ok(models.some((m) => m.provider === "google" && m.id === "gemini-3-pro-image-preview" && m.name === "Gemini 3 Pro Image"));
		assert.ok(models.some((m) => m.provider === "google" && m.id === "imagen-4.0-ultra-generate-001"));
		assert.equal(defaultImageModelPref(), "openai/gpt-image-2");
	});
});

test("image model prefs use provider/modelId format", () => {
	assert.deepEqual(parseImageModelPref("openai/gpt-image-2"), { provider: "openai", id: "gpt-image-2" });
	assert.equal(parseImageModelPref("gpt-image-2"), undefined);
	assert.equal(parseImageModelPref("openai/"), undefined);
});

test("image model registry marks provider auth from preferences", () => {
	withPrefs((prefs) => {
		prefs.set("providerKey.openai", "test-key");
		const model = getAvailableImageModels(prefs).find((m) => m.provider === "openai" && m.id === "gpt-image-2");
		assert.equal(model?.authenticated, true);
	});
});

test("image model registry marks OpenAI auth from Codex auth.json API key", () => {
	const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-image-auth-"));
	try {
		process.env.BOBBIT_AGENT_DIR = dir;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
			"openai-codex": {
				type: "api_key",
				key: "test-openai-codex-key",
			},
		}), "utf-8");
		withPrefs((prefs) => {
			const model = getAvailableImageModels(prefs).find((m) => m.provider === "openai" && m.id === "gpt-image-2");
			assert.equal(model?.authenticated, true);
		});
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.BOBBIT_AGENT_DIR;
		} else {
			process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

function testJwt(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_test",
		},
	})).toString("base64url");
	return `header.${payload}.signature`;
}

test("image model registry marks OpenAI auth from Codex OAuth", () => {
	const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-image-auth-"));
	try {
		process.env.BOBBIT_AGENT_DIR = dir;
		delete process.env.OPENAI_API_KEY;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: testJwt(),
			},
		}), "utf-8");
		withPrefs((prefs) => {
			const model = getAvailableImageModels(prefs).find((m) => m.provider === "openai" && m.id === "gpt-image-2");
			assert.equal(model?.authenticated, true);
		});
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.BOBBIT_AGENT_DIR;
		} else {
			process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		}
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("OpenAI image generation can use Codex OAuth backend", async () => {
	const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	const previousFetch = globalThis.fetch;
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-image-auth-"));
	try {
		process.env.BOBBIT_AGENT_DIR = dir;
		delete process.env.OPENAI_API_KEY;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: testJwt(),
			},
		}), "utf-8");
		globalThis.fetch = (async (url: any, init?: any) => {
			assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
			const body = JSON.parse(init.body);
			assert.equal(body.tools[0].type, "image_generation");
			assert.equal(body.tools[0].model, "gpt-image-2");
			const sse = [
				"data: " + JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "image_generation_call",
						result: Buffer.from("fakepng").toString("base64"),
					},
				}),
				"",
			].join("\n");
			return new Response(sse, { status: 200 });
		}) as typeof fetch;
		await withPrefs(async (prefs) => {
			const result = await generateImage(prefs, { prompt: "test", model: "openai/gpt-image-2" });
			assert.equal(result.images[0].data, Buffer.from("fakepng").toString("base64"));
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) {
			delete process.env.BOBBIT_AGENT_DIR;
		} else {
			process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		}
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("image model override detection requires a user-visible model mention", () => {
	withPrefs((prefs) => {
		assert.equal(
			imageModelMentionedInText(prefs, "google/gemini-2.5-flash-image", "Generate a diagram with the selected model"),
			false,
		);
		assert.equal(
			imageModelMentionedInText(prefs, "google/gemini-2.5-flash-image", "Generate it with Nano Banana"),
			true,
		);
		assert.equal(
			imageModelMentionedInText(prefs, "openai/gpt-image-2", "Could you please use gpt-image-2?"),
			true,
		);
	});
});

test("Google image model aliases resolve to API model IDs", () => {
	withPrefs((prefs) => {
		assert.equal(canonicalImageModelPref("google/nano-banana-2"), "google/gemini-3-pro-image-preview");
		assert.equal(canonicalImageModelPref("google/gemini-3-pro-image"), "google/gemini-3-pro-image-preview");
		assert.equal(canonicalImageModelPref("google/gemini-2.5-flash-image-preview"), "google/gemini-2.5-flash-image");
		assert.equal(canonicalImageModelPref("google/imagen-4-ultra"), "google/imagen-4.0-ultra-generate-001");
		assert.equal(canonicalImageModelPref("google/imagen-4-standard"), "google/imagen-4.0-generate-001");
		assert.equal(canonicalImageModelPref("google/imagen-4-fast"), "google/imagen-4.0-fast-generate-001");
		assert.equal(getImageModelByPref(prefs, "google/gemini-3-pro-image")?.id, "gemini-3-pro-image-preview");
		assert.equal(
			imageModelMentionedInText(prefs, "google/gemini-3-pro-image", "Could you generate one nano banana 2 for comparison?"),
			true,
		);
		assert.equal(
			imageModelMentionedInText(prefs, "google/imagen-4-ultra", "Please use Imagen 4 Ultra"),
			true,
		);
	});
});
