/**
 * E2E tests for the Setup Status REST API.
 *
 * Tests run against an isolated gateway with its own BOBBIT_DIR.
 * Verifies GET /api/setup-status, POST /api/setup-status/dismiss,
 * GET /api/health setupComplete field, and setup assistant session creation.
 */
import { test, expect } from "./gateway-harness.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { base, bobbitDir, apiFetch, nonGitCwd, deleteSession } from "./e2e-setup.js";

// Run tests serially — dismiss test modifies shared state (sentinel file)
test.describe.configure({ mode: "serial" });

/** Path to the setup-complete sentinel file in the E2E state dir. */
const SENTINEL_PATH = join(bobbitDir(), "state", "setup-complete");

/** Remove sentinel file to reset setup status. */
function removeSentinel() {
	try { unlinkSync(SENTINEL_PATH); } catch { /* doesn't exist */ }
}

// Ensure clean state before the suite
test.beforeAll(() => {
	removeSentinel();
});

// Clean up after the suite — remove sentinel so other test files aren't affected
test.afterAll(() => {
	removeSentinel();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/setup-status — initial state
// ═══════════════════════════════════════════════════════════════════════════

test.describe("GET /api/setup-status", () => {
	test("returns { complete: false } when no sentinel exists", async () => {
		removeSentinel();
		const resp = await apiFetch("/api/setup-status");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data).toEqual({ complete: false });
	});

	test("requires authentication", async () => {
		const resp = await fetch(`${base()}/api/setup-status`);
		expect(resp.status).toBe(401);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POST /api/setup-status/dismiss — creates sentinel
// ═══════════════════════════════════════════════════════════════════════════

test.describe("POST /api/setup-status/dismiss", () => {
	test("creates sentinel and subsequent GET returns { complete: true }", async () => {
		removeSentinel();

		// Dismiss
		const dismissResp = await apiFetch("/api/setup-status/dismiss", { method: "POST" });
		expect(dismissResp.status).toBe(200);
		const dismissData = await dismissResp.json();
		expect(dismissData).toEqual({ ok: true });

		// Sentinel file should now exist
		expect(existsSync(SENTINEL_PATH)).toBe(true);

		// GET should now return complete: true
		const statusResp = await apiFetch("/api/setup-status");
		expect(statusResp.status).toBe(200);
		const statusData = await statusResp.json();
		expect(statusData).toEqual({ complete: true });
	});

	test("dismiss is idempotent", async () => {
		// Call dismiss again — should succeed without error
		const resp = await apiFetch("/api/setup-status/dismiss", { method: "POST" });
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });
	});

	test("requires authentication", async () => {
		const resp = await fetch(`${base()}/api/setup-status/dismiss`, { method: "POST" });
		expect(resp.status).toBe(401);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /api/health — includes setupComplete field
// ═══════════════════════════════════════════════════════════════════════════

test.describe("GET /api/health — setupComplete field", () => {
	test("includes setupComplete: true when sentinel exists", async () => {
		// Sentinel should still exist from the dismiss test above
		const resp = await apiFetch("/api/health");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.status).toBe("ok");
		expect(typeof data.setupComplete).toBe("boolean");
		expect(data.setupComplete).toBe(true);
	});

	test("includes setupComplete: false when sentinel removed", async () => {
		removeSentinel();
		const resp = await apiFetch("/api/health");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.setupComplete).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Session creation with assistantType: "setup"
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Setup assistant session", () => {
	let sessionId: string | undefined;

	test.afterEach(async () => {
		if (sessionId) {
			await deleteSession(sessionId);
			sessionId = undefined;
		}
	});

	test("creating a session with assistantType setup succeeds", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), assistantType: "setup" }),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessionId = data.id;
		expect(data.id).toBeTruthy();
		expect(data.assistantType).toBe("setup");
	});

	test("session metadata includes assistantType setup", async () => {
		// Create session
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), assistantType: "setup" }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		sessionId = created.id;

		// Fetch session detail
		const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(detailResp.status).toBe(200);
		const detail = await detailResp.json();
		expect(detail.assistantType).toBe("setup");
	});
});
