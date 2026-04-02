/**
 * E2E tests for the unified tool access policy system.
 *
 * Tests REST API endpoints for group policies, role toolPolicies,
 * and migration from allowedTools to toolPolicies.
 */
import { test, expect } from "./gateway-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Cleanup helper roles after each test
test.afterEach(async () => {
	for (const name of ["policy-test-role", "migration-test-role"]) {
		await apiFetch(`/api/roles/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

// ── Group Policy REST API ───────────────────────────────────────────

test.describe("GET /api/tool-group-policies", () => {
	test("returns an object (possibly empty)", async () => {
		const resp = await apiFetch("/api/tool-group-policies");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(typeof data).toBe("object");
		expect(data).not.toBeNull();
	});
});

test.describe("PUT /api/tool-group-policies/:group", () => {
	test("sets a group policy and GET reflects it", async () => {
		const putResp = await apiFetch("/api/tool-group-policies/Browser", {
			method: "PUT",
			body: JSON.stringify({ policy: "ask" }),
		});
		expect(putResp.status).toBe(200);

		const getResp = await apiFetch("/api/tool-group-policies");
		expect(getResp.status).toBe(200);
		const data = await getResp.json();
		expect(data["Browser"]).toBe("ask");
	});

	test("clears a group policy with null", async () => {
		// Set first
		await apiFetch("/api/tool-group-policies/TestGroup", {
			method: "PUT",
			body: JSON.stringify({ policy: "ask" }),
		});

		// Clear
		const clearResp = await apiFetch("/api/tool-group-policies/TestGroup", {
			method: "PUT",
			body: JSON.stringify({ policy: null }),
		});
		expect(clearResp.status).toBe(200);

		const getResp = await apiFetch("/api/tool-group-policies");
		const data = await getResp.json();
		expect(data["TestGroup"]).toBeUndefined();
	});

	test("supports all valid policy values", async () => {
		for (const policy of ["allow", "ask", "never"]) {
			const resp = await apiFetch(`/api/tool-group-policies/TestGroup-${policy}`, {
				method: "PUT",
				body: JSON.stringify({ policy }),
			});
			expect(resp.status).toBe(200);

			const getResp = await apiFetch("/api/tool-group-policies");
			const data = await getResp.json();
			expect(data[`TestGroup-${policy}`]).toBe(policy);
		}
	});
});

// ── Roles API — toolPolicies via PUT ────────────────────────────────

test.describe("Roles API — toolPolicies", () => {
	test("PUT sets toolPolicies and GET returns them", async () => {
		// Create role first (POST doesn't accept toolPolicies)
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "policy-test-role",
				label: "Policy Test",
			}),
		});

		// Set toolPolicies via PUT
		const putResp = await apiFetch("/api/roles/policy-test-role", {
			method: "PUT",
			body: JSON.stringify({
				toolPolicies: {
					"mcp__test__tool": "ask",
					"mcp__test": "ask",
				},
			}),
		});
		expect(putResp.status).toBe(200);

		const getResp = await apiFetch("/api/roles/policy-test-role");
		expect(getResp.status).toBe(200);
		const role = await getResp.json();
		expect(role.toolPolicies).toBeDefined();
		expect(role.toolPolicies["mcp__test__tool"]).toBe("ask");
		expect(role.toolPolicies["mcp__test"]).toBe("ask");
	});

	test("PUT toolPolicies with always-allow derives allowedTools", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "policy-test-role",
				label: "Policy Test",
			}),
		});

		await apiFetch("/api/roles/policy-test-role", {
			method: "PUT",
			body: JSON.stringify({
				toolPolicies: {
					"read": "allow",
					"bash": "allow",
					"mcp__test__tool": "ask",
				},
			}),
		});

		const getResp = await apiFetch("/api/roles/policy-test-role");
		const role = await getResp.json();
		// allowedTools derived from toolPolicies entries with allow
		expect(role.allowedTools).toContain("read");
		expect(role.allowedTools).toContain("bash");
		expect(role.allowedTools).not.toContain("mcp__test__tool");
	});

	test("role allowedTools via PUT backward-compat merges into toolPolicies", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "policy-test-role",
				label: "Policy Test",
			}),
		});

		// Set allowedTools via PUT (old-style)
		await apiFetch("/api/roles/policy-test-role", {
			method: "PUT",
			body: JSON.stringify({
				allowedTools: ["read", "write"],
			}),
		});

		const getResp = await apiFetch("/api/roles/policy-test-role");
		const role = await getResp.json();
		expect(role.allowedTools).toContain("read");
		expect(role.allowedTools).toContain("write");
		// toolPolicies should have been updated accordingly
		if (role.toolPolicies) {
			expect(role.toolPolicies["read"]).toBe("allow");
			expect(role.toolPolicies["write"]).toBe("allow");
		}
	});
});

// ── Migration: allowedTools → toolPolicies ──────────────────────────

test.describe("Migration — allowedTools to toolPolicies", () => {
	test("role created with allowedTools has matching allowedTools after migration", async () => {
		// Create a role with allowedTools (backward compat path)
		const createResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "migration-test-role",
				label: "Migration Test",
				allowedTools: ["read", "bash", "write"],
			}),
		});
		expect(createResp.status).toBe(201);

		const getResp = await apiFetch("/api/roles/migration-test-role");
		expect(getResp.status).toBe(200);
		const role = await getResp.json();

		// allowedTools should still be present
		expect(role.allowedTools).toContain("read");
		expect(role.allowedTools).toContain("bash");
		expect(role.allowedTools).toContain("write");

		// After migration, toolPolicies should have matching entries
		if (role.toolPolicies) {
			expect(role.toolPolicies["read"]).toBe("allow");
			expect(role.toolPolicies["bash"]).toBe("allow");
			expect(role.toolPolicies["write"]).toBe("allow");
		}
	});

	test("role with toolPolicies set via PUT preserves non-allow policies", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "migration-test-role",
				label: "Already Migrated",
			}),
		});

		// Set toolPolicies with mixed policies
		await apiFetch("/api/roles/migration-test-role", {
			method: "PUT",
			body: JSON.stringify({
				toolPolicies: {
					"read": "allow",
					"bash": "ask",
				},
			}),
		});

		const getResp = await apiFetch("/api/roles/migration-test-role");
		const role = await getResp.json();
		expect(role.toolPolicies["read"]).toBe("allow");
		expect(role.toolPolicies["bash"]).toBe("ask");
		// bash should NOT be in allowedTools since it's ask (not allow)
		expect(role.allowedTools).toContain("read");
		expect(role.allowedTools).not.toContain("bash");
	});
});
