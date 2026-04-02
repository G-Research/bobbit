/**
 * Reproducing test for: tool guard not enforced for roles with ask-only toolPolicies.
 *
 * Bug: When a role has only `ask` entries in toolPolicies (e.g. { bash_bg: "ask" })
 * and no `allow` entries, creating a session with that role fails to generate a
 * tool guard extension. The agent can use guarded tools without user approval.
 *
 * This test creates a role with toolPolicies: { bash_bg: "ask" }, creates a session
 * with that role, and verifies that a tool guard extension was generated in the
 * state directory. With the bug, no guard file is created.
 */
import { test, expect } from "./gateway-harness.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	apiFetch,
	bobbitDir,
	createSession,
	deleteSession,
	nonGitCwd,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.setTimeout(30_000);

const ROLE_NAME = "ask-only-guard-test";

test.beforeAll(async () => {
	// Create a role with empty allowedTools
	const createResp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: ROLE_NAME,
			label: "Ask-Only Guard Test",
			promptTemplate: "You are a test agent.",
			allowedTools: [],
		}),
	});
	expect(createResp.status).toBe(201);

	// Update the role with toolPolicies: { bash_bg: "ask" }
	const updateResp = await apiFetch(`/api/roles/${ROLE_NAME}`, {
		method: "PUT",
		body: JSON.stringify({
			toolPolicies: { bash_bg: "ask" },
		}),
	});
	expect(updateResp.status).toBe(200);

	// Verify the role has the expected state
	const getResp = await apiFetch(`/api/roles/${ROLE_NAME}`);
	expect(getResp.status).toBe(200);
	const role = await getResp.json();
	expect(role.toolPolicies).toEqual({ bash_bg: "ask" });
	// With only "ask" policies and no "allow", the role should not have toolPolicies with "allow"
	expect(Object.values(role.toolPolicies).every((v: string) => v !== "allow")).toBe(true);
});

test.afterAll(async () => {
	await apiFetch(`/api/roles/${ROLE_NAME}`, { method: "DELETE" }).catch(() => {});
});

test.describe("Tool guard with ask-only role", () => {
	let sessionId: string;
	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId); sessionId = ""; }
	});

	test("session with ask-only toolPolicies role should have tool guard extension", async () => {
		// Create a session with the ask-only role
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				roleId: ROLE_NAME,
			}),
		});
		expect(resp.status).toBe(201);
		sessionId = (await resp.json()).id;

		// Wait for the session to be ready
		await waitForSessionStatus(sessionId, "idle");

		// Check the tool-guard state directory for guard extension files
		// When the bug is fixed, a guard extension should be written here
		// that includes bash_bg as a guarded tool.
		const guardDir = join(bobbitDir(), "state", "tool-guard");

		// The guard directory must exist (created by writeToolGuardExtension)
		expect(
			existsSync(guardDir),
			"Expected tool-guard directory to exist — no guard extension was generated for ask-only role",
		).toBe(true);

		// Find guard.ts files and check if any mention bash_bg
		const subdirs = readdirSync(guardDir);
		let foundBashBgGuard = false;

		for (const sub of subdirs) {
			const guardFile = join(guardDir, sub, "guard.ts");
			if (existsSync(guardFile)) {
				const content = readFileSync(guardFile, "utf-8");
				if (content.includes("bash_bg")) {
					foundBashBgGuard = true;
					break;
				}
			}
		}

		expect(
			foundBashBgGuard,
			"Expected a tool guard extension for bash_bg to be generated when role has toolPolicies: { bash_bg: 'ask' }",
		).toBe(true);
	});
});
