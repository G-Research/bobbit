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
import { MAX_GOAL_TITLE_LENGTH } from "../../src/server/agent/goal-candidate-validator.js";

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

	test("invalid goal candidate fields are rejected before first persistence", async ({ gateway }) => {
		const sid = await createSession();
		const fp = proposalPath(gateway.bobbitDir, sid, "goal");
		const cases: Array<{ name: string; overrides: Record<string, unknown>; code: string }> = [
			{ name: "title bound", overrides: { title: "x".repeat(MAX_GOAL_TITLE_LENGTH + 1) }, code: "TITLE_TOO_LONG" },
			{ name: "spec bound", overrides: { spec: "x".repeat(20_001) }, code: "SPEC_TOO_LONG" },
			{
				name: "malformed inline workflow",
				overrides: { workflow: undefined, inlineWorkflow: { id: "bad", name: "Bad", gates: [{ id: "one", name: "One", dependsOn: ["missing"], verify: [] }] } },
				code: "WORKFLOW_INVALID",
			},
			{
				name: "inline role contract",
				overrides: { inlineRoles: { reviewer: { name: "other", label: "Reviewer", promptTemplate: "Review" } } },
				code: "INLINE_ROLES_INVALID",
			},
			{ name: "missing parent", overrides: { parentGoalId: "missing-parent" }, code: "PARENT_NOT_FOUND" },
			{ name: "metadata shape", overrides: { metadata: [] }, code: "METADATA_INVALID" },
			{ name: "concurrency bound", overrides: { maxConcurrentChildren: 9 }, code: "MAX_CONCURRENT_CHILDREN_INVALID" },
			{ name: "divergence policy", overrides: { divergencePolicy: "free" }, code: "DIVERGENCE_POLICY_INVALID" },
		];
		try {
			for (const entry of cases) {
				const response = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
					method: "POST",
					body: JSON.stringify({ args: {
						title: "Invalid candidate",
						spec: "Invalid candidate must not persist.",
						workflow: "feature",
						...entry.overrides,
					} }),
				});
				const text = await response.text();
				expect(response.status, `${entry.name}: ${text}`).toBeGreaterThanOrEqual(400);
				expect(JSON.parse(text), entry.name).toMatchObject({ ok: false, code: entry.code });
				expect(fs.existsSync(fp), `${entry.name} must not create a live draft`).toBe(false);
				expect(latestProposalRevision(gateway.bobbitDir, sid, "goal"), `${entry.name} must not advance revision`).toBe(0);
			}
		} finally {
			await deleteSession(sid);
		}
	});

	test("goal seed accepts omitted cwd and a valid project subdirectory", async ({ gateway }) => {
		const sid = await createSession();
		try {
			const session = gateway.sessionManager.getSession(sid);
			const registry = gateway.sessionManager.getProjectContextManager().getRegistry();
			const projectRoot = registry.get(session.projectId)?.rootPath as string;
			expect(projectRoot).toBeTruthy();

			const omitted = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({ args: {
					title: "Default cwd",
					spec: "Omitted cwd resolves to the selected project.",
					workflow: "feature",
				} }),
			});
			expect(omitted.status, await omitted.clone().text()).toBe(200);

			const subdirectory = path.join(projectRoot, "proposal-valid-subdirectory");
			fs.mkdirSync(subdirectory, { recursive: true });
			const nested = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({ args: {
					title: "Nested cwd",
					spec: "A project subdirectory remains a valid goal cwd.",
					workflow: "feature",
					cwd: subdirectory,
				} }),
			});
			expect(nested.status, await nested.clone().text()).toBe(200);
			expect(fs.readFileSync(proposalPath(gateway.bobbitDir, sid, "goal"), "utf8")).toContain("proposal-valid-subdirectory");
		} finally {
			await deleteSession(sid);
		}
	});

	test("goal edit rejects an outside cwd before changing live bytes or revision", async ({ gateway }) => {
		const sid = await createSession();
		const fp = proposalPath(gateway.bobbitDir, sid, "goal");
		try {
			const session = gateway.sessionManager.getSession(sid);
			const registry = gateway.sessionManager.getProjectContextManager().getRegistry();
			const projectRoot = registry.get(session.projectId)?.rootPath as string;
			const seeded = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({ args: {
					title: "Edit cwd guard",
					spec: "Editing validated frontmatter is transactional.",
					workflow: "feature",
					cwd: projectRoot,
				} }),
			});
			expect(seeded.status, await seeded.clone().text()).toBe(200);
			const before = fs.readFileSync(fp, "utf8");
			const beforeRevision = latestProposalRevision(gateway.bobbitDir, sid, "goal");
			const cwdLine = before.match(/^cwd:.*$/m)?.[0];
			expect(cwdLine).toBeTruthy();
			const outsideCwd = path.join(gateway.bobbitDir, "outside-edit-cwd", sid);

			const edited = await apiFetch(`/api/sessions/${sid}/proposal/goal/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: cwdLine, new_text: `cwd: ${JSON.stringify(outsideCwd)}` }),
			});
			expect(edited.status, await edited.clone().text()).toBe(422);
			expect(await edited.json()).toMatchObject({ ok: false, code: "CWD_OUTSIDE_PROJECT" });
			expect(fs.readFileSync(fp, "utf8")).toBe(before);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal")).toBe(beforeRevision);
			expect(fs.existsSync(fp + ".tmp")).toBe(false);
		} finally {
			await deleteSession(sid);
		}
	});

	test("goal restore rejects a now-invalid snapshot before changing live bytes or revision", async ({ gateway }) => {
		const sid = await createSession();
		const fp = proposalPath(gateway.bobbitDir, sid, "goal");
		try {
			const session = gateway.sessionManager.getSession(sid);
			const registry = gateway.sessionManager.getProjectContextManager().getRegistry();
			const projectRoot = registry.get(session.projectId)?.rootPath as string;
			for (const [title, cwd] of [
				["Restore baseline", projectRoot],
				["Restore live", path.join(projectRoot, "restore-live")],
			]) {
				const seeded = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
					method: "POST",
					body: JSON.stringify({ args: { title, spec: "Restore validation fixture.", workflow: "feature", cwd } }),
				});
				expect(seeded.status, await seeded.clone().text()).toBe(200);
			}
			const liveBefore = fs.readFileSync(fp, "utf8");
			const revisionBefore = latestProposalRevision(gateway.bobbitDir, sid, "goal");
			expect(revisionBefore).toBeGreaterThanOrEqual(2);
			const historyPath = path.join(path.dirname(fp), "goal.history", "1.md");
			const snapshot = fs.readFileSync(historyPath, "utf8");
			const cwdLine = snapshot.match(/^cwd:.*$/m)?.[0];
			expect(cwdLine).toBeTruthy();
			const outsideCwd = path.join(gateway.bobbitDir, "outside-restore-cwd", sid);
			fs.writeFileSync(historyPath, snapshot.replace(cwdLine!, `cwd: ${JSON.stringify(outsideCwd)}`));

			const restored = await apiFetch(`/api/sessions/${sid}/proposal/goal/restore`, {
				method: "POST",
				body: JSON.stringify({ rev: 1 }),
			});
			expect(restored.status, await restored.clone().text()).toBe(422);
			expect(await restored.json()).toMatchObject({ ok: false, code: "CWD_OUTSIDE_PROJECT" });
			expect(fs.readFileSync(fp, "utf8")).toBe(liveBefore);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal")).toBe(revisionBefore);
			expect(fs.existsSync(fp + ".tmp")).toBe(false);
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
