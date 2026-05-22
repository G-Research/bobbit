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
import { readE2EToken, base } from "./e2e-setup.js";

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

type ImageCloudProvider = "openai" | "google";

async function assertPublicStateDoesNotLeakSecret(secret: string): Promise<void> {
	for (const path of ["/api/preferences", "/api/cloud-providers/status"]) {
		const resp = await api(path);
		expect(resp.ok).toBe(true);
		const body = await resp.json();
		expect(JSON.stringify(body)).not.toContain(secret);
	}
}

async function saveProviderKey(provider: ImageCloudProvider, key: string): Promise<void> {
	const resp = await api(`/api/provider-keys/${provider}`, {
		method: "POST",
		body: JSON.stringify({ key, enable: true }),
	});
	expect(resp.ok).toBe(true);
	const body = await resp.json();
	expect(body.ok).toBe(true);
	expect(body.provider).toBe(provider);
	expect(body.enabled).toBe(true);
	expect(JSON.stringify(body)).not.toContain(key);
	await assertPublicStateDoesNotLeakSecret(key);
}

async function setCloudProviderEnabled(provider: ImageCloudProvider, enabled: boolean): Promise<void> {
	const resp = await api(`/api/cloud-providers/${provider}`, {
		method: "PUT",
		body: JSON.stringify({ enabled }),
	});
	expect(resp.ok).toBe(true);
}

async function cleanupProvider(provider: ImageCloudProvider): Promise<void> {
	const keyResp = await api(`/api/provider-keys/${provider}`, { method: "DELETE" });
	expect(keyResp.ok).toBe(true);
	await setCloudProviderEnabled(provider, false);
}

test.describe("image-generation provider branches", () => {
	test.afterEach(async () => {
		// Restore API keys and provider opt-in state that tests poked at.
		await cleanupProvider("openai");
		await cleanupProvider("google");
	});

	test("generateOpenAIImage: DALL-E path (dall-e-3) returns base64 image", async () => {
		await saveProviderKey("openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(JSON.stringify({
					data: [{ b64_json: FAKE_PNG_B64, revised_prompt: "a cat" }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "a cat", model: "openai/dall-e-3" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.id).toBe("dall-e-3");
			expect(Array.isArray(body.images)).toBe(true);
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
			expect(body.images[0].revisedPrompt).toBe("a cat");
		} finally {
			shim.restore();
		}
	});

	test("generateOpenAIImage: GPT Image 2 path returns base64 image", async () => {
		await saveProviderKey("openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(JSON.stringify({
					data: [{ b64_json: FAKE_PNG_B64 }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "a sunset", model: "openai/gpt-image-2", format: "png" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.id).toBe("gpt-image-2");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
			expect(body.images[0].mimeType).toBe("image/png");
		} finally {
			shim.restore();
		}
	});

	test("generateGeminiImage: inlineData decoded", async () => {
		await saveProviderKey("google", "test-google-key");
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
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "a panda", model: "google/gemini-2.5-flash-image" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.api).toBe("gemini-images");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
		} finally {
			shim.restore();
		}
	});

	test("generateImagenImage: predictions decoded", async () => {
		await saveProviderKey("google", "test-google-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("generativelanguage.googleapis.com") && u.includes(":predict"),
				respond: () => new Response(JSON.stringify({
					predictions: [{ bytesBase64Encoded: FAKE_PNG_B64 }],
				}), { status: 200, headers: { "content-type": "application/json" } }),
			},
		]);
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "a city", model: "google/imagen-4.0-fast-generate-001" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.model.api).toBe("google-imagen");
			expect(body.images[0].data).toBe(FAKE_PNG_B64);
		} finally {
			shim.restore();
		}
	});

	test("error stringification: malformed data.error never produces [object Object]", async () => {
		await saveProviderKey("openai", "test-openai-key");
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
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "x", model: "openai/dall-e-3" }),
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
		}
	});

	test("status code prefix: thrown message begins with HTTP status", async () => {
		await saveProviderKey("openai", "test-openai-key");
		const shim = shimFetch([
			{
				match: (u) => u.includes("api.openai.com") && u.includes("/images/generations"),
				respond: () => new Response(
					JSON.stringify({ error: { message: "rate limited" } }),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
			},
		]);
		try {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "x", model: "openai/dall-e-3" }),
			});
			expect(resp.status).toBe(500);
			const body = await resp.json();
			expect(body.error).toMatch(/^429\b/);
			expect(body.error).toContain("rate limited");
		} finally {
			shim.restore();
		}
	});

	test("server validation: prompt > 8192 chars → 400 'prompt exceeds 8192 chars'", async () => {
		const resp = await api("/api/image-generation/generate", {
			method: "POST",
			body: JSON.stringify({ prompt: "x".repeat(8193), model: "openai/gpt-image-2" }),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBe("prompt exceeds 8192 chars");
	});

	test("server validation: n outside [1,4] → 400 'n must be 1..4'", async () => {
		for (const bad of [0, 5, -1, 1.5]) {
			const resp = await api("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "x", n: bad, model: "openai/gpt-image-2" }),
			});
			expect(resp.status, `n=${bad} should fail validation`).toBe(400);
			const body = await resp.json();
			expect(body.error).toBe("n must be 1..4");
		}
	});

	test("server validation: missing prompt → 400", async () => {
		const resp = await api("/api/image-generation/generate", {
			method: "POST",
			body: JSON.stringify({ model: "openai/gpt-image-2" }),
		});
		expect(resp.status).toBe(400);
	});
});
