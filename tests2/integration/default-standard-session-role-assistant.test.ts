import { test, expect } from "./_e2e/in-process-harness.js";
import { defaultProject, nonGitCwd } from "./_e2e/e2e-setup.js";
import {
	createSession,
	expectRoleEverywhere,
	purgeSession,
	type CreatedSession,
} from "./default-standard-session-role-helper.js";

let project: { id: string; rootPath: string };

test.beforeAll(async () => {
	project = await defaultProject();
});

test("assistant creation retains the assistant role mapping", async ({ gateway }) => {
	let created: CreatedSession | undefined;
	try {
		created = await createSession({
			cwd: nonGitCwd(),
			projectId: project.id,
			assistantType: "role",
			worktree: false,
		});
		expect(created.assistantType).toBe("role");
		await expectRoleEverywhere(
			gateway,
			created,
			project.id,
			"assistant",
			"assistant sessions must retain assistantRoleForType mapping instead of defaulting to general",
		);
		expect(created.accessory).toBe("wand");
		expect(gateway.sessionManager.getPersistedSession(created.id)?.accessory).toBe("wand");
	} finally {
		await purgeSession(created?.id);
	}
});
