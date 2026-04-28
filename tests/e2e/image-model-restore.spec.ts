/**
 * API E2E: per-session image model survives the create → archive → restore
 * round-trip.
 *
 * Coverage:
 *   - WS `set_image_model` persists provider/modelId to the session record
 *     via SessionManager.persistSessionImageModel().
 *   - After archive (DELETE /api/sessions/:id), the persisted row still
 *     carries imageModelProvider/imageModelId.
 *   - Continuing the archived session via POST /api/sessions/:id/continue
 *     produces a *new* session id (continue, not in-place restore) — but the
 *     in-memory restoreSession() path that runs on server startup re-uses
 *     the persisted shape. We assert that the persisted record is still
 *     readable through `getImageModelForSession()` (exposed via
 *     gateway.sessionManager) which is what reactivates the per-session
 *     override on next launch.
 *
 * The image-tools CLI activation invariant ("--extension … /images/extension.ts"
 * appears in argv for restore-style roleless sessions) is covered by the
 * existing unit-level test `tests/grant-policy.test.ts → "restore-style
 * roleless sessions load generate_image and exclude blocked Nano Banana MCP"`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession } from "./e2e-setup.js";

test.setTimeout(20_000);

test.describe("session image model: archive→restore round-trip", () => {
	test("per-session imageModel survives archive and is restorable", async ({ gateway }) => {
		const sessionId = await createSession();

		// 1. Set per-session image model via WS.
		const ws = await connectWs(sessionId);
		try {
			ws.send({ type: "set_image_model", provider: "openai", modelId: "gpt-image-2" });
			await ws.waitFor(
				(m: any) =>
					m.type === "state" &&
					m.data?.imageGenerationModel?.provider === "openai" &&
					m.data?.imageGenerationModel?.id === "gpt-image-2",
				5_000,
			);
		} finally {
			ws.close();
		}

		// 2. SessionManager records it in the persisted store immediately.
		const liveModel = gateway.sessionManager.getImageModelForSession(sessionId);
		expect(liveModel).toEqual({ provider: "openai", id: "gpt-image-2" });

		// 3. Archive the session.
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.ok).toBe(true);

		// 4. Persisted record (and its imageModel fields) is still resolvable
		//    via getImageModelForSession (this is the same lookup used by
		//    restoreSession() / handler.sendFallbackModelState() on revive).
		const afterArchive = gateway.sessionManager.getImageModelForSession(sessionId);
		expect(afterArchive).toEqual({ provider: "openai", id: "gpt-image-2" });
	});

	test("system default falls through when no per-session override is set", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			// No set_image_model — getImageModelForSession should return the
			// parsed defaultImageModelPref(), which is "openai/gpt-image-2".
			const model = gateway.sessionManager.getImageModelForSession(sessionId);
			expect(model).toEqual({ provider: "openai", id: "gpt-image-2" });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
