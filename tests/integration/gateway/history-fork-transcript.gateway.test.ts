import {
	randomUUID,
	fs,
	path,
	test,
	expect,
	nonGitCwd,
	sessions,
	fixtureRoots,
	messageEntry,
	seedTranscript,
	ordinaryHistory,
	setPersistedTranscriptPath,
	removeTrustedRecoveryTranscripts,
	seedTrustedRecoveryTranscript,
	historyFork,
	responseJson,
	filesystemIdentity,
	createTrackedSession,
	installHistoryForkHooks,
} from "../../support/harnesses/integration/history-fork-fixture.js";

test.describe("history fork API: transcript trust and cursor semantics", () => {
	installHistoryForkHooks();

	test("resolves only authoritative persisted or trusted-root transcript paths", async ({ gateway }) => {
		const cwd = path.join(nonGitCwd(), `transcript-resolution-${randomUUID()}`);
		fs.mkdirSync(cwd, { recursive: true });
		fixtureRoots.push(cwd);
		const sourceId = await createTrackedSession(cwd);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const persisted = manager.getPersistedSession(sourceId);

		const canonicalContainer = "/home/node/.bobbit/agent/sessions/--workspace--/authoritative.jsonl";
		expect(manager.recoverSessionFile({
			...persisted,
			sandboxed: true,
			agentSessionFile: canonicalContainer,
		})).toBe(canonicalContainer);
		expect(filesystemIdentity(manager.recoverSessionFile(persisted))).toBe(filesystemIdentity(seeded.file));

		const recovered = seedTrustedRecoveryTranscript(gateway, sourceId, seeded.content);
		const attackerRoot = path.join(gateway.bobbitDir, `untrusted-transcripts-${randomUUID()}`);
		const lexicalParent = path.join(attackerRoot, "lexical-parent");
		fs.mkdirSync(lexicalParent, { recursive: true });
		fixtureRoots.push(attackerRoot);
		const traversalTarget = path.join(attackerRoot, "traversal-canary.jsonl");
		fs.writeFileSync(traversalTarget, seeded.content, "utf8");
		const traversalPath = `${lexicalParent}${path.sep}..${path.sep}${path.basename(traversalTarget)}`;
		const malformedOutside = path.join(attackerRoot, "malformed.jsonl");
		fs.writeFileSync(malformedOutside, '{"not":"a transcript"}\n', "utf8");
		const wrongExtension = path.join(attackerRoot, "recognizable.txt");
		fs.writeFileSync(wrongExtension, seeded.content, "utf8");
		const directoryPath = path.join(attackerRoot, "directory.jsonl");
		fs.mkdirSync(directoryPath);

		const rejectedStoredPaths = [traversalPath, malformedOutside, wrongExtension, directoryPath];
		const symlinkPath = path.join(attackerRoot, "symlink.jsonl");
		try {
			fs.symlinkSync(traversalTarget, symlinkPath, "file");
			rejectedStoredPaths.push(symlinkPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) throw error;
		}

		for (const storedPath of rejectedStoredPaths) {
			const resolved = manager.recoverSessionFile({ ...persisted, agentSessionFile: storedPath });
			expect(filesystemIdentity(resolved), storedPath).toBe(filesystemIdentity(recovered));
			expect(path.resolve(resolved), storedPath).not.toBe(path.resolve(storedPath));
		}

		fs.rmSync(recovered, { force: true });
		for (const storedPath of rejectedStoredPaths) {
			expect(manager.recoverSessionFile({ ...persisted, agentSessionFile: storedPath }), storedPath).toBeNull();
		}
	});
	test("returns stable validation errors without allocating a destination", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const base = ordinaryHistory();
		seedTranscript(gateway, sourceId, base);
		const beforeIds = new Set(gateway.sessionManager.listSessions().map((session: any) => session.id));

		for (const invalid of [null, 42, "", " selected-user", "selected-user ", "x".repeat(257)]) {
			const response = await historyFork(gateway, sourceId, invalid);
			expect(response.status, `invalid cursor ${JSON.stringify(invalid)}`).toBe(400);
			expect(await responseJson(response)).toMatchObject({
				error: "Invalid history fork entry id",
				code: "HISTORY_FORK_CURSOR_INVALID",
			});
		}

		const invalidMode = await historyFork(gateway, sourceId, "selected-user", "false");
		expect(invalidMode.status).toBe(400);
		expect(await responseJson(invalidMode)).toEqual({ error: "Invalid newWorktree flag" });

		const missing = await historyFork(gateway, sourceId, "missing-user");
		expect(missing.status).toBe(409);
		expect(await responseJson(missing)).toEqual({
			error: "This prompt is no longer available",
			code: "HISTORY_FORK_CURSOR_NOT_FOUND",
		});

		seedTranscript(gateway, sourceId, [
			messageEntry("root-user", null, "user", "root"),
			messageEntry("inactive-user", "root-user", "user", "inactive"),
			messageEntry("active-assistant", "root-user", "assistant", "active reply"),
			messageEntry("active-user", "active-assistant", "user", "active prompt"),
		]);
		const inactive = await historyFork(gateway, sourceId, "inactive-user");
		expect(inactive.status).toBe(409);
		expect(await responseJson(inactive)).toEqual({
			error: "This prompt is no longer on the active conversation branch",
			code: "HISTORY_FORK_CURSOR_INACTIVE",
		});

		const nonUser = await historyFork(gateway, sourceId, "active-assistant");
		expect(nonUser.status).toBe(422);
		expect(await responseJson(nonUser)).toEqual({
			error: "History forks must start before a user prompt",
			code: "HISTORY_FORK_CURSOR_NOT_USER",
		});

		seedTranscript(gateway, sourceId, [
			messageEntry("broken-root", "missing-parent", "user", "broken"),
		]);
		const malformed = await historyFork(gateway, sourceId, "broken-root");
		expect(malformed.status).toBe(409);
		expect(await responseJson(malformed)).toEqual({
			error: "The session transcript changed or is not valid for history forking",
			code: "HISTORY_FORK_TRANSCRIPT_INVALID",
		});

		expect(new Set(gateway.sessionManager.listSessions().map((session: any) => session.id))).toEqual(beforeIds);
	});
	test("history fork rejects raw malicious paths and reads only a recovered trusted transcript", async ({ gateway }) => {
		const cwd = path.join(nonGitCwd(), `malicious-fork-source-${randomUUID()}`);
		fs.mkdirSync(cwd, { recursive: true });
		fixtureRoots.push(cwd);
		const sourceId = await createTrackedSession(cwd);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const trusted = seedTrustedRecoveryTranscript(gateway, sourceId, seeded.content);
		const trustedBytes = fs.readFileSync(trusted);

		const attackerRoot = path.join(gateway.bobbitDir, `history-fork-attacker-${randomUUID()}`);
		const lexicalParent = path.join(attackerRoot, "lexical-parent");
		fs.mkdirSync(lexicalParent, { recursive: true });
		fixtureRoots.push(attackerRoot);
		const attackerFile = path.join(attackerRoot, "attacker.jsonl");
		const attackerEntries = [
			messageEntry("attacker-user", null, "user", "ATTACKER_CANARY"),
			messageEntry("attacker-assistant", "attacker-user", "assistant", "attacker answer"),
			messageEntry("selected-user", "attacker-assistant", "user", "attacker selected prompt"),
		];
		const attackerContent = [seeded.header, ...attackerEntries]
			.map(entry => JSON.stringify(entry)).join("\n") + "\n";
		fs.writeFileSync(attackerFile, attackerContent, "utf8");
		const attackerBytes = fs.readFileSync(attackerFile);
		const maliciousStoredPath = `${lexicalParent}${path.sep}..${path.sep}${path.basename(attackerFile)}`;
		setPersistedTranscriptPath(gateway, sourceId, maliciousStoredPath);

		const response = await historyFork(gateway, sourceId, "selected-user", false);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		expect(forkTranscript).toContain("retained prompt");
		expect(forkTranscript).not.toContain("selected prompt");
		expect(forkTranscript).not.toContain("ATTACKER_CANARY");
		expect(fs.readFileSync(attackerFile).equals(attackerBytes), "outside canary remains byte-identical").toBe(true);
		expect(fs.readFileSync(trusted).equals(trustedBytes), "recovered source remains byte-identical").toBe(true);
		expect(gateway.sessionManager.getPersistedSession(sourceId).agentSessionFile).toBe(maliciousStoredPath);
		expect(gateway.sessionManager.getSession(sourceId)).toBeTruthy();

		const unavailableCwd = path.join(nonGitCwd(), `malicious-fork-unavailable-${randomUUID()}`);
		fs.mkdirSync(unavailableCwd, { recursive: true });
		fixtureRoots.push(unavailableCwd);
		const unavailableId = await createTrackedSession(unavailableCwd);
		setPersistedTranscriptPath(gateway, unavailableId, maliciousStoredPath);
		removeTrustedRecoveryTranscripts(unavailableId);
		const beforeIds = new Set(gateway.sessionManager.listSessions().map((session: any) => session.id));
		const missing = await historyFork(gateway, unavailableId, "selected-user", false);
		expect(missing.status).toBe(404);
		expect(await responseJson(missing)).toEqual({ error: "source transcript missing or empty" });
		expect(new Set(gateway.sessionManager.listSessions().map((session: any) => session.id))).toEqual(beforeIds);
		expect(fs.readFileSync(attackerFile).equals(attackerBytes), "failed resolution never mutates the canary").toBe(true);
		expect(gateway.sessionManager.getPersistedSession(unavailableId).agentSessionFile).toBe(maliciousStoredPath);
	});
	test("forks safely before the newest durable user cursor while the source is streaming", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const source = gateway.sessionManager.getSession(sourceId);
		const previousStatus = source.status;
		source.status = "streaming";
		try {
			const response = await historyFork(gateway, sourceId, "selected-user");
			expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
			const fork = await response.json();
			sessions.add(fork.id);
			const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
			const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
			expect(forkTranscript).toContain("retained prompt");
			expect(forkTranscript).not.toContain("selected prompt");
			expect(fs.readFileSync(seeded.file, "utf8")).toBe(seeded.content);
			expect(source.status).toBe("streaming");
		} finally {
			source.status = previousStatus;
		}
	});
});
