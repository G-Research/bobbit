/**
 * E2E tests for the editable-proposals REST API.
 *
 *   GET    /api/sessions/:id/proposal/:type
 *   POST   /api/sessions/:id/proposal/:type/edit   { old_text, new_text }
 *   POST   /api/sessions/:id/proposal/:type/seed   { args }
 *   DELETE /api/sessions/:id/proposal/:type
 *
 * Acceptance:
 *   1. edit-before-propose returns 404 { code: "FILE_NOT_FOUND" } naming
 *      `propose_<type>`.
 *   2. seed → file persists on disk under
 *      `<bobbitDir>/state/proposal-drafts/<sid>/<type>.<ext>`. Since the file
 *      IS the source of truth, this is the restart-survival contract.
 *   3. malformed edit rolls back (SHA-256 of file unchanged) for
 *      YAML_PARSE_ERROR, MISSING_REQUIRED_FIELD.
 *
 * Design doc: docs/design/editable-proposals.md §6.4, §9.1.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./_e2e/e2e-setup.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let sessionId: string;

test.beforeAll(async () => {
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId);
});

function sha(p: string): string {
	return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function proposalPath(bobbitDir: string, sid: string, type: string): string {
	const ext = type === "goal" ? "md" : "yaml";
	return path.join(bobbitDir, "state", "proposal-drafts", sid, `${type}.${ext}`);
}

function latestProposalRevision(bobbitDir: string, sid: string, type: string): number {
	const historyDir = path.join(bobbitDir, "state", "proposal-drafts", sid, `${type}.history`);
	if (!fs.existsSync(historyDir)) return 0;
	return fs.readdirSync(historyDir).reduce((latest, filename) => {
		const match = /^(\d+)\.(?:md|yaml)$/.exec(filename);
		return match ? Math.max(latest, Number.parseInt(match[1], 10)) : latest;
	}, 0);
}

test.describe("editable proposals — REST API", () => {
	test("edit-before-propose returns 404 FILE_NOT_FOUND naming propose_goal", async () => {
		const sid = await createSession();
		try {
			const resp = await apiFetch(`/api/sessions/${sid}/proposal/goal/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "x", new_text: "y" }),
			});
			expect(resp.status).toBe(404);
			const body = await resp.json();
			expect(body.ok).toBe(false);
			expect(body.code).toBe("FILE_NOT_FOUND");
			expect(String(body.message)).toMatch(/propose_goal/);
		} finally {
			await deleteSession(sid);
		}
	});

	test("outside-project goal cwd is rejected transactionally before draft persistence", async ({ gateway }) => {
		const sid = await createSession();
		const fp = proposalPath(gateway.bobbitDir, sid, "goal");
		const outsideCwd = path.join(gateway.bobbitDir, "outside-proposal-cwd", sid);
		try {
			const rejectedFirst = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({
					args: {
						title: "Invalid First Draft",
						spec: "An outside-project cwd must not become a proposal draft.\n",
						workflow: "feature",
						cwd: outsideCwd,
					},
				}),
			});
			const rejectedFirstText = await rejectedFirst.text();
			expect(
				rejectedFirst.status,
				`PROPOSE_GOAL_CWD_VALIDATION_MISSING: outside-project seed was accepted: ${rejectedFirstText}`,
			).toBe(422);
			const rejectedFirstBody = JSON.parse(rejectedFirstText) as Record<string, unknown>;
			expect(rejectedFirstBody.code).toBe("CWD_OUTSIDE_PROJECT");
			expect(String(rejectedFirstBody.message ?? rejectedFirstBody.error)).toMatch(/cwd must be inside the selected project/i);
			expect(fs.existsSync(fp), "rejected first seed must not create a live proposal draft").toBe(false);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal"), "rejected first seed must not advance proposal revision").toBe(0);

			const accepted = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({
					args: {
						title: "Valid Baseline Draft",
						spec: "A valid draft that a later rejected proposal must preserve.\n",
						workflow: "feature",
					},
				}),
			});
			expect(accepted.status, await accepted.clone().text()).toBe(200);
			const acceptedBody = await accepted.json() as { rev: number };
			const beforeContent = fs.readFileSync(fp, "utf8");
			const beforeRevision = latestProposalRevision(gateway.bobbitDir, sid, "goal");
			expect(beforeRevision).toBe(acceptedBody.rev);

			const rejectedSecond = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({
					args: {
						title: "Invalid Replacement",
						spec: "This invalid attempt must not overwrite the valid baseline.\n",
						workflow: "feature",
						cwd: outsideCwd,
					},
				}),
			});
			const rejectedSecondText = await rejectedSecond.text();
			expect(rejectedSecond.status, `invalid replacement response: ${rejectedSecondText}`).toBe(422);
			const rejectedSecondBody = JSON.parse(rejectedSecondText) as Record<string, unknown>;
			expect(rejectedSecondBody.code).toBe("CWD_OUTSIDE_PROJECT");
			expect(fs.readFileSync(fp, "utf8"), "rejected replacement must preserve the valid draft bytes").toBe(beforeContent);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal"), "rejected replacement must preserve the valid draft revision").toBe(beforeRevision);
		} finally {
			await deleteSession(sid);
		}
	});

	test("seed writes a goal draft on disk; GET returns markdown body", async ({ gateway }) => {
		const seedResp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({
				args: {
					title: "My Goal",
					spec: "Body of the goal\n",
					workflow: "feature",
				},
			}),
		});
		expect(seedResp.status).toBe(200);
		const seedBody = await seedResp.json();
		expect(seedBody.ok).toBe(true);

		// File on disk — this IS the restart-survival contract: the only
		// state we care about is the file. A server restart simply re-reads it.
		const fp = proposalPath(gateway.bobbitDir, sessionId, "goal");
		expect(fs.existsSync(fp)).toBe(true);
		const raw = fs.readFileSync(fp, "utf8");
		expect(raw).toMatch(/^---\n/);
		expect(raw).toMatch(/title: My Goal/);
		expect(raw).toMatch(/Body of the goal/);

		const getResp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal`);
		expect(getResp.status).toBe(200);
		const getText = await getResp.text();
		expect(getText).toBe(raw);
	});

	test("seed → edit → GET reflects new content", async () => {
		await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
			method: "POST",
			body: JSON.stringify({ args: { name: "Original", root_path: "/tmp/proj" } }),
		});
		const editResp = await apiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
			method: "POST",
			body: JSON.stringify({ old_text: "Original", new_text: "Renamed" }),
		});
		expect(editResp.status).toBe(200);
		const editBody = await editResp.json();
		expect(editBody.ok).toBe(true);
		expect(editBody.newContent).toMatch(/name: Renamed/);

		const getResp = await apiFetch(`/api/sessions/${sessionId}/proposal/project`);
		expect(getResp.status).toBe(200);
		expect(await getResp.text()).toMatch(/name: Renamed/);
	});

	test("malformed edit rolls back: YAML_PARSE_ERROR — SHA unchanged", async ({ gateway }) => {
		const sid = await createSession();
		try {
			await apiFetch(`/api/sessions/${sid}/proposal/project/seed`, {
				method: "POST",
				body: JSON.stringify({ args: { name: "P", root_path: "/tmp/p" } }),
			});
			const fp = proposalPath(gateway.bobbitDir, sid, "project");
			expect(fs.existsSync(fp)).toBe(true);
			const before = sha(fp);

			// Replace `name: P` with an unclosed flow sequence to break YAML.
			const resp = await apiFetch(`/api/sessions/${sid}/proposal/project/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "name: P", new_text: "name: [unclosed" }),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(body.ok).toBe(false);
			// Could be YAML_PARSE_ERROR or MISSING_REQUIRED_FIELD/STRUCTURAL depending
			// on how the parser tokenises — either way the file must roll back.
			expect(["YAML_PARSE_ERROR", "MISSING_REQUIRED_FIELD", "STRUCTURAL_VALIDATION_FAILED"]).toContain(body.code);

			expect(sha(fp)).toBe(before);
			expect(fs.existsSync(fp + ".tmp")).toBe(false);
		} finally {
			await deleteSession(sid);
		}
	});

	test("malformed edit rolls back: MISSING_REQUIRED_FIELD when name is removed", async ({ gateway }) => {
		const sid = await createSession();
		try {
			await apiFetch(`/api/sessions/${sid}/proposal/project/seed`, {
				method: "POST",
				body: JSON.stringify({ args: { name: "P", root_path: "/tmp/p" } }),
			});
			const fp = proposalPath(gateway.bobbitDir, sid, "project");
			const before = sha(fp);

			const resp = await apiFetch(`/api/sessions/${sid}/proposal/project/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "name: P\n", new_text: "" }),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(body.code).toBe("MISSING_REQUIRED_FIELD");

			expect(sha(fp)).toBe(before);
		} finally {
			await deleteSession(sid);
		}
	});

	test("DELETE removes the file (idempotent)", async ({ gateway }) => {
		const sid = await createSession();
		try {
			await apiFetch(`/api/sessions/${sid}/proposal/role/seed`, {
				method: "POST",
				body: JSON.stringify({ args: { name: "r", label: "Role", prompt: "go" } }),
			});
			const fp = proposalPath(gateway.bobbitDir, sid, "role");
			expect(fs.existsSync(fp)).toBe(true);

			const del1 = await apiFetch(`/api/sessions/${sid}/proposal/role`, { method: "DELETE" });
			expect(del1.status).toBe(204);
			expect(fs.existsSync(fp)).toBe(false);

			// Idempotent
			const del2 = await apiFetch(`/api/sessions/${sid}/proposal/role`, { method: "DELETE" });
			expect(del2.status).toBe(204);

			const getResp = await apiFetch(`/api/sessions/${sid}/proposal/role`);
			expect(getResp.status).toBe(404);
		} finally {
			await deleteSession(sid);
		}
	});

	test("rejects unknown proposal type", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/bogus`);
		expect(resp.status).toBe(400);
	});

	test("rejects unsafe sessionId in URL", async () => {
		// URL parser still routes this to our handler; sessionId regex check fires.
		const resp = await apiFetch(`/api/sessions/has.dot/proposal/goal`);
		expect(resp.status).toBe(400);
	});
});
