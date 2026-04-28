/**
 * E2E tests for the Role Management REST API — model & thinkingLevel fields.
 *
 * Tests run against an isolated gateway with its own BOBBIT_DIR.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

test.afterEach(async () => {
	for (const name of ["model-test-role", "model-test-role-2"]) {
		await apiFetch(`/api/roles/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

test.describe("Role API — model & thinkingLevel fields", () => {
	test("creates a role with model and thinkingLevel and round-trips them", async () => {
		const createResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "model-test-role",
				label: "Model Test Role",
				promptTemplate: "p",
				model: "anthropic/claude-opus-4",
				thinkingLevel: "high",
			}),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		expect(created.model).toBe("anthropic/claude-opus-4");
		expect(created.thinkingLevel).toBe("high");

		const getResp = await apiFetch("/api/roles/model-test-role");
		expect(getResp.status).toBe(200);
		const got = await getResp.json();
		expect(got.model).toBe("anthropic/claude-opus-4");
		expect(got.thinkingLevel).toBe("high");
	});

	test("creates a role without model/thinkingLevel — fields are absent", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "model-test-role",
				label: "No Override",
				promptTemplate: "p",
			}),
		});
		expect(resp.status).toBe(201);

		const getResp = await apiFetch("/api/roles/model-test-role");
		const got = await getResp.json();
		expect(got.model).toBeUndefined();
		expect(got.thinkingLevel).toBeUndefined();
	});

	test("PUT updates model and thinkingLevel", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "model-test-role",
				label: "Test",
				promptTemplate: "p",
			}),
		});

		const putResp = await apiFetch("/api/roles/model-test-role", {
			method: "PUT",
			body: JSON.stringify({
				model: "anthropic/claude-sonnet",
				thinkingLevel: "medium",
			}),
		});
		expect(putResp.status).toBe(200);

		const getResp = await apiFetch("/api/roles/model-test-role");
		const got = await getResp.json();
		expect(got.model).toBe("anthropic/claude-sonnet");
		expect(got.thinkingLevel).toBe("medium");
	});

	test("PUT with empty string clears model and thinkingLevel (revert to inherit)", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "model-test-role",
				label: "Test",
				promptTemplate: "p",
				model: "anthropic/claude-opus-4",
				thinkingLevel: "high",
			}),
		});

		const putResp = await apiFetch("/api/roles/model-test-role", {
			method: "PUT",
			body: JSON.stringify({ model: "", thinkingLevel: "" }),
		});
		expect(putResp.status).toBe(200);

		const getResp = await apiFetch("/api/roles/model-test-role");
		const got = await getResp.json();
		expect(got.model).toBeUndefined();
		expect(got.thinkingLevel).toBeUndefined();
	});

	test("malformed model string is silently dropped (not persisted)", async () => {
		const createResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "model-test-role",
				label: "Bad Model",
				promptTemplate: "p",
				model: "no-slash-here",
				thinkingLevel: "ultra",
			}),
		});
		expect(createResp.status).toBe(201);

		const getResp = await apiFetch("/api/roles/model-test-role");
		const got = await getResp.json();
		// Malformed values are silently dropped at parse time — the YAML never
		// contains them, so reads return undefined.
		expect(got.model).toBeUndefined();
		expect(got.thinkingLevel).toBeUndefined();
	});
});
