/**
 * API E2E for the per-provider image-generation backends in
 * `src/server/agent/image-generation.ts`.
 *
 * Strategy: in the in-process harness the gateway runs in this same Node
 * process, so we can shim `globalThis.fetch` to intercept upstream provider
 * calls (api.openai.com, generativelanguage.googleapis.com) while letting
 * loopback `http://127.0.0.1:<port>/api/...` requests flow through. We then
 * drive the public REST surface (`POST /api/image-generation/generate`) and
 * assert per-branch behaviour.
 *
 * Coverage:
 *   - generateOpenAIImage: DALL-E (response_format=b64_json) + GPT Image 2
 *     (Images API w/ b64_json + format hint).
 *   - generateGeminiImage: gemini-2.5-flash-image inlineData decode.
 *   - generateImagenImage: imagen-4.0-fast-generate-001 predictions decode.
 *   - Error stringification: malformed `data.error` (Agent A1) — never
 *     produces "[object Object]"; thrown message starts with status code.
 *   - Server-side validation (Agent B B7): prompt > 8192 chars → 400;
 *     n outside [1,4] → 400.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, apiFetch, connectWs, createSession } from "./e2e-setup.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers as Record<string, string> || {}) } });
}

// 1×1 transparent PNG as base64 (decoded server-side as the upstream image).
const FAKE_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface FetchShim {
	restore: () => void;
}

/**
 * Replace globalThis.fetch with a shim that:
 *   - lets through requests to the gateway loopback origin,
 *   - routes all other requests through `routes` by exact URL substring.
 * Returns a `restore()` to put the original fetch back.
 */
function shimFetch(routes: Array<{ match: (url: string) => boolean; respond: (url: string, init?: RequestInit) => Response }>): FetchShim {
	const original = globalThis.fetch;
	const gatewayBase = base();
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input?.url;
		if (typeof url === "string" && url.startsWith(gatewayBase)) {
			return original(input, init);
		}
		// Localhost passthrough (covers any in-process discovery loopbacks).
		if (typeof url === "string" && (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost"))) {
			return original(input, init);
		}
		for (const r of routes) {
			if (typeof url === "string" && r.match(url)) return r.respond(url, init);
		}
		throw new Error(`shimFetch: unmatched URL ${url}`);
	}) as typeof fetch;
	return { restore: () => { globalThis.fetch = original; } };
}

async function setPref(key: string, value: any): Promise<void> {
	const resp = await api("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: value }),
	});
	expect(resp.ok).toBe(true);
}

async function clearPref(key: string): Promise<void> {
	await api("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: null }),
	}).catch(() => {});
}

/**
 * Create a session and pin its image model via the WS `set_image_model` path.
 * The model is now resolved exclusively from the session selector (the tool no
 * longer sends `model`), so provider-branch coverage drives it through a
 * per-session override. Per-session state keeps these tests isolated from the
 * global `default.imageModel` pref (no cross-test contention).
 */
async function sessionWithImageModel(provider: string, modelId: string): Promise<string> {
	const sessionId = await createSession();
	const ws = await connectWs(sessionId);
	try {
		ws.send({ type: "set_image_model", provider, modelId });
		await ws.waitFor(
			(m: any) => m.type === "state" && m.data?.imageGenerationModel?.id === modelId,
			5_000,
		);
	} finally {
		ws.close();
	}
	return sessionId;
}

test.describe("image-generation provider branches", () => {
	test.afterEach(async () => {
		// Restore prefs that tests poked at.
		await clearPref("providerKey.openai");
		await clearPref("providerKey.google");
	});

	test("generateOpenAIImage: DALL-E path (dall-e-3) returns base64 image", async () => {
		await setPref("providerKey.openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(JSON.stringify({
					data: [{ b64_json: FAKE_PNG_B64, revised_prompt: "a cat" }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		const sessionId = await sessionWithImageModel("openai", "dall-e-3");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "a cat" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.id).toBe("dall-e-3");
			expect(Array.isArray(body.images)).toBe(true);
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
			expect(body.images[0].revisedPrompt).toBe("a cat");
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("generateOpenAIImage: GPT Image 2 path returns base64 image", async () => {
		await setPref("providerKey.openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(JSON.stringify({
					data: [{ b64_json: FAKE_PNG_B64 }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		const sessionId = await sessionWithImageModel("openai", "gpt-image-2");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "a sunset", format: "png" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.id).toBe("gpt-image-2");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
			expect(body.images[0].mimeType).toBe("image/png");
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("generateGeminiImage: inlineData decoded", async () => {
		await setPref("providerKey.google", "test-google-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("generativelanguage.googleapis.com") && u.includes(":generateContent"),
				respond: () => new Response(JSON.stringify({
					candidates: [{
						content: {
							parts: [{ inlineData: { mimeType: "image/png", data: FAKE_PNG_B64 } }],
						},
					}],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		const sessionId = await sessionWithImageModel("google", "gemini-2.5-flash-image");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "a panda" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.api).toBe("gemini-images");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("generateImagenImage: predictions decoded", async () => {
		await setPref("providerKey.google", "test-google-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("generativelanguage.googleapis.com") && u.includes(":predict"),
				respond: () => new Response(JSON.stringify({
					predictions: [{ bytesBase64Encoded: FAKE_PNG_B64 }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		const sessionId = await sessionWithImageModel("google", "imagen-4.0-fast-generate-001");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "a city" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.api).toBe("google-imagen");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("error stringification: malformed data.error never produces [object Object]", async () => {
		await setPref("providerKey.openai", "test-openai-key");
		// Provider returns a structured error WITHOUT a `.message` field — old
		// behaviour would `String(data.error)` → "[object Object]".
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(
					JSON.stringify({ error: { code: "policy_violation", details: ["bad prompt"] } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
			},
		]);
		const sessionId = await sessionWithImageModel("openai", "dall-e-3");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "x" }),
			});
			expect(resp.status).toBe(500);
			const body = await resp.json();
			expect(typeof body.error).toBe("string");
			expect(body.error).not.toContain("[object Object]");
			// Per Agent A1: thrown message starts with the upstream HTTP status code.
			expect(body.error).toMatch(/^400\b/);
			// And carries the JSON-stringified provider error structure.
			expect(body.error).toContain("policy_violation");
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("status code prefix: thrown message begins with HTTP status", async () => {
		await setPref("providerKey.openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(
					JSON.stringify({ error: { message: "rate limited" } }),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
			},
		]);
		const sessionId = await sessionWithImageModel("openai", "dall-e-3");
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "x" }),
			});
			expect(resp.status).toBe(500);
			const body = await resp.json();
			expect(body.error).toMatch(/^429\b/);
			expect(body.error).toContain("rate limited");
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("server validation: prompt > 8192 chars → 400 'prompt exceeds 8192 chars'", async () => {
		const resp = await api("/api/image-generation/generate", {
			method: "POST",
			body: JSON.stringify({ prompt: "x".repeat(8193) }),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBe("prompt exceeds 8192 chars");
	});

	test("server validation: n outside [1,4] → 400 'n must be 1..4'", async () => {
		for (const bad of [0, 5, -1, 1.5]) {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "x", n: bad }),
			});
			expect(resp.status, `n=${bad} should fail validation`).toBe(400);
			const body = await resp.json();
			expect(body.error).toBe("n must be 1..4");
		}
	});

	test("server validation: missing prompt → 400", async () => {
		const resp = await api("/api/image-generation/generate", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	test("body.model is ignored — session image-model selector wins (regression guard)", async () => {
		// Core regression guard for the "lock image model to selector" goal:
		// the session's image-model selector is the single source of truth and a
		// tool/body-supplied `model` must NOT override it.
		await setPref("providerKey.openai", "test-openai-key");
		await setPref("providerKey.google", "test-google-key");
		const sessionId = await createSession();
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(JSON.stringify({
					data: [{ b64_json: FAKE_PNG_B64 }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
			{
				match: (u) => u.includes("generativelanguage.googleapis.com"),
				respond: () => new Response(JSON.stringify({
					candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: FAKE_PNG_B64 } }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		try {
			// Set the session image model to gpt-image-2 via WS.
			const ws = await connectWs(sessionId);
			try {
				ws.send({ type: "set_image_model", provider: "openai", modelId: "gpt-image-2" });
				await ws.waitFor(
					(m: any) => m.type === "state" && m.data?.imageGenerationModel?.id === "gpt-image-2",
					5_000,
				);
			} finally {
				ws.close();
			}
			// POST with a DIFFERENT model in the body — it must be ignored.
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "a robot", model: "google/gemini-2.5-flash-image" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.id).toBe("gpt-image-2");
		} finally {
			shim.restore();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
