/**
 * Reproducer — POST /api/sessions for config-editing assistants (role/tool/staff)
 * returns 400 when no projectId is provided and cwd doesn't match a registered
 * project.
 *
 * Issue: `src/app/role-manager-page.ts::createRoleAssistantSession` posts only
 * `{ assistantType: "role" }`. Under `npx bobbit` in a non-project directory,
 * the server unconditionally calls `resolveProjectForRequest` and 400s with
 * "projectId required ... does not match any registered project". Role/Tool/
 * Staff assistants are config-editing — they don't need a project.
 *
 * Fix (server `src/server/server.ts` ~L3068): when assistantType ∈ {role, tool,
 * staff} and no projectId was provided, skip project resolution and create the
 * session with projectId === undefined.
 *
 * Tests:
 *   1. role assistant with non-matching cwd → 201 (currently 400). FLIPS.
 *   2. tool assistant with non-matching cwd → 201 (currently 400). FLIPS.
 *   3. staff assistant with non-matching cwd → 201 (currently 400). FLIPS.
 *   4. goal assistant with non-matching cwd → 400 (regression guard, must
 *      continue to fail-fast — goal sessions require a project).
 *
 * Uses `rawApiFetch` so the harness's default-project auto-injection doesn't
 * mask the bug. The cwd MUST exist on disk — otherwise the server's
 * spawn-ENOENT guard rewrites it to defaultCwd (which matches the harness's
 * "default" project and masks the failure).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { rawApiFetch, readE2EToken } from "./e2e-setup.js";

let bogusCwd: string;
const createdSessionIds: string[] = [];

test.beforeAll(() => {
	readE2EToken();
	bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-role-assistant-"));
});

test.afterAll(async () => {
	for (const id of createdSessionIds) {
		await rawApiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
	}
	try { fs.rmSync(bogusCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test.describe("POST /api/sessions — config-editing assistants don't need a project", () => {
	for (const assistantType of ["role", "tool", "staff"] as const) {
		test(`${assistantType} assistant without projectId — 201 (currently 400)`, async () => {
			const resp = await rawApiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType, cwd: bogusCwd }),
			});
			const text = await resp.text();
			expect(
				resp.status,
				`${assistantType} assistant should be created without projectId; expected 201, got ${resp.status} body=${text}`,
			).toBe(201);
			const session = JSON.parse(text);
			expect(session.assistantType).toBe(assistantType);
			expect(session.id).toBeTruthy();
			createdSessionIds.push(session.id);
		});
	}

	test("goal assistant without projectId — 400 (regression guard, must keep failing)", async () => {
		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "goal", cwd: bogusCwd }),
		});
		const text = await resp.text();
		expect(
			resp.status,
			`goal assistant must still require a project; expected 400, got ${resp.status} body=${text}`,
		).toBe(400);
		expect(text).toMatch(/projectId required/);
	});
});
