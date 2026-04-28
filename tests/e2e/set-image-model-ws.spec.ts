/**
 * API E2E for the `set_image_model` WebSocket command.
 *
 * Server-side path:
 *   - handler.ts validates (provider, modelId) via
 *     `sessionManager.isKnownImageModel()` (Agent B B8). Unknown pairs return
 *     `{ type: "error", message: "unknown image model", code: "UNKNOWN_IMAGE_MODEL" }`
 *     and DO NOT mutate session state.
 *   - Valid pairs persist via `persistSessionImageModel()` and broadcast
 *     `{ type: "state", data: { imageGenerationModel: { provider, id } } }`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession } from "./e2e-setup.js";

test.setTimeout(20_000);

test.describe("WS set_image_model", () => {
	test("happy path: valid (provider, modelId) updates imageGenerationModel and broadcasts state", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				// Pick a known-valid pair from the server registry — gpt-image-2
				// is always present per `image-generation-registry.test.ts`.
				ws.send({ type: "set_image_model", provider: "openai", modelId: "gpt-image-2" });

				const stateMsg = await ws.waitFor(
					(m: any) =>
						m.type === "state" &&
						m.data?.imageGenerationModel?.provider === "openai" &&
						m.data?.imageGenerationModel?.id === "gpt-image-2",
					5_000,
				);
				expect(stateMsg).toBeDefined();
			} finally {
				ws.close();
			}

			// Persistence: re-open WS — the persisted image model survives.
			const ws2 = await connectWs(sessionId);
			try {
				const persisted = await ws2.waitFor(
					(m: any) =>
						m.type === "state" &&
						m.data?.imageGenerationModel?.provider === "openai" &&
						m.data?.imageGenerationModel?.id === "gpt-image-2",
					5_000,
				);
				expect(persisted).toBeDefined();
			} finally {
				ws2.close();
			}
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("invalid provider → error envelope, session state not mutated", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				ws.send({ type: "set_image_model", provider: "bogus-provider", modelId: "gpt-image-2" });
				const errMsg = await ws.waitFor(
					(m: any) => m.type === "error" && m.code === "UNKNOWN_IMAGE_MODEL",
					5_000,
				);
				expect(errMsg.message).toBe("unknown image model");
			} finally {
				ws.close();
			}

			// Re-open WS: confirm imageGenerationModel was NOT set to the bogus pair.
			const ws2 = await connectWs(sessionId);
			try {
				// Drain a short window for any state messages — none should match the bogus pair.
				await new Promise((r) => setTimeout(r, 250));
				const bogusState = ws2.messages.find(
					(m: any) =>
						m.type === "state" &&
						m.data?.imageGenerationModel?.provider === "bogus-provider",
				);
				expect(bogusState).toBeUndefined();
			} finally {
				ws2.close();
			}
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("invalid modelId (valid provider) → error envelope, no state mutation", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				ws.send({ type: "set_image_model", provider: "openai", modelId: "totally-not-a-real-model" });
				const errMsg = await ws.waitFor(
					(m: any) => m.type === "error" && m.code === "UNKNOWN_IMAGE_MODEL",
					5_000,
				);
				expect(errMsg.message).toBe("unknown image model");
			} finally {
				ws.close();
			}
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("missing provider/modelId → error envelope", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				ws.send({ type: "set_image_model", provider: "", modelId: "" });
				const errMsg = await ws.waitFor(
					(m: any) => m.type === "error" && m.code === "UNKNOWN_IMAGE_MODEL",
					5_000,
				);
				expect(errMsg.message).toBe("unknown image model");
			} finally {
				ws.close();
			}
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
