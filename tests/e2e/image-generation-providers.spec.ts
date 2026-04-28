/**
 * API E2E for the per-provider image-generation backends in
 * `src/server/agent/image-generation.ts`.
 *
 * Phase 2 will mock at the HTTP boundary (override `globalThis.fetch` for the
 * upstream provider URLs — see tests/preview-extension.test.ts for the
 * stub-fetch pattern) and assert each provider branch works:
 *   - generateOpenAIImage (DALL-E + Images API path)
 *   - generateGeminiImage
 *   - generateImagenImage
 *
 * Plus error-path coverage:
 *   - non-JSON / malformed `data.error` → message no longer contains
 *     `[object Object]` (Agent A: A1 fix).
 *   - HTTP non-2xx → thrown Error message starts with the status code.
 *   - imageFromUrl > 25 MB cap → throws "remote image exceeds 25 MB cap".
 *
 * Phase 1: scaffold only. Symbols imported here are guarded behind test.skip
 * so the file compiles even if the named exports change shape.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, injectDefaultProjectId } from "./e2e-setup.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts?: RequestInit): Promise<Response> {
	const method = (opts?.method || "GET").toUpperCase();
	let body = opts?.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${base()}${path}`, { ...opts, body, headers: { ...headers(), ...(opts?.headers || {}) } });
}

test.describe("image-generation provider branches", () => {
	test.skip("generateOpenAIImage: DALL-E path (dall-e-3)", async () => {
		// TODO Phase 2: stub globalThis.fetch for api.openai.com/v1/images/generations,
		// invoke generateImage with provider=openai/model=dall-e-3, assert
		// returned URL/path shape.
		const _ = api;
		expect(true).toBe(true);
	});

	test.skip("generateOpenAIImage: gpt-image-2 / Images API path", async () => {
		// TODO Phase 2: stub fetch for the Images API (b64_json response),
		// assert decoded bytes are written to outputPath.
		expect(true).toBe(true);
	});

	test.skip("generateGeminiImage", async () => {
		// TODO Phase 2: stub generativelanguage.googleapis.com — assert b64
		// decode + write.
		expect(true).toBe(true);
	});

	test.skip("generateImagenImage", async () => {
		// TODO Phase 2: stub Imagen endpoint — assert response handling.
		expect(true).toBe(true);
	});

	test.skip("error stringification: malformed data.error never produces [object Object]", async () => {
		// TODO Phase 2: stub fetch to return { error: { code: 500 } } (no
		// `.message`); assert the thrown Error message contains JSON, not
		// "[object Object]".
		expect(true).toBe(true);
	});

	test.skip("http error: thrown message starts with status code", async () => {
		// TODO Phase 2: stub fetch with status 429 → assert err.message.startsWith("429").
		expect(true).toBe(true);
	});

	test.skip("openai-codex driver: n>1 → throws clamp error", async () => {
		// TODO Phase 2: invoke generateOpenAICodexImage({ n: 2 }) → throws
		// "openai-codex image driver supports n=1 only".
		expect(true).toBe(true);
	});

	test.skip("imageFromUrl > 25 MB cap → aborts and throws", async () => {
		// TODO Phase 2: stub fetch with a >25MB body stream → assert thrown
		// error message matches "remote image exceeds 25 MB cap".
		expect(true).toBe(true);
	});
});
