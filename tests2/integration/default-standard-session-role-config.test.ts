import { test, expect } from "./_e2e/in-process-harness.js";
import { defaultProject, nonGitCwd } from "./_e2e/e2e-setup.js";
import {
	CUSTOM_PROMPT_MARKER,
	CUSTOM_ROLE,
	GENERAL_PROMPT_MARKER,
	GENERAL_ROLE,
	createSession,
	customRole,
	expectInitialRoleConfiguration,
	expectProjectRoles,
	expectRoleEverywhere,
	generalOverride,
	purgeSession,
	putProjectRole,
	removeProjectRole,
	type CreatedSession,
} from "./default-standard-session-role-helper.js";

let project: { id: string; rootPath: string };

test.beforeAll(async () => {
	project = await defaultProject();
	await putProjectRole(project.id, generalOverride);
	await putProjectRole(project.id, customRole);
	await expectProjectRoles(project.id, [GENERAL_ROLE, CUSTOM_ROLE]);
});

test.afterAll(async () => {
	if (!project) return;
	await removeProjectRole(project.id, CUSTOM_ROLE);
	await removeProjectRole(project.id, GENERAL_ROLE);
});

test.describe("project-resolved role configuration at initial standard-session spawn", () => {
	test("an omitted role applies the full project-resolved general configuration", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		try {
			created = await createSession({ cwd: nonGitCwd(), projectId: project.id, worktree: false });
			await expectRoleEverywhere(
				gateway,
				created,
				project.id,
				GENERAL_ROLE,
				"omitted roleId must resolve the project's general role across every surface",
			);
			expect(created.accessory).toBe(generalOverride.accessory);
			expectInitialRoleConfiguration(gateway, created.id, {
				role: GENERAL_ROLE,
				promptMarker: GENERAL_PROMPT_MARKER,
				accessory: generalOverride.accessory,
			});
		} finally {
			await purgeSession(created?.id);
		}
	});

	test("an explicit custom role keeps its full project-resolved initial configuration", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		try {
			created = await createSession({
				cwd: nonGitCwd(),
				projectId: project.id,
				worktree: false,
				roleId: CUSTOM_ROLE,
			});
			await expectRoleEverywhere(
				gateway,
				created,
				project.id,
				CUSTOM_ROLE,
				"explicit project-resolved roles must not be replaced by the standard-session default",
			);
			expect(created.accessory).toBe(customRole.accessory);
			expectInitialRoleConfiguration(gateway, created.id, {
				role: CUSTOM_ROLE,
				promptMarker: CUSTOM_PROMPT_MARKER,
				accessory: customRole.accessory,
			});
		} finally {
			await purgeSession(created?.id);
		}
	});
});
