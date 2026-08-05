import { test, expect } from "./_e2e/in-process-harness.js";
import { createSession } from "./_e2e/e2e-setup.js";
import {
	createSessionTracker,
	localApiFetch,
	seedArchivedSession,
	seedSessionTranscript,
} from "./helpers/session-fixtures.js";

const sessions = createSessionTracker();

test.describe("session runtime route boundary", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));

	test("projects persisted runtime availability and rejects SDK forks before transcript copies", async ({ gateway }) => {
		const archivedSdkId = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000001",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		}));
		const legacyId = sessions.add(seedArchivedSession(gateway, {}));

		const archiveList = await localApiFetch(gateway, "/api/sessions?include=archived");
		expect(archiveList.status).toBe(200);
		const archiveRows = (await archiveList.json()).sessions as any[];
		expect(archiveRows.find(row => row.id === archivedSdkId)).toMatchObject({
			runtime: "claude-agent-sdk",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
			modelAvailable: false,
		});
		expect(archiveRows.find(row => row.id === legacyId)).toMatchObject({ runtime: "pi" });
		expect(archiveRows.find(row => row.id === legacyId)?.modelAvailable).toBeUndefined();

		const archivedSingle = await localApiFetch(gateway, `/api/sessions/${archivedSdkId}`);
		expect(archivedSingle.status).toBe(200);
		expect(await archivedSingle.json()).toMatchObject({
			runtime: "claude-agent-sdk",
			modelAvailable: false,
		});

		const sourceId = sessions.add(await createSession());
		const sourceTranscript = seedSessionTranscript(gateway, sourceId, [
			{ role: "user", text: "SDK_FORK_MUST_NOT_COPY" },
		]);
		const sourceBefore = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourceBefore.projectId).update(sourceId, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000002",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		});
		const countBefore = gateway.sessionManager.listSessions().length;

		const fork = await localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
			method: "POST",
			body: JSON.stringify({ newWorktree: false }),
		});
		expect(fork.status).toBe(422);
		expect(await fork.json()).toMatchObject({ code: "RUNTIME_FORK_UNSUPPORTED" });
		expect(gateway.sessionManager.listSessions()).toHaveLength(countBefore);
		expect(gateway.sessionManager.getPersistedSession(sourceId)?.agentSessionFile).toBe(sourceTranscript);
	});
});
