import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject, nonGitCwd } from "./_e2e/e2e-setup.js";
import {
	GENERAL_ROLE,
	createSession,
	expectRoleEverywhere,
	purgeSession,
	readJson,
	sessionIdsBySurface,
	type CreatedSession,
} from "./default-standard-session-role-helper.js";

let project: { id: string; rootPath: string };

test.beforeAll(async () => {
	project = await defaultProject();
});

test.describe("standard-session role input normalization and mapping preservation", () => {
	for (const [label, roleId] of [["empty string", ""], ["null", null]] as const) {
		test(`non-worktree creation with ${label} role persists general across every surface`, async ({ gateway }) => {
			let created: CreatedSession | undefined;
			try {
				created = await createSession({ cwd: nonGitCwd(), projectId: project.id, worktree: false, roleId });
				await expectRoleEverywhere(
					gateway,
					created,
					project.id,
					GENERAL_ROLE,
					`${label} roleId must resolve to role=general in POST, live state, persistence, detail, and list`,
				);
			} finally {
				await purgeSession(created?.id);
			}
		});
	}

	test("boolean, number, and object roleId values return 400 without creating a role-less session", async ({ gateway }) => {
		for (const [label, roleId] of [
			["boolean", true],
			["number", 42],
			["object", { name: GENERAL_ROLE }],
		] as const) {
			const before = await sessionIdsBySurface(gateway, project.id);
			let unexpectedSessionId: string | undefined;
			try {
				const response = await apiFetch("/api/sessions", {
					method: "POST",
					body: JSON.stringify({ cwd: nonGitCwd(), projectId: project.id, worktree: false, roleId }),
				});
				const payload = await readJson(response);
				unexpectedSessionId = typeof payload.id === "string" ? payload.id : undefined;
				expect(response.status, `${label} roleId must be rejected; body=${JSON.stringify(payload)}`).toBe(400);
				expect(payload.error).toBe("roleId must be a string or null");
				expect(payload.id, `${label} roleId rejection must not return a created session`).toBeUndefined();
				expect(
					await sessionIdsBySurface(gateway, project.id),
					`${label} roleId rejection must not add a live, persisted, or API-visible role-less session`,
				).toEqual(before);
			} finally {
				await purgeSession(unexpectedSessionId);
			}
		}
	});

});
