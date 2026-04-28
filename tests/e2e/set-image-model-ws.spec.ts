/**
 * API E2E for the `set_image_model` WebSocket command (handler.ts).
 *
 * Phase 2 plan:
 *   - Happy path: open a WS client, send `set_image_model` with a valid
 *     provider/modelId pair → server acknowledges + the session's
 *     imageGenerationModel is updated (round-trip via getImageModelForSession
 *     or GET /api/sessions/:id).
 *   - Invalid provider → error envelope `{ error: "unknown image model" }`,
 *     session state unchanged.
 *   - Invalid modelId → same error.
 *
 * Phase 1: scaffold only.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

const _headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

test.describe("WS set_image_model", () => {
	test.skip("happy path: valid provider/modelId updates session image model", async () => {
		// TODO Phase 2: open WS, send {type:"set_image_model", provider:"openai",
		// modelId:"gpt-image-2"}, assert state.imageGenerationModel changes.
		const _ = base;
		expect(true).toBe(true);
	});

	test.skip("invalid provider → error envelope, no state mutation", async () => {
		// TODO Phase 2: send {type:"set_image_model", provider:"bogus", ...} →
		// assert response.error === "unknown image model"; session state pristine.
		expect(true).toBe(true);
	});

	test.skip("invalid modelId → error envelope, no state mutation", async () => {
		// TODO Phase 2: same with valid provider, unknown modelId.
		expect(true).toBe(true);
	});
});
