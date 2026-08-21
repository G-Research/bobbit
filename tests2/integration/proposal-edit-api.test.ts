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
import {
	apiFetch as harnessApiFetch,
	connectWs,
	createGoal,
	createSession,
	deleteSession,
	rawApiFetch,
	seedTeamLeadHeader,
} from "./_e2e/e2e-setup.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_GOAL_TITLE_LENGTH } from "../../src/server/agent/goal-candidate-validator.js";
import { getProposalTypePlugin } from "../../src/server/proposals/proposal-types.js";

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

function sessionCapabilityHeaders(gateway: any, sid: string): Record<string, string> {
	return {
		"X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sid),
	};
}

let operatorCookie: string | undefined;

async function apiFetch(requestPath: string, opts: RequestInit = {}): Promise<Response> {
	const method = (opts.method ?? "GET").toUpperCase();
	const mutatesProposal = /^\/api\/sessions\/[^/]+\/proposal\//.test(requestPath)
		&& (method === "POST" || method === "PUT" || method === "DELETE");
	if (!mutatesProposal) return harnessApiFetch(requestPath, opts);
	operatorCookie ??= await authenticatedOperatorCookie();
	return harnessApiFetch(requestPath, {
		...opts,
		headers: { ...(opts.headers as Record<string, string> | undefined), Cookie: operatorCookie },
	});
}

async function expectProposalOwnerMismatch(response: Response, operation: string): Promise<void> {
	const text = await response.text();
	expect.soft(response.status, `${operation} must reject a foreign session capability: ${text}`).toBe(403);
	expect.soft(text, `${operation} must return the stable structured ownership code`).toContain("PROPOSAL_OWNER_MISMATCH");
}

async function authenticatedOperatorCookie(): Promise<string> {
	const response = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	return setCookies.map(cookie => cookie.split(";")[0])
		.find(cookie => cookie.startsWith("bobbit_session=")) ?? "";
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

	test("foreign session capability cannot mutate a victim proposal or borrow its team-lead parent authority", async ({ gateway }) => {
		const attackerId = await createSession();
		const victimId = await createSession();
		const parent = await createGoal({
			title: `proposal owner parent ${Date.now()}`,
			spec: "Parent goal for proposal-owner authorization regression coverage.",
			workflowId: "feature",
			worktree: false,
			autoStartTeam: false,
			subgoalsAllowed: true,
		});
		const victim = gateway.sessionManager.getSession(victimId) as any;
		const previousRelation = { role: victim.role, goalId: victim.goalId, teamGoalId: victim.teamGoalId };
		const victimHeaders = sessionCapabilityHeaders(gateway, victimId);
		const attackerHeaders = sessionCapabilityHeaders(gateway, attackerId);
		const victimDraft = proposalPath(gateway.bobbitDir, victimId, "goal");
		const connection = await connectWs(victimId);
		try {
			seedTeamLeadHeader(gateway, parent.id, victimId);
			Object.assign(victim, { role: "team-lead", goalId: parent.id, teamGoalId: parent.id });
			for (const title of ["Victim draft v1", "Victim draft v2"]) {
				const seeded = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/seed`, {
					method: "POST",
					headers: victimHeaders,
					body: JSON.stringify({ args: {
						title,
						spec: "Security owner fixture.",
						workflow: "feature",
						projectId: victim.projectId,
					} }),
				});
				expect(seeded.status, await seeded.clone().text()).toBe(200);
			}
			const beforeBytes = fs.readFileSync(victimDraft, "utf8");
			expect(beforeBytes, "the victim's live team-lead relation should inject its parent only for an authenticated owner").toContain(parent.id);
			const beforeRevision = latestProposalRevision(gateway.bobbitDir, victimId, "goal");
			const eventCursor = connection.messageCount();

			const attempts: Array<[string, () => Promise<Response>]> = [
				["seed", () => rawApiFetch(`/api/sessions/${victimId}/proposal/goal/seed`, {
					method: "POST",
					headers: attackerHeaders,
					body: JSON.stringify({ args: {
						title: "Forged victim child",
						spec: "Security owner fixture.",
						workflow: "feature",
						projectId: victim.projectId,
					} }),
				})],
				["edit", () => rawApiFetch(`/api/sessions/${victimId}/proposal/goal/edit`, {
					method: "POST",
					headers: attackerHeaders,
					body: JSON.stringify({ old_text: "Security owner fixture.", new_text: "Forged edit." }),
				})],
				["restore", () => rawApiFetch(`/api/sessions/${victimId}/proposal/goal/restore`, {
					method: "POST",
					headers: attackerHeaders,
					body: JSON.stringify({ rev: 1 }),
				})],
				["worktree-mode", () => rawApiFetch(`/api/sessions/${victimId}/proposal/goal/worktree-mode`, {
					method: "PUT",
					headers: attackerHeaders,
					body: JSON.stringify({ mode: "current-session" }),
				})],
				["delete", () => rawApiFetch(`/api/sessions/${victimId}/proposal/goal`, {
					method: "DELETE",
					headers: attackerHeaders,
				})],
			];
			// Run sequentially: these routes share one draft and must never race.
			for (const [operation, attempt] of attempts) {
				await expectProposalOwnerMismatch(await attempt(), operation);
			}
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(fs.existsSync(victimDraft), "foreign mutations must retain the victim draft").toBe(true);
			if (fs.existsSync(victimDraft)) expect(fs.readFileSync(victimDraft, "utf8")).toBe(beforeBytes);
			expect(latestProposalRevision(gateway.bobbitDir, victimId, "goal")).toBe(beforeRevision);
			const proposalEvents = connection.messages.slice(eventCursor)
				.filter(message => message.type === "proposal_update" || message.type === "proposal_cleared");
			expect(proposalEvents, "denied mutations must not emit victim proposal events").toEqual([]);
		} finally {
			connection.close();
			Object.assign(victim, previousRelation);
			gateway.teamManager.teams?.delete?.(parent.id);
			await deleteSession(attackerId);
			await deleteSession(victimId);
		}
	});

	test("victim capability and explicit signed operator cookie permit equivalent proposal mutations", async ({ gateway }) => {
		const victimId = await createSession();
		const victim = gateway.sessionManager.getSession(victimId) as any;
		const headers = sessionCapabilityHeaders(gateway, victimId);
		try {
			for (const title of ["Owner draft v1", "Owner draft v2"]) {
				const seeded = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/seed`, {
					method: "POST",
					headers,
					body: JSON.stringify({ args: { title, spec: "Owner control fixture.", workflow: "feature", projectId: victim.projectId } }),
				});
				expect(seeded.status, await seeded.clone().text()).toBe(200);
			}
			const edit = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/edit`, {
				method: "POST", headers,
				body: JSON.stringify({ old_text: "Owner draft v2", new_text: "Owner edited" }),
			});
			expect(edit.status, await edit.clone().text()).toBe(200);
			const restore = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/restore`, {
				method: "POST", headers, body: JSON.stringify({ rev: 1 }),
			});
			expect(restore.status, await restore.clone().text()).toBe(200);
			const mode = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/worktree-mode`, {
				method: "PUT", headers, body: JSON.stringify({ mode: "current-session" }),
			});
			expect(mode.status, await mode.clone().text()).toBe(200);

			const operatorCookie = await authenticatedOperatorCookie();
			expect(operatorCookie, "same-origin bearer bootstrap must mint the explicit signed operator credential").not.toBe("");
			const operatorEdit = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/edit`, {
				method: "POST",
				headers: { Cookie: operatorCookie },
				body: JSON.stringify({ old_text: "Owner draft v1", new_text: "Operator edited" }),
			});
			expect(operatorEdit.status, await operatorEdit.clone().text()).toBe(200);

			const deleted = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal`, { method: "DELETE", headers });
			expect(deleted.status).toBe(204);
		} finally {
			await deleteSession(victimId);
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

	test("legacy inline snapshots survive title/spec edits and restore while modified invalid input rejects", async ({ gateway }) => {
		const sid = await createSession();
		const fp = proposalPath(gateway.bobbitDir, sid, "goal");
		try {
			const session = gateway.sessionManager.getSession(sid);
			const registry = gateway.sessionManager.getProjectContextManager().getRegistry();
			const projectRoot = registry.get(session.projectId)?.rootPath as string;
			const seeded = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({ args: {
					title: "Compatibility baseline",
					spec: "Original legacy proposal spec.",
					workflow: "feature",
					cwd: projectRoot,
				} }),
			});
			expect(seeded.status, await seeded.clone().text()).toBe(200);

			const legacyWorkflow = {
				id: "legacy-inline",
				name: "Legacy inline",
				description: "Retired verification step fixture.",
				createdAt: 3,
				updatedAt: 4,
				gates: [{
					id: "legacy-gate",
					name: "Legacy gate",
					dependsOn: [],
					verify: [{ name: "Retired remote state", type: "remote-state" }],
				}],
			};
			const legacyRoles = {
				"legacy-reviewer": {
					name: "legacy-reviewer",
					label: "Legacy reviewer",
					promptTemplate: "Keep exact legacy values.",
					accessory: "vintage",
					model: "retired-bare-model",
					thinkingLevel: "legacy-depth",
					toolPolicies: { bash: "retired-policy" },
					createdAt: 7,
					updatedAt: 8,
				},
			};
			const legacyContent = getProposalTypePlugin("goal").serialize({
				title: "Legacy title",
				spec: "Legacy spec body.",
				projectId: session.projectId,
				cwd: projectRoot,
				inlineWorkflow: legacyWorkflow,
				inlineRoles: legacyRoles,
			});
			const historyOne = path.join(path.dirname(fp), "goal.history", "1.md");
			fs.writeFileSync(fp, legacyContent);
			fs.writeFileSync(historyOne, legacyContent);

			const editTitle = await apiFetch(`/api/sessions/${sid}/proposal/goal/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "Legacy title", new_text: "Edited legacy title" }),
			});
			expect(editTitle.status, await editTitle.clone().text()).toBe(200);
			const editedTitleContent = (await editTitle.json()).newContent as string;
			const parsedTitleEdit = getProposalTypePlugin("goal").parse(editedTitleContent);
			expect(parsedTitleEdit.ok).toBe(true);
			if (parsedTitleEdit.ok) expect(parsedTitleEdit.value.fields).toMatchObject({ inlineWorkflow: legacyWorkflow, inlineRoles: legacyRoles });

			const editSpec = await apiFetch(`/api/sessions/${sid}/proposal/goal/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "Legacy spec body.", new_text: "Edited legacy spec body." }),
			});
			expect(editSpec.status, await editSpec.clone().text()).toBe(200);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal")).toBe(3);

			const restored = await apiFetch(`/api/sessions/${sid}/proposal/goal/restore`, {
				method: "POST",
				body: JSON.stringify({ rev: 1 }),
			});
			expect(restored.status, await restored.clone().text()).toBe(200);
			const restoredBody = await restored.json();
			expect(restoredBody.newRev).toBe(4);
			expect(restoredBody.fields).toMatchObject({ title: "Legacy title", inlineWorkflow: legacyWorkflow, inlineRoles: legacyRoles });
			expect(fs.readFileSync(fp, "utf8")).toBe(legacyContent);

			const beforeInvalid = fs.readFileSync(fp, "utf8");
			const beforeInvalidRevision = latestProposalRevision(gateway.bobbitDir, sid, "goal");
			const invalidEdit = await apiFetch(`/api/sessions/${sid}/proposal/goal/edit`, {
				method: "POST",
				body: JSON.stringify({ old_text: "thinkingLevel: legacy-depth", new_text: "thinkingLevel: newly-invalid" }),
			});
			expect(invalidEdit.status, await invalidEdit.clone().text()).toBe(400);
			expect(await invalidEdit.json()).toMatchObject({ ok: false, code: "INLINE_ROLES_INVALID" });
			expect(fs.readFileSync(fp, "utf8")).toBe(beforeInvalid);
			expect(latestProposalRevision(gateway.bobbitDir, sid, "goal")).toBe(beforeInvalidRevision);
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
