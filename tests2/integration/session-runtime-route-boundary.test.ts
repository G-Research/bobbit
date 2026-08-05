import { readdirSync } from "node:fs";
import { test, expect } from "./_e2e/in-process-harness.js";
import { createSession } from "./_e2e/e2e-setup.js";
import { invalidateModelCache } from "../../src/server/agent/model-registry.js";
import {
	createSessionTracker,
	localApiFetch,
	seedArchivedSession,
	seedSessionTranscript,
} from "./helpers/session-fixtures.js";

const sessions = createSessionTracker();

test.describe("session runtime route boundary", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));

	test("uses a cold cached catalog for audit identity and rejects SDK forks before transcript copies", async ({ gateway }) => {
		invalidateModelCache();
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
		});
		expect(archiveRows.find(row => row.id === archivedSdkId)?.modelAvailable).toBeUndefined();
		expect(archiveRows.find(row => row.id === legacyId)).toMatchObject({ runtime: "pi" });
		expect(archiveRows.find(row => row.id === legacyId)?.modelAvailable).toBeUndefined();

		const archivedSingle = await localApiFetch(gateway, `/api/sessions/${archivedSdkId}`);
		expect(archivedSingle.status).toBe(200);
		const archivedSingleBody = await archivedSingle.json();
		expect(archivedSingleBody).toMatchObject({ runtime: "claude-agent-sdk" });
		expect(archivedSingleBody.modelAvailable).toBeUndefined();

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

	test("continues SDK sessions without Pi JSONL recovery or copy side effects", async ({ gateway }) => {
		const sourceId = sessions.add(seedArchivedSession(gateway, {
			agentSessionFile: "",
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000003",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		}));
		const promptDir = `${gateway.bobbitDir}/state/session-prompts`;
		const promptFilesBefore = readdirSync(promptDir).sort();

		const continued = await localApiFetch(gateway, `/api/sessions/${sourceId}/continue`, { method: "POST" });
		expect(continued.status).toBe(201);
		const body = await continued.json() as { id: string };
		sessions.add(body.id);
		expect(gateway.sessionManager.getPersistedSession(body.id)).toMatchObject({
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000003",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		});
		expect(gateway.sessionManager.getPersistedSession(body.id)?.agentSessionFile).toBeFalsy();
		expect(readdirSync(promptDir).sort()).toEqual(promptFilesBefore);
	});

	test("rejects SDK continue without a valid resume id or exact SDK model tuple before creation", async ({ gateway }) => {
		const missingResume = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		}));
		const missingTuple = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000004",
			modelProvider: "claude-agent-sdk",
			modelId: "",
		}));
		const before = gateway.sessionManager.listSessions().length;

		for (const sourceId of [missingResume, missingTuple]) {
			const response = await localApiFetch(gateway, `/api/sessions/${sourceId}/continue`, { method: "POST" });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ code: "RUNTIME_CONTINUE_UNSUPPORTED" });
			expect(gateway.sessionManager.listSessions()).toHaveLength(before);
		}
	});
});
