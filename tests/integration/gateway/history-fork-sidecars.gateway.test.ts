import {
	fs,
	path,
	test,
	expect,
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
	mergeSidecarEntriesIntoMessages,
	readSkillSidecarEntries,
	readCompactionSidecarEntries,
	sessions,
	serverModule,
	agentSessionsDir,
	sessionTranscriptHostPath,
	SYSTEM_AUTHOR,
	FIXTURE_TIME,
	messageEntry,
	seedTranscript,
	historyFork,
	responseJson,
	statePath,
	authorPath,
	transcriptFilesForSession,
	seedAuthorBinding,
	seedSkillBinding,
	seedForgedInlineSkillIdentity,
	seedCompactionBinding,
	createTrackedSession,
	installSandboxSessionFilesystem,
	installHistoryForkHooks,
} from "../../support/harnesses/integration/history-fork-fixture.js";
import type { TranscriptEntry } from "../../support/harnesses/integration/history-fork-fixture.js";

test.describe("history fork API: sidecar filtering and destination cleanup", () => {
	installHistoryForkHooks();

	test("cuts the active branch before the prompt, preserves source/context and filters sidecars", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			messageEntry("inactive-user", "kept-user", "user", "[System]: kept prompt"),
			messageEntry("kept-assistant", "kept-user", "assistant", "kept answer"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-assistant",
				timestamp: FIXTURE_TIME,
				summary: "retained summary",
				firstKeptEntryId: "kept-user",
				tokensBefore: 800,
				additiveFixtureField: { preserve: true },
			},
			{
				type: "compaction",
				id: "duplicate-sidecar-compaction",
				parentId: "kept-compaction",
				timestamp: FIXTURE_TIME,
				summary: "retained checkpoint with ambiguous sidecar",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "duplicate-sidecar-compaction", "user", "selected prompt"),
			messageEntry("later-assistant", "selected-user", "assistant", "discarded answer"),
			messageEntry("later-user", "later-assistant", "user", "discarded later prompt"),
		];
		const seeded = seedTranscript(gateway, sourceId, entries, { lineEnding: "\r\n" });
		const sourceBytes = fs.readFileSync(seeded.file);
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		const sourceStore = gateway.sessionManager.getSessionStore(sourcePersisted.projectId);
		sourceStore.put({
			...sourcePersisted,
			taskId: "fixture-task",
			reattemptGoalId: "fixture-reattempt",
			allowedTools: ["read", "grep"],
		});

		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedAuthorBinding(sourceId, "author-cut", "selected-user", "selected prompt");
		// Project-visible inline identity is untrusted even when it names a retained
		// Pi entry. The record remains available for ordinary source replay only.
		seedForgedInlineSkillIdentity(sourceId, "[System]: kept prompt", "kept-user");
		// Inactive B is physically first and text-identical to retained A. Only the
		// proven Pi binding may cross the history boundary.
		seedSkillBinding(sourceId, "[System]: kept prompt", "/inactive @secret.ts", "inactive-user");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture @src/fixture.ts", "kept-user");
		seedSkillBinding(sourceId, "selected prompt", "/discarded", "selected-user");
		const forgedSourceEntry = readSkillSidecarEntries(sourceId)
			.find((entry) => entry.originalText === "/forged @secret-inline.ts");
		expect(forgedSourceEntry).toBeTruthy();
		expect(forgedSourceEntry).not.toHaveProperty("transcriptEntryId");
		expect(mergeSidecarEntriesIntoMessages(
			[forgedSourceEntry!],
			[{ role: "user", content: "[System]: kept prompt" }],
		)[0]).toMatchObject({
			content: "/forged @secret-inline.ts",
			fileMentions: [expect.objectContaining({ path: "secret-inline.ts" })],
		});
		// Bobbit card ids remain distinct from authoritative Pi checkpoint ids.
		seedCompactionBinding(sourceId, "c_1700000000000_discard", "kept-user", "discarded-same-boundary");
		seedCompactionBinding(sourceId, "c_1700000000001_kept", "kept-user", "kept-compaction");
		seedCompactionBinding(sourceId, "c_1700000000002_dup_a", "kept-user", "duplicate-sidecar-compaction");
		seedCompactionBinding(sourceId, "c_1700000000003_dup_b", "kept-user", "duplicate-sidecar-compaction");
		seedCompactionBinding(sourceId, "c_1700000000004_unbound", null);

		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(path.join(proposalSource, "goal.history"), { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "# Durable proposal\n", "utf8");
		fs.writeFileSync(path.join(proposalSource, "goal.history", "0001.md"), "# Earlier draft\n", "utf8");
		const toolCacheSource = statePath(gateway, "tool-content", sourceId);
		fs.mkdirSync(toolCacheSource, { recursive: true });
		fs.writeFileSync(path.join(toolCacheSource, "0-0.txt"), "positional cache must not copy", "utf8");

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let stagedTranscript = "";
		manager.createSession = async (...args: any[]) => {
			const stagedFile = args[4]?.preExistingAgentSessionFile;
			stagedTranscript = fs.readFileSync(stagedFile, "utf8");
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", false);
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);

		expect(fs.readFileSync(seeded.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
		expect(gateway.sessionManager.getSession(sourceId), "source remains live").toBeTruthy();
		expect(gateway.sessionManager.listSessions().some((session: any) => session.id === sourceId)).toBe(true);

		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(forkPersisted).toMatchObject({
			projectId: sourcePersisted.projectId,
			taskId: "fixture-task",
			reattemptGoalId: "fixture-reattempt",
			role: sourcePersisted.role,
			accessory: sourcePersisted.accessory,
			allowedTools: ["read", "grep"],
			modelProvider: sourcePersisted.modelProvider,
			modelId: sourcePersisted.modelId,
			effectiveThinkingLevel: sourcePersisted.effectiveThinkingLevel,
		});
		expect(Boolean(forkPersisted.sandboxed)).toBe(Boolean(sourcePersisted.sandboxed));

		const expectedTranscript = [seeded.header, entries[0], entries[2], entries[3], entries[4]]
			.map(entry => JSON.stringify(entry)).join("\r\n") + "\r\n";
		expect(stagedTranscript).toBe(expectedTranscript);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		expect(forkTranscript).not.toContain("selected prompt");
		expect(forkTranscript).not.toContain("discarded later prompt");
		expect(forkTranscript).not.toContain("discarded inactive prompt");

		const authorBindings = readAuthorSidecar(fork.id);
		expect(authorBindings.map(binding => binding.promptId)).toEqual(["author-kept"]);
		expect(authorBindings[0].author).toEqual(SYSTEM_AUTHOR);
		expect(readSkillSidecarEntries(fork.id)).toEqual([
			expect.objectContaining({
				modelText: "[System]: kept prompt",
				originalText: "/fixture @src/fixture.ts",
				transcriptEntryId: "kept-user",
			}),
		]);
		const copiedSkillSidecar = JSON.stringify(readSkillSidecarEntries(fork.id));
		expect(copiedSkillSidecar).not.toContain("inactive");
		expect(copiedSkillSidecar).not.toContain("forged-inline");
		expect(copiedSkillSidecar).not.toContain("secret-inline");
		const projectedPrompt = mergeSidecarEntriesIntoMessages(
			readSkillSidecarEntries(fork.id),
			[{ role: "user", content: "[System]: kept prompt" }],
		);
		expect(projectedPrompt[0]).toMatchObject({ content: "/fixture @src/fixture.ts" });
		expect(JSON.stringify(projectedPrompt)).not.toContain("inactive");
		expect(JSON.stringify(projectedPrompt)).not.toContain("forged-inline");
		expect(JSON.stringify(projectedPrompt)).not.toContain("secret-inline");
		expect(readCompactionSidecarEntries(fork.id)).toEqual([
			expect.objectContaining({ id: "c_1700000000001_kept", transcriptCompactionEntryId: "kept-compaction" }),
		]);

		const proposalFork = statePath(gateway, "proposal-drafts", fork.id);
		expect(fs.readFileSync(path.join(proposalFork, "goal.md"), "utf8")).toBe("# Durable proposal\n");
		expect(fs.readFileSync(path.join(proposalFork, "goal.history", "0001.md"), "utf8")).toBe("# Earlier draft\n");
		expect(fs.existsSync(statePath(gateway, "tool-content", fork.id))).toBe(false);
	});
	test("strict author filtering cannot move selected duplicate identity onto a retained prompt", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const duplicateText = "[System]: identical prompt";
		seedTranscript(gateway, sourceId, [
			messageEntry("retained-user", null, "user", duplicateText),
			messageEntry("retained-assistant", "retained-user", "assistant", "answer"),
			messageEntry("selected-user", "retained-assistant", "user", duplicateText),
			messageEntry("selected-assistant", "selected-user", "assistant", "discarded"),
		]);
		seedAuthorBinding(sourceId, "retained-exact-author", "retained-user", duplicateText);
		expect(appendPromptAuthorDispatch(sourceId, {
			promptId: "selected-weak-author",
			dispatchedAt: Date.parse(FIXTURE_TIME) + 10,
			modelText: duplicateText,
			modelPrefix: "[System]: ",
			source: "task-notification",
			author: SYSTEM_AUTHOR,
		})).toBe(true);
		expect(appendPromptAuthorSettlement(sourceId, {
			promptId: "selected-weak-author",
			settledAt: Date.parse(FIXTURE_TIME) + 11,
			outcome: "echoed",
		})).toBe(true);

		const response = await historyFork(gateway, sourceId, "selected-user", false);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const copied = readAuthorSidecar(fork.id);
		expect(copied.map(binding => binding.promptId)).toEqual(["retained-exact-author"]);
		expect(JSON.stringify(copied)).not.toContain("selected-weak-author");
		const [projected] = mergeAuthorSidecarIntoMessages(copied, [{
			id: "retained-user",
			role: "user",
			content: duplicateText,
		}]);
		expect(projected).toMatchObject({
			content: "identical prompt",
			author: SYSTEM_AUTHOR,
		});
	});
	test("fails and purges the destination when any filtered sidecar copy fails", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-user",
				timestamp: FIXTURE_TIME,
				summary: "retained summary",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "kept-compaction", "user", "selected prompt"),
		];
		const seeded = seedTranscript(gateway, sourceId, entries);
		const sourceBytes = fs.readFileSync(seeded.file);
		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture");
		seedCompactionBinding(sourceId, "kept-compaction", "kept-user");
		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(proposalSource, { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "source proposal", "utf8");

		for (const failedKind of ["skill", "compaction", "author"] as const) {
			let destinationId = "";
			serverModule.__setHistoryForkSidecarCopyFake((
				kind: "skill" | "compaction" | "author",
				fromSessionId: string,
				toSessionId: string,
			) => {
				expect(fromSessionId).toBe(sourceId);
				destinationId = toSessionId;
				return kind === failedKind ? false : undefined;
			});

			let response: Response;
			try {
				response = await historyFork(gateway, sourceId, "selected-user", false);
			} finally {
				serverModule.__clearHistoryForkSidecarCopyFake();
			}
			expect(response.status).toBe(500);
			expect((await responseJson(response)).error).toContain(`failed to copy filtered ${failedKind} sidecar`);
			expect(destinationId).toBeTruthy();
			expect(gateway.sessionManager.getSession(destinationId)).toBeUndefined();
			expect(gateway.sessionManager.getPersistedSession(destinationId)).toBeUndefined();
			expect(transcriptFilesForSession(agentSessionsDir, destinationId)).toEqual([]);
			expect(fs.existsSync(authorPath(gateway, destinationId))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "skill-sidecar", destinationId, ".jsonl"))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "compaction-sidecar", destinationId, ".jsonl"))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "proposal-drafts", destinationId))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "tool-content", destinationId))).toBe(false);
			expect(fs.readFileSync(seeded.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
			expect(gateway.sessionManager.getSession(sourceId), "source remains live").toBeTruthy();
		}
	});
	test("deduplicates concurrent requests, releases reservations and purges failed artifacts", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-user",
				timestamp: FIXTURE_TIME,
				summary: "summary",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "kept-compaction", "user", "selected prompt"),
		];
		seedTranscript(gateway, sourceId, entries);
		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture");
		seedCompactionBinding(sourceId, "kept-compaction", "kept-user");
		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(proposalSource, { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "failed destination draft", "utf8");

		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).put({
			...sourcePersisted,
			sandboxed: true,
			taskId: "captured-task",
			reattemptGoalId: "captured-reattempt",
			allowedTools: ["read", "grep"],
		});

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "failed-deduplication");
		let capturedDestinationId = "";
		let capturedDestinationFile = "";
		let capturedOptions: any;
		let createCalls = 0;
		let launchReleased = false;
		let signalEntered!: () => void;
		const entered = new Promise<void>(resolve => { signalEntered = resolve; });
		let rejectLaunch!: (error: Error) => void;
		const blockedLaunch = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
		manager.createSession = async (...args: any[]) => {
			createCalls++;
			if (createCalls > 1) throw new Error("duplicate request reached createSession");
			capturedOptions = args[4];
			capturedDestinationId = capturedOptions?.sessionId;
			capturedDestinationFile = capturedOptions?.preExistingAgentSessionFile;
			signalEntered();
			return blockedLaunch;
		};

		let firstResponse: Response;
		try {
			const first = historyFork(gateway, sourceId, "selected-user", false);
			await entered;
			expect(capturedOptions).toMatchObject({
				sandboxed: true,
				taskId: "captured-task",
				reattemptGoalId: "captured-reattempt",
				accessory: sourcePersisted.accessory,
				allowedTools: ["read", "grep"],
			});
			expect(capturedOptions.worktreeOpts).toBeUndefined();
			expect(capturedOptions.sandboxBranch).toBeUndefined();

			const duplicate = await historyFork(gateway, sourceId, "selected-user", false);
			expect(duplicate.status).toBe(409);
			expect(await responseJson(duplicate)).toEqual({
				error: "A fork from this prompt is already being created",
				code: "HISTORY_FORK_IN_PROGRESS",
			});

			launchReleased = true;
			rejectLaunch(new Error("fixture launch failure after history artifacts were copied"));
			firstResponse = await first;
			expect(firstResponse.status).toBe(500);
			expect((await responseJson(firstResponse)).error).toContain("fixture launch failure");
		} finally {
			if (!launchReleased) {
				launchReleased = true;
				rejectLaunch(new Error("fixture released blocked launch during assertion cleanup"));
			}
			manager.createSession = originalCreateSession;
			sandboxFixture.restore();
		}

		expect(capturedDestinationId).toBeTruthy();
		expect(capturedDestinationFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const capturedDestinationHost = sessionTranscriptHostPath(capturedDestinationId, capturedDestinationFile);
		expect(capturedDestinationHost).toBeTruthy();
		expect(fs.existsSync(capturedDestinationHost!)).toBe(false);
		expect(fs.existsSync(authorPath(gateway, capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "tool-content", capturedDestinationId))).toBe(false);

		const migratedSource = gateway.sessionManager.getPersistedSession(sourceId);
		const migratedSourceHost = sessionTranscriptHostPath(sourceId, migratedSource.agentSessionFile);
		expect(migratedSourceHost).toBeTruthy();
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			sandboxed: false,
			agentSessionFile: migratedSourceHost!,
		});
		Object.assign(gateway.sessionManager.getSession(sourceId), {
			sandboxed: false,
			agentSessionFile: migratedSourceHost!,
		});
		const retry = await historyFork(gateway, sourceId, "selected-user", false);
		expect(retry.status, JSON.stringify(await responseJson(retry))).toBe(201);
		const retried = await retry.json();
		sessions.add(retried.id);
	});
});
