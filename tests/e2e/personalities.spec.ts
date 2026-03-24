/**
 * E2E tests for the Personalities REST API.
 *
 * Tests run against an isolated gateway with its own BOBBIT_DIR.
 * The server reads personalities from .e2e-bobbit-<id>/config/personalities/
 * — completely separate from the real repo. No backup/restore needed.
 */
import { test, expect } from "@playwright/test";
import { apiFetch, createSession, deleteSession, nonGitCwd } from "./e2e-setup.js";

// Clean up test personalities after each test
test.afterEach(async () => {
	for (const name of ["test-personality", "another-personality", "my-personality-123"]) {
		await apiFetch(`/api/personalities/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

// Run tests serially to avoid rate limiting
test.describe.configure({ mode: "serial" });

// ── GET /api/personalities ──

test.describe("GET /api/personalities — seed personalities", () => {
	test("returns all 10 seed personalities", async () => {
		const resp = await apiFetch("/api/personalities");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.personalities).toBeDefined();
		expect(Array.isArray(data.personalities)).toBe(true);
		expect(data.personalities.length).toBe(10);

		const names = data.personalities.map((t: any) => t.name);
		expect(names).toContain("thorough");
		expect(names).toContain("creative");
		expect(names).toContain("terse");
		expect(names).toContain("verbose");
		expect(names).toContain("critical");
		expect(names).toContain("explorative");
		expect(names).toContain("pragmatic");
		expect(names).toContain("quick-worker");
		expect(names).toContain("rigid");
		expect(names).toContain("direct");
	});

	test("seed personalities have required fields", async () => {
		const resp = await apiFetch("/api/personalities");
		const { personalities } = await resp.json();
		for (const personality of personalities) {
			expect(typeof personality.name).toBe("string");
			expect(personality.name.length).toBeGreaterThan(0);
			expect(typeof personality.label).toBe("string");
			expect(personality.label.length).toBeGreaterThan(0);
			expect(typeof personality.description).toBe("string");
			expect(typeof personality.promptFragment).toBe("string");
			expect(personality.promptFragment.length).toBeGreaterThan(0);
		}
	});
});

// ── GET /api/personalities/:name ──

test.describe("GET /api/personalities/:name — single personality", () => {
	test("returns correct personality for 'thorough'", async () => {
		const resp = await apiFetch("/api/personalities/thorough");
		expect(resp.status).toBe(200);
		const personality = await resp.json();
		expect(personality.name).toBe("thorough");
		expect(personality.label).toBe("Thorough");
		expect(personality.promptFragment).toBeTruthy();
		expect(personality.description).toBeTruthy();
	});

	test("returns 404 for nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent");
		expect(resp.status).toBe(404);
	});
});

// ── POST /api/personalities ──

test.describe("POST /api/personalities — create", () => {
	test("creates a custom personality with valid data", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({
				name: "test-personality",
				label: "Test Personality",
				description: "A personality for testing",
				promptFragment: "Be extra testy.",
			}),
		});
		expect(resp.status).toBe(201);
		const personality = await resp.json();
		expect(personality.name).toBe("test-personality");
		expect(personality.label).toBe("Test Personality");
		expect(personality.description).toBe("A personality for testing");
		expect(personality.promptFragment).toBe("Be extra testy.");
	});

	test("rejects duplicate personality name", async () => {
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "First" }),
		});
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "Second" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("already exists");
	});

	test("rejects name with uppercase letters", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "TestPersonality", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects name with spaces", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test personality", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing name", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ label: "No Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing label", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality" }),
		});
		expect(resp.status).toBe(400);
	});
});

// ── PUT /api/personalities/:name ──

test.describe("PUT /api/personalities/:name — update", () => {
	test("updates a personality's label and description", async () => {
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({
				name: "test-personality",
				label: "Original",
				description: "Original desc",
				promptFragment: "Original prompt.",
			}),
		});

		const resp = await apiFetch("/api/personalities/test-personality", {
			method: "PUT",
			body: JSON.stringify({ label: "Updated Label", description: "Updated desc" }),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/personalities/test-personality");
		const personality = await getResp.json();
		expect(personality.label).toBe("Updated Label");
		expect(personality.description).toBe("Updated desc");
		expect(personality.promptFragment).toBe("Original prompt.");
	});

	test("returns 404 when updating nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent", {
			method: "PUT",
			body: JSON.stringify({ label: "Nope" }),
		});
		expect(resp.status).toBe(404);
	});
});

// ── DELETE /api/personalities/:name ──

test.describe("DELETE /api/personalities/:name", () => {
	test("deletes an existing personality", async () => {
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "To Delete" }),
		});

		const resp = await apiFetch("/api/personalities/test-personality", { method: "DELETE" });
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/personalities/test-personality");
		expect(getResp.status).toBe(404);
	});

	test("returns 404 when deleting nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent", { method: "DELETE" });
		expect(resp.status).toBe(404);
	});
});

// ── Session integration ──

test.describe("Session + personalities integration", () => {
	const sessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id);
		}
	});

	test("POST /api/sessions with personalities creates session with personalities", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				personalities: ["thorough", "creative"],
			}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessionIds.push(data.id);
		expect(data.personalities).toContain("thorough");
		expect(data.personalities).toContain("creative");
	});

	test("GET /api/sessions includes personalities in response", async () => {
		const id = await createSession({ cwd: nonGitCwd() });
		sessionIds.push(id);

		// Patch to add personalities (createSession doesn't pass them)
		await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ personalities: ["terse"] }),
		});

		const resp = await apiFetch("/api/sessions");
		const { sessions } = await resp.json();
		const session = sessions.find((s: any) => s.id === id);
		expect(session).toBeDefined();
		expect(session.personalities).toContain("terse");
	});

	test("GET /api/sessions/:id includes personalities", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				personalities: ["creative", "direct"],
			}),
		});
		const data = await resp.json();
		sessionIds.push(data.id);

		const getResp = await apiFetch(`/api/sessions/${data.id}`);
		const session = await getResp.json();
		expect(session.personalities).toContain("creative");
		expect(session.personalities).toContain("direct");
	});

	test("PATCH /api/sessions/:id with personalities updates session personalities", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				personalities: ["thorough"],
			}),
		});
		const data = await resp.json();
		sessionIds.push(data.id);

		const patchResp = await apiFetch(`/api/sessions/${data.id}`, {
			method: "PATCH",
			body: JSON.stringify({ personalities: ["creative", "terse"] }),
		});
		expect(patchResp.status).toBe(200);

		const getResp = await apiFetch(`/api/sessions/${data.id}`);
		const session = await getResp.json();
		expect(session.personalities).toContain("creative");
		expect(session.personalities).toContain("terse");
		expect(session.personalities).not.toContain("thorough");
	});

	test("PATCH /api/sessions/:id with invalid personality name returns 400", async () => {
		const id = await createSession();
		sessionIds.push(id);

		const resp = await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ personalities: ["nonexistent-personality-xyz"] }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown personalities");
	});

	test("POST /api/sessions with invalid personality returns 400", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				personalities: ["nonexistent-personality-xyz"],
			}),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown personalities");
	});
});
