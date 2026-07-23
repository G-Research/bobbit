/**
 * API E2E tests for Continue-Archived (POST /api/sessions/:archivedId/continue).
 *
 * Lossless flow:
 *   - Source `.jsonl` is cloned into a fresh slot under <globalAgentDir()>/sessions/.
 *   - The new session's `agentSessionFile` field points at the clone.
 *   - The agent CLI rehydrates from the clone via `switch_session`.
 *   - There is no seed-mode parameter, no system-prompt seeding, no byte cap.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession as createSessionFromHarness,
	messageEndPredicate,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import { LOCAL_USER_AUTHOR } from "../../src/shared/message-author.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";
import {
	createSessionTracker,
	localApiFetch,
	seedArchivedSession,
	seedSessionTranscript,
	trackGoal,
	waitForSessionIdle,
} from "./helpers/session-fixtures.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const sessions = createSessionTracker();

async function archive(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `archive ${id}: ${resp.status}`).toBe(true);
}

async function getArchivedRec(id: string): Promise<any> {
	const arch = await (await apiFetch("/api/sessions?include=archived")).json();
	return (arch.sessions as any[]).find(s => s.id === id) || null;
}

async function makeArchivedSourceSession(gateway: any, opts?: {
	promptText?: string;
	roleId?: string;
}): Promise<string> {
	return sessions.add(seedArchivedSession(gateway, {
		cwd: nonGitCwd(),
		...(opts?.roleId ? { role: opts.roleId } : {}),
	}, [{
		role: "user",
		text: opts?.promptText || "Hello from the original session, please acknowledge.",
	}]));
}

async function trackContinuedSession(resp: Response): Promise<void> {
	if (resp.status !== 201) return;
	const data = await resp.clone().json();
	if (data?.id) sessions.add(data.id);
}

const SYSTEM_AUTHOR = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;

function authorSidecarPath(gateway: any, sessionId: string): string {
	return path.join(gateway.bobbitDir, "secrets", "author-sidecar", `${sessionId}.jsonl`);
}

function rawAuthorSidecarRecords(gateway: any, sessionId: string): any[] {
	const target = authorSidecarPath(gateway, sessionId);
	if (!fs.existsSync(target)) return [];
	return fs.readFileSync(target, "utf8")
		.split(/\r?\n/)
		.filter(line => line.trim())
		.map(line => JSON.parse(line));
}

function seedSystemAuthorSidecar(
	_gateway: any,
	sessionId: string,
	baseModelText: string,
	options: { settled?: boolean } = {},
): string {
	const promptId = `prompt-${sessionId}`;
	const dispatchedAt = Date.now();
	const modelPrefix = "[System]: ";
	const modelText = `${modelPrefix}${baseModelText}`;
	expect(appendPromptAuthorDispatch(sessionId, {
		promptId,
		dispatchedAt,
		modelText,
		modelPrefix,
		source: "task-notification",
		author: SYSTEM_AUTHOR,
	} as Parameters<typeof appendPromptAuthorDispatch>[1])).toBe(true);
	if (options.settled === false) return promptId;
	expect(appendPromptAuthorSettlement(sessionId, {
		promptId,
		settledAt: dispatchedAt + 1,
		outcome: "echoed",
	})).toBe(true);
	return promptId;
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function expectBufferedReplayAuthor(
	gateway: any,
	sessionId: string,
	marker: string,
	author: typeof SYSTEM_AUTHOR | typeof LOCAL_USER_AUTHOR,
): void {
	const session = gateway.sessionManager.getSession(sessionId);
	const replay = session?.eventBuffer.getAll()
		.map((entry: any) => entry.event)
		.find((event: any) => event?.type === "message_end"
			&& event.message?.role === "user"
			&& messageText(event.message) === marker);
	expect(replay, `EventBuffer contains replayed prompt ${marker}`).toBeTruthy();
	expect(replay.message.author).toEqual(author);
}

function expectBufferedSystemReplay(gateway: any, sessionId: string, marker: string): void {
	expectBufferedReplayAuthor(gateway, sessionId, marker, SYSTEM_AUTHOR);
}

function expectCopiedSystemBinding(gateway: any, sessionId: string, marker: string): void {
	const rawModelText = `[System]: ${marker}`;
	const binding = readAuthorSidecar(sessionId).find(entry =>
		promptAuthorBindingMatchesText(entry, rawModelText),
	);
	expect(binding).toMatchObject({
		modelPrefix: "[System]: ",
		author: SYSTEM_AUTHOR,
		settlement: { outcome: "echoed" },
	});
	expect(promptAuthorBindingMatchesText(binding!, marker),
		"copied binding digest remains keyed to exact prefixed Pi text").toBe(false);
	const dispatch = rawAuthorSidecarRecords(gateway, sessionId).find(record =>
		record.type === "prompt-author" && record.promptId === binding?.promptId,
	);
	expect(dispatch).toMatchObject({ modelPrefix: "[System]: ", author: SYSTEM_AUTHOR });
}

/** Make the in-process bridge mirror Pi's switch_session replay events. */
async function withSwitchReplayEvents<T>(run: () => Promise<T>): Promise<T> {
	const { rpcBridge } = await loadServerTestRuntime();
	const originalFactory = rpcBridge.getRegisteredRpcBridgeFactory();
	if (!originalFactory) throw new Error("gateway RPC bridge factory is not registered");

	rpcBridge.registerRpcBridgeFactory((options: any) => {
		const bridge: any = originalFactory(options);
		if (!bridge) return null;
		const listeners = new Set<(event: any) => void>();
		return new Proxy(bridge, {
			get(target, property) {
				if (property === "onEvent") {
					return (listener: (event: any) => void) => {
						listeners.add(listener);
						const unsubscribe = target.onEvent(listener);
						return () => {
							listeners.delete(listener);
							unsubscribe();
						};
					};
				}
				if (property === "sendCommand") {
					return async (command: any, ...args: any[]) => {
						const response = await target.sendCommand(command, ...args);
						if (response?.success && command?.type === "switch_session" && fs.existsSync(command.sessionPath)) {
							for (const line of fs.readFileSync(command.sessionPath, "utf8").split(/\r?\n/)) {
								if (!line.trim()) continue;
								try {
									const record = JSON.parse(line);
									if (record?.type !== "message" || !record.message) continue;
									for (const listener of listeners) listener({ type: "message_end", message: record.message });
								} catch { /* malformed transcript rows are ignored by Pi too */ }
							}
						}
						return response;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});

	try {
		return await run();
	} finally {
		rpcBridge.registerRpcBridgeFactory(originalFactory);
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe("Continue-Archived API (lossless)", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));
	test("happy path: returns 201 with Continued: title and a fresh session id", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway, {
			promptText: "UNIQUE_MARKER_ALPHA hello world",
		});

		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(archivedId);
		expect(data.title).toMatch(/^Continued: /);

		// switch_session completes in the create pipeline; observe its live state
		// directly instead of polling the REST representation.
		await waitForSessionIdle(gateway, data.id);
		expect(gateway.sessionManager.getSession(data.id)?.status).toBe("idle");
	});

	test("body fields are ignored — legacy {mode:'summary'} no longer 400s", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);

		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({ mode: "summary" }),
		});
		expect(resp.status).toBe(201);
		await trackContinuedSession(resp);
	});

	test("empty body returns 201", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: "",
		});
		expect(resp.status).toBe(201);
		await trackContinuedSession(resp);
	});

	test("title format: 'Continued: <original title>' and survives first prompt", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);

		const before = gateway.sessionManager.getPersistedSession(data.id)?.title;
		expect(before?.startsWith("Continued: ")).toBe(true);

		// markGenerated:true protects the title from the first-prompt auto-titler.
		const prompt = await gateway.sessionManager.enqueuePrompt(data.id, "hi");
		expect(prompt.status).toBe("dispatched");
		await waitForSessionIdle(gateway, data.id);
		expect(gateway.sessionManager.getPersistedSession(data.id)?.title).toBe(before);
	});

	test("unknown session returns 404", async ({ gateway }) => {
		const resp = await localApiFetch(gateway, `/api/sessions/does-not-exist-abc123/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(404);
	});

	test("not-archived (live) session returns 409", async ({ gateway }) => {
		const liveId = sessions.add(await createSessionFromHarness());
		try {
			const resp = await localApiFetch(gateway, `/api/sessions/${liveId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(409);
		} finally {
			await archive(liveId).catch(() => {});
		}
	});

	test("goal-linked session returns 422", async ({ gateway }) => {
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Archived goal test", cwd: nonGitCwd(), team: false, worktree: false, workflowId: "general" }),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		trackGoal(goal.id);
		const sid = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			goalId: goal.id,
		}));

		const resp = await localApiFetch(gateway, `/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
	});

	test("delegate session returns 422", async ({ gateway }) => {
		const delegateId = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			delegateOf: "fixture-parent-session",
		}));

		const resp = await localApiFetch(gateway, `/api/sessions/${delegateId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
	});

	test("assistant session (assistantType) is now allowed — returns 201", async ({ gateway }) => {
		// Path B of the Reopen-Archived-Proposals design: assistant sessions can
		// now be continued. The 422 block remains only for goal/delegate/team
		// sessions (covered by sibling tests above).
		const sid = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			assistantType: "goal",
		}, [{ role: "user", text: "assistant init" }]));

		const cont = await localApiFetch(gateway, `/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(201);
		const data = await cont.json();
		sessions.add(data.id);
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(sid);
		expect(data.assistantType).toBe("goal");
	});

	test("role copied to new session", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway, { roleId: "general" });
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);
		expect(gateway.sessionManager.getPersistedSession(data.id)?.role).toBe("general");
	});

	test("archived session with empty .jsonl returns 404", async ({ gateway }) => {
		const id = sessions.add(seedArchivedSession(gateway, { cwd: nonGitCwd() }, []));

		const rec = await getArchivedRec(id);
		if (rec?.agentSessionFile && fs.existsSync(rec.agentSessionFile)) {
			fs.writeFileSync(rec.agentSessionFile, "");
		}

		const cont = await localApiFetch(gateway, `/api/sessions/${id}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(404);
	});
});

test.describe("fork/continue author replay lifecycle", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));

	test("fork copies author bindings before switch_session replay reaches EventBuffer", async ({ gateway }) => {
		const marker = "FORK_SYSTEM_AUTHOR_REPLAY";
		const sourceId = sessions.add(await createSessionFromHarness());
		seedSessionTranscript(gateway, sourceId, [{ role: "user", text: `[System]: ${marker}` }]);
		seedSystemAuthorSidecar(gateway, sourceId, marker);

		const response = await withSwitchReplayEvents(() => localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
			method: "POST",
			body: JSON.stringify({ newWorktree: false }),
		}));
		expect(response.status, await response.clone().text()).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);

		expectBufferedSystemReplay(gateway, fork.id, marker);
		expect(fs.existsSync(authorSidecarPath(gateway, fork.id))).toBe(true);
		expectCopiedSystemBinding(gateway, fork.id, marker);
	});

	test("live fork keeps a new same-text human prompt local when the source binding is unresolved", async ({ gateway }) => {
		const marker = "FORK_UNRESOLVED_SAME_TEXT_STAYS_USER";
		const sourceId = sessions.add(await createSessionFromHarness());
		const sourceTranscript = seedSessionTranscript(gateway, sourceId, [
			{ role: "user", text: "SOURCE_HISTORY_WITH_NO_RACE_MARKER" },
		]);

		const foreignPromptId = seedSystemAuthorSidecar(gateway, sourceId, marker, { settled: false });
		const [sourceBinding] = readAuthorSidecar(sourceId);
		if (!sourceBinding) throw new Error("unresolved source author binding was not persisted");
		expect(sourceBinding).toMatchObject({
			promptId: foreignPromptId,
			author: SYSTEM_AUTHOR,
		});
		expect(sourceBinding.settlement).toBeUndefined();
		expect((sourceBinding as any).modelPrefix).toBe("[System]: ");
		expect(promptAuthorBindingMatchesText(sourceBinding, `[System]: ${marker}`)).toBe(true);
		expect(promptAuthorBindingMatchesText(sourceBinding, marker)).toBe(false);
		expect(fs.readFileSync(sourceTranscript, "utf8")).not.toContain(marker);

		const response = await withSwitchReplayEvents(() => localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
			method: "POST",
			body: JSON.stringify({ newWorktree: false }),
		}));
		expect(response.status, await response.clone().text()).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);

		// The unresolved source dispatch is not transcript history and must not
		// become destination correlation state before the new human occurrence.
		expect(readAuthorSidecar(fork.id)).toEqual([]);
		expect(rawAuthorSidecarRecords(gateway, fork.id)).toEqual([]);

		const agentClock = attachLocalMockAgentClock(gateway, fork.id);
		const conn = await connectWs(fork.id);
		try {
			const liveCursor = conn.messageCount();
			conn.send({ type: "prompt", text: marker });
			const liveUser = await conn.waitForFrom(liveCursor, (message) =>
				messageEndPredicate("user")(message)
				&& messageText(message.data.message) === marker,
			);
			expect(liveUser.data.message.author).toEqual(LOCAL_USER_AUTHOR);

			await agentClock.settleCurrentPrompt();
			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const snapshotFrame = await conn.waitForFrom(snapshotCursor, message => message.type === "messages");
			const snapshotMessages = Array.isArray(snapshotFrame.data)
				? snapshotFrame.data
				: snapshotFrame.data?.messages ?? [];
			const snapshotUser = snapshotMessages.find((message: any) =>
				message.role === "user" && messageText(message) === marker,
			);
			expect(snapshotUser, "fork snapshot contains the newly accepted human prompt").toBeTruthy();
			expect(snapshotUser.author).toEqual(LOCAL_USER_AUTHOR);
		} finally {
			conn.close();
		}

		const destinationBindings = readAuthorSidecar(fork.id);
		const localBinding = destinationBindings.find(binding => promptAuthorBindingMatchesText(binding, marker));
		expect(localBinding).toMatchObject({
			author: LOCAL_USER_AUTHOR,
			settlement: { outcome: "echoed" },
		});
		expect(localBinding?.promptId).not.toBe(foreignPromptId);

		const destinationRecords = rawAuthorSidecarRecords(gateway, fork.id);
		expect(destinationRecords.some(record =>
			record.type === "prompt-author" && record.promptId === foreignPromptId,
		), "foreign source dispatch is not copied").toBe(false);
		expect(destinationRecords.some(record =>
			record.type === "prompt-author-settlement" && record.promptId === foreignPromptId,
		), "foreign source prompt is not settled in the destination").toBe(false);
	});

	test("continue copies author bindings before switch_session replay reaches EventBuffer", async ({ gateway }) => {
		const marker = "CONTINUE_SYSTEM_AUTHOR_REPLAY";
		const archivedId = await makeArchivedSourceSession(gateway, { promptText: `[System]: ${marker}` });
		seedSystemAuthorSidecar(gateway, archivedId, marker);

		const response = await withSwitchReplayEvents(() => localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		}));
		expect(response.status, await response.clone().text()).toBe(201);
		const continued = await response.json();
		sessions.add(continued.id);

		expectBufferedSystemReplay(gateway, continued.id, marker);
		expect(fs.existsSync(authorSidecarPath(gateway, continued.id))).toBe(true);
		expectCopiedSystemBinding(gateway, continued.id, marker);
	});

	test("failed fork and continue setup purge their pre-copied destination sidecars", async ({ gateway }) => {
		const forkMarker = "FORK_FAILED_SETUP_AUTHOR";
		const forkSourceId = sessions.add(await createSessionFromHarness());
		seedSessionTranscript(gateway, forkSourceId, [{ role: "user", text: `[System]: ${forkMarker}` }]);
		seedSystemAuthorSidecar(gateway, forkSourceId, forkMarker);

		const continueMarker = "CONTINUE_FAILED_SETUP_AUTHOR";
		const archivedId = await makeArchivedSourceSession(gateway, { promptText: `[System]: ${continueMarker}` });
		seedSystemAuthorSidecar(gateway, archivedId, continueMarker);

		const sessionManager = gateway.sessionManager;
		const originalCreateSession = sessionManager.createSession;
		const failedDestinationIds: string[] = [];
		const bindingsBeforeFailure: any[][] = [];
		sessionManager.createSession = async (...args: any[]) => {
			const destinationId = args[4]?.sessionId;
			if (typeof destinationId === "string") {
				failedDestinationIds.push(destinationId);
				bindingsBeforeFailure.push(readAuthorSidecar(destinationId));
			}
			throw new Error("fixture setup failure after sidecar copy");
		};
		try {
			const forkResponse = await localApiFetch(gateway, `/api/sessions/${forkSourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(forkResponse.status).toBe(500);

			const continueResponse = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(continueResponse.status).toBe(500);
		} finally {
			sessionManager.createSession = originalCreateSession;
		}

		expect(failedDestinationIds).toHaveLength(2);
		expect(bindingsBeforeFailure).toHaveLength(2);
		for (const copied of bindingsBeforeFailure) {
			expect(copied, "destination sidecar was copied before setup failed").toHaveLength(1);
			expect(copied[0].modelPrefix).toBe("[System]: ");
		}
		for (const destinationId of failedDestinationIds) {
			expect(fs.existsSync(authorSidecarPath(gateway, destinationId))).toBe(false);
		}
	});
});
