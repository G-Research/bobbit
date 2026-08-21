import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/server/agent/session-store.js";
import { getGateway, type EntityCounts, type GatewayFixture } from "../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createScope, type TestScope } from "../harness/scope.js";

type TaggedSession = {
	id: string;
	projectId?: string;
	archived?: boolean;
	user_tags: string[];
	server_tags: string[];
};

type SessionList = {
	generation: number;
	changed?: boolean;
	sessions?: TaggedSession[];
	archivedDelegates?: TaggedSession[];
};

type PinEvent = {
	type: "sessions_changed";
	sessionId?: string;
	projectId?: string;
	user_tags?: string[];
};

type GoalStateEvent = {
	type: "goal_state_changed";
	goalId: string;
};

type SessionTitleEvent = {
	type: "session_title";
	sessionId: string;
	title: string;
};

let gw: GatewayFixture;
let scope: TestScope;
let baseline: EntityCounts;

beforeAll(async () => {
	gw = await getGateway();
	baseline = snapshotEntities(gw);
});
beforeEach(() => { scope = createScope(gw); });
afterEach(async () => { await scope.cleanup(); });
afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

function pinPath(sessionId: string): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/pin`;
}

async function putPin(sessionId: string, pinned: boolean): Promise<{ response: Response; body: any }> {
	const response = await gw.api(pinPath(sessionId), {
		method: "PUT",
		body: JSON.stringify({ pinned }),
	});
	const body = await response.json();
	return { response, body };
}

async function sessionList(path = "/api/sessions"): Promise<SessionList> {
	const response = await gw.api(path);
	expect(response.status, `${path} should return the session list`).toBe(200);
	return await response.json() as SessionList;
}

function allRows(list: SessionList): TaggedSession[] {
	return [...(list.sessions ?? []), ...(list.archivedDelegates ?? [])];
}

function rowById(list: SessionList, sessionId: string): TaggedSession {
	const matches = allRows(list).filter((row) => row.id === sessionId);
	expect(matches, `session list should serialize ${sessionId} exactly once`).toHaveLength(1);
	return matches[0]!;
}

function expectTagProjection(row: TaggedSession, archived: boolean): void {
	expect(Array.isArray(row.server_tags), "server_tags should always be serialized as an array").toBe(true);
	expect(Array.isArray(row.user_tags), "user_tags should always be serialized as an array").toBe(true);
	expect(row.server_tags).toContain(`archive-state=${archived ? "archived" : "live"}`);
	expect(row.server_tags).toContain(`project-id=${gw.defaultProjectId}`);
	expect(row.server_tags).toContain("team-kind=none");
	expect(row.server_tags.filter((tag) => tag.startsWith("read-state="))).toEqual([
		expect.stringMatching(/^read-state=(?:read|unread)$/),
	]);
	expect(row.server_tags.filter((tag) => tag.startsWith("activity-state="))).toEqual([
		expect.stringMatching(/^activity-state=(?:busy|not-busy)$/),
	]);
}

function projectStore(sessionId: string): any {
	const store = gw.sessionManager.resolveStoreForId(sessionId);
	expect(store, `session ${sessionId} should resolve to a project store`).toBeTruthy();
	return store;
}

async function seedUserTags(sessionId: string, tags: string[]): Promise<void> {
	const store = projectStore(sessionId);
	store.update(sessionId, { user_tags: tags } as any);
	await store.flushAsync();
}

function reloadStore(store: any): SessionStore {
	const stateDir = (store as { storeDir?: string }).storeDir;
	expect(stateDir, "integration fixture should expose the real SessionStore directory at runtime").toEqual(expect.any(String));
	return new SessionStore(stateDir!);
}

async function waitUntilCalled(spy: { mock: { calls: unknown[][] } }, calls: number, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (spy.mock.calls.length >= calls) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`pin persistence barrier was not entered within ${timeoutMs}ms (expected ${calls} flushAsync call(s), saw ${spy.mock.calls.length})`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function waitForPinEvent(ws: WebSocket, sessionId: string, timeoutMs = 2_000): Promise<PinEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`missing sessions_changed pin invalidation for ${sessionId}`));
		}, timeoutMs);
		const onMessage = (raw: unknown) => {
			let message: PinEvent;
			try { message = JSON.parse(String(raw)) as PinEvent; } catch { return; }
			if (message.type !== "sessions_changed" || message.sessionId !== sessionId) return;
			cleanup();
			resolve(message);
		};
		const cleanup = () => {
			clearTimeout(timer);
			ws.off("message", onMessage);
		};
		ws.on("message", onMessage);
	});
}

function waitForGoalStateEvent(ws: WebSocket, goalId: string, timeoutMs = 2_000): Promise<GoalStateEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`missing goal_state_changed for ${goalId}`));
		}, timeoutMs);
		const onMessage = (raw: unknown) => {
			let message: GoalStateEvent;
			try { message = JSON.parse(String(raw)) as GoalStateEvent; } catch { return; }
			if (message.type !== "goal_state_changed" || message.goalId !== goalId) return;
			cleanup();
			resolve(message);
		};
		const cleanup = () => {
			clearTimeout(timer);
			ws.off("message", onMessage);
		};
		ws.on("message", onMessage);
	});
}

function waitForSessionTitleEvent(ws: WebSocket, sessionId: string, title: string, timeoutMs = 2_000): Promise<SessionTitleEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`missing session_title for ${sessionId}`));
		}, timeoutMs);
		const onMessage = (raw: unknown) => {
			let message: SessionTitleEvent;
			try { message = JSON.parse(String(raw)) as SessionTitleEvent; } catch { return; }
			if (message.type !== "session_title" || message.sessionId !== sessionId || message.title !== title) return;
			cleanup();
			resolve(message);
		};
		const cleanup = () => {
			clearTimeout(timer);
			ws.off("message", onMessage);
		};
		ws.on("message", onMessage);
	});
}

function connectWsWithToken(wsBase: string, sessionId: string, token: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}/ws/${sessionId}`);
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onMessage = (raw: unknown) => {
			let message: { type?: string };
			try { message = JSON.parse(String(raw)) as { type?: string }; } catch { return; }
			if (message.type === "auth_ok") { cleanup(); resolve(ws); }
			else if (message.type === "auth_failed") {
				cleanup();
				ws.close();
				reject(new Error("sandbox websocket authentication failed"));
			}
		};
		const cleanup = () => {
			ws.off("error", onError);
			ws.off("message", onMessage);
		};
		ws.on("error", onError);
		ws.on("message", onMessage);
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
	});
}

async function humanOperatorHeaders(): Promise<Record<string, string>> {
	const response = await gw.api("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	expect(response.status).toBe(200);
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	const cookie = setCookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
	expect(cookie, "browser-signaled operator auth should mint a signed cookie").toBeTruthy();
	return { Cookie: cookie! };
}

describe("session pin API", () => {
	it("rejects malformed, broad tag-mutation, and unknown-session requests", async () => {
		const session = await scope.createSession({});
		const invalidBodies: unknown[] = [
			{},
			{ pinned: null },
			{ pinned: "true" },
			{ pinned: 1 },
			[],
			null,
			{ pinned: true, server_tags: ["read-state=read"] },
			{ pinned: true, user_tags: ["other=forbidden"] },
		];

		for (const body of invalidBodies) {
			const response = await gw.api(pinPath(session.id), { method: "PUT", body: JSON.stringify(body) });
			expect(response.status, `invalid pin body ${JSON.stringify(body)} should be rejected`).toBe(400);
		}

		const malformedJson = await gw.api(pinPath(session.id), { method: "PUT", body: "{" });
		expect(malformedJson.status).toBe(400);

		const missing = await putPin(`missing-${randomUUID()}`, true);
		expect(missing.response.status).toBe(404);
	});

	it("uses the same authentication boundary as an existing session mutation", async () => {
		const session = await scope.createSession({});
		const [pinResponse, markReadResponse] = await Promise.all([
			fetch(`${gw.baseURL}${pinPath(session.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pinned: true }),
			}),
			fetch(`${gw.baseURL}/api/sessions/${session.id}/mark-read`, { method: "POST" }),
		]);

		expect(pinResponse.status).toBe(markReadResponse.status);
		expect(pinResponse.status).toBe(401);
		expect(projectStore(session.id).get(session.id).user_tags).toBeUndefined();
	});

	it("normalizes live tags, is idempotent, serializes both tag families, and persists before success", async () => {
		const session = await scope.createSession({});
		await seedUserTags(session.id, ["owner=alice", "pinned=false", "pinned=legacy", "owner=alice"]);
		const before = await sessionList();
		const serverTagsBefore = [...rowById(before, session.id).server_tags].sort();
		const store = projectStore(session.id);
		const flush = vi.spyOn(store, "flushAsync");

		try {
			const first = await putPin(session.id, true);
			expect(first.response.status).toBe(200);
			expect(first.body).toEqual({ user_tags: expect.any(Array) });
			expect(first.body).not.toHaveProperty("server_tags");
			expect(first.body.user_tags).toContain("owner=alice");
			expect(first.body.user_tags.filter((tag: string) => tag.startsWith("pinned="))).toEqual(["pinned=true"]);

			const repeated = await putPin(session.id, true);
			expect(repeated.response.status).toBe(200);
			expect(repeated.body).toEqual(first.body);
			expect(repeated.body.user_tags.filter((tag: string) => tag === "pinned=true")).toHaveLength(1);
			expect(flush).toHaveBeenCalledTimes(2);

			const changed = await sessionList(`/api/sessions?since=${before.generation}`);
			expect(changed.changed).not.toBe(false);
			const listed = rowById(changed, session.id);
			expectTagProjection(listed, false);
			expect([...listed.server_tags].sort()).toEqual(serverTagsBefore);
			expect(listed.user_tags).toEqual(repeated.body.user_tags);

			const restored = reloadStore(store).get(session.id) as any;
			expect(restored.user_tags).toEqual(repeated.body.user_tags);

			const unpinned = await putPin(session.id, false);
			expect(unpinned.response.status).toBe(200);
			expect(unpinned.body.user_tags).toContain("owner=alice");
			expect(unpinned.body.user_tags.some((tag: string) => tag.startsWith("pinned="))).toBe(false);
		} finally {
			flush.mockRestore();
		}
	});

	it("updates a persisted store-only dormant or terminated session", async () => {
		const source = await scope.createSession({});
		const store = projectStore(source.id);
		const persisted = structuredClone(gw.sessionManager.getPersistedSession(source.id));
		const dormantId = scope.trackSession(`pin-dormant-${randomUUID()}`);
		store.put({
			...persisted,
			id: dormantId,
			title: "Store-only pin fixture",
			agentSessionFile: "",
			archived: false,
			archivedAt: undefined,
			user_tags: ["fixture=dormant"],
		} as any);
		await store.flushAsync();
		expect(gw.sessionManager.getSession(dormantId)).toBeUndefined();

		const pinned = await putPin(dormantId, true);
		expect(pinned.response.status).toBe(200);
		expect(pinned.body.user_tags).toEqual(expect.arrayContaining(["fixture=dormant", "pinned=true"]));
		expect((reloadStore(store).get(dormantId) as any).user_tags).toEqual(pinned.body.user_tags);
	});

	it("retains pin metadata through archive and supports archived unpin and repin serialization", async () => {
		const session = await scope.createSession({});
		await seedUserTags(session.id, ["retained=archive"]);
		const pinnedLive = await putPin(session.id, true);
		expect(pinnedLive.response.status).toBe(200);

		const archivedResponse = await gw.api(`/api/sessions/${session.id}`, { method: "DELETE" });
		expect(archivedResponse.ok).toBe(true);
		expect(gw.sessionManager.getArchivedSession(session.id)?.archived).toBe(true);

		const archivedList = await sessionList("/api/sessions?include=archived");
		const archivedBeforeMutation = rowById(archivedList, session.id);
		expectTagProjection(archivedBeforeMutation, true);
		expect(archivedBeforeMutation.user_tags).toEqual(expect.arrayContaining(["retained=archive", "pinned=true"]));
		const serverTagsBefore = [...archivedBeforeMutation.server_tags].sort();

		const unpinned = await putPin(session.id, false);
		expect(unpinned.response.status).toBe(200);
		expect(unpinned.body.user_tags).toEqual(["retained=archive"]);

		const repinned = await putPin(session.id, true);
		expect(repinned.response.status).toBe(200);
		expect(repinned.body.user_tags).toEqual(expect.arrayContaining(["retained=archive", "pinned=true"]));
		const listedAfter = rowById(await sessionList("/api/sessions?include=archived"), session.id);
		expect([...listedAfter.server_tags].sort()).toEqual(serverTagsBefore);
		expect(listedAfter.user_tags).toEqual(repinned.body.user_tags);
		expect((reloadStore(projectStore(session.id)).get(session.id) as any).user_tags).toEqual(repinned.body.user_tags);
	});

	it("does not acknowledge success until flushAsync resolves", async () => {
		const session = await scope.createSession({});
		const store = projectStore(session.id);
		const barrier = deferred();
		const flush = vi.spyOn(store, "flushAsync").mockImplementationOnce(() => barrier.promise);
		let settled = false;
		const request = putPin(session.id, true).then((result) => {
			settled = true;
			return result;
		});

		try {
			await waitUntilCalled(flush, 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled, "pin response must remain pending behind its durability barrier").toBe(false);
			barrier.resolve();
			const result = await request;
			expect(result.response.status).toBe(200);
		} finally {
			barrier.resolve();
			flush.mockRestore();
			await store.flushAsync();
		}
	});

	it("restores an exact missing-field baseline before returning one 500 without invalidation", async () => {
		const session = await scope.createSession({});
		const store = projectStore(session.id);
		const persisted = store.get(session.id) as Record<string, unknown>;
		delete persisted.user_tags;
		await store.flushAsync();
		expect(Object.hasOwn(persisted, "user_tags")).toBe(false);

		const failure = new Error("injected pin persistence failure");
		const flush = vi.spyOn(store, "flushAsync").mockRejectedValueOnce(failure);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const socket = await gw.connectWs(session.id);
		let invalidations = 0;
		const onMessage = (raw: unknown) => {
			try {
				const message = JSON.parse(String(raw)) as PinEvent;
				if (message.type === "sessions_changed" && message.sessionId === session.id) invalidations++;
			} catch { /* ignore non-JSON frames */ }
		};
		socket.on("message", onMessage);

		try {
			const result = await putPin(session.id, true);
			expect(result.response.status).toBe(500);
			expect(result.body).toEqual({ error: failure.message });
			expect(flush).toHaveBeenCalledTimes(2);
			expect(Object.hasOwn(store.get(session.id), "user_tags"), "failed pin must restore field absence in memory").toBe(false);
			expect(rowById(await sessionList(), session.id).user_tags).toEqual([]);
			expect(Object.hasOwn(reloadStore(store).get(session.id)!, "user_tags"), "rollback must durably restore field absence").toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(invalidations).toBe(0);
			expect(errorLog.mock.calls.filter((call) => call[0] === "[api] 500 error:")).toHaveLength(1);
		} finally {
			socket.off("message", onMessage);
			socket.close();
			flush.mockRestore();
			errorLog.mockRestore();
			await store.flushAsync();
		}
	});

	it("retains an archived malformed baseline when mutation and rollback fences fail", async () => {
		const session = await scope.createSession({});
		const store = projectStore(session.id);
		const baseline = ["owner=first", null, "pinned=false", "owner=archive", 42];
		store.update(session.id, { user_tags: baseline } as any);
		await store.flushAsync();
		expect((await gw.api(`/api/sessions/${session.id}`, { method: "DELETE" })).ok).toBe(true);

		const mutationFailure = new Error("injected archived pin persistence failure");
		const rollbackFailure = new Error("injected archived pin rollback failure");
		const flush = vi.spyOn(store, "flushAsync")
			.mockRejectedValueOnce(mutationFailure)
			.mockRejectedValueOnce(rollbackFailure);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const result = await putPin(session.id, true);
			expect(result.response.status).toBe(500);
			expect(result.body).toEqual({ error: mutationFailure.message });
			expect(flush).toHaveBeenCalledTimes(2);
			expect((store.get(session.id) as any).user_tags).toEqual(baseline);
			expect(rowById(await sessionList("/api/sessions?include=archived"), session.id).user_tags)
				.toEqual(["pinned=false", "owner=archive"]);
			expect(errorLog.mock.calls.some((call) => String(call[0]).includes("Failed to persist pin rollback"))).toBe(true);

			flush.mockRestore();
			store.update(session.id, { lastActivity: (store.get(session.id)?.lastActivity ?? 0) + 1 });
			await store.flushAsync();
			expect((reloadStore(store).get(session.id) as any).user_tags).toEqual(baseline);
		} finally {
			flush.mockRestore();
			errorLog.mockRestore();
			await store.flushAsync();
		}
	});

	it("holds a queued follow-up behind rollback persistence and starts it from the restored baseline", async () => {
		const session = await scope.createSession({});
		const store = projectStore(session.id);
		const baseline = ["queue=keep", 42, "pinned=legacy"];
		store.update(session.id, { user_tags: baseline } as any);
		await store.flushAsync();
		const failure = new Error("injected queued pin failure");
		const rollbackBarrier = deferred();
		const flush = vi.spyOn(store, "flushAsync")
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(() => rollbackBarrier.promise);
		const setPinned = gw.sessionManager.setSessionPinned.bind(gw.sessionManager) as
			(sessionId: string, pinned: boolean) => Promise<string[]>;

		try {
			const firstOutcome = setPinned(session.id, true).catch((error) => error);
			await waitUntilCalled(flush, 2);
			let followUpSettled = false;
			const followUp = setPinned(session.id, false).then((tags) => {
				followUpSettled = true;
				return tags;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(flush).toHaveBeenCalledTimes(2);
			expect(followUpSettled, "queued mutation must wait for rollback persistence ordering").toBe(false);
			expect((store.get(session.id) as any).user_tags).toEqual(baseline);

			rollbackBarrier.resolve();
			expect(await firstOutcome).toBe(failure);
			expect(await followUp).toEqual(["queue=keep"]);
			expect(flush).toHaveBeenCalledTimes(3);
			expect((reloadStore(store).get(session.id) as any).user_tags).toEqual(["queue=keep"]);
		} finally {
			rollbackBarrier.resolve();
			flush.mockRestore();
			await store.flushAsync();
		}
	});

	it("applies same-tick concurrent manager mutations in call order", async () => {
		const session = await scope.createSession({});
		await seedUserTags(session.id, ["concurrent=preserved"]);
		const setPinned = gw.sessionManager.setSessionPinned.bind(gw.sessionManager) as
			(sessionId: string, pinned: boolean) => Promise<string[]>;

		await Promise.all([setPinned(session.id, true), setPinned(session.id, false)]);
		let persisted = projectStore(session.id).get(session.id) as any;
		expect(persisted.user_tags).toContain("concurrent=preserved");
		expect(persisted.user_tags.some((tag: string) => tag.startsWith("pinned="))).toBe(false);

		await Promise.all([setPinned(session.id, false), setPinned(session.id, true)]);
		persisted = projectStore(session.id).get(session.id) as any;
		expect(persisted.user_tags.filter((tag: string) => tag === "pinned=true")).toHaveLength(1);
		expect((reloadStore(projectStore(session.id)).get(session.id) as any).user_tags).toEqual(persisted.user_tags);
	});

	it("broadcasts authoritative post-flush tags to two UI clients but not a sandbox principal", async () => {
		const victim = await scope.createSession({});
		const sandboxSession = await scope.createSession({});
		const proofTag = `egress-proof=${randomUUID()}`;
		await seedUserTags(victim.id, ["client-sync=keep", proofTag]);

		const sandboxStore = gw.sessionManager.sandboxTokenStore;
		const sandboxToken = sandboxStore.register(gw.defaultProjectId);
		sandboxStore.addSession(gw.defaultProjectId, sandboxSession.id);
		const [clientA, clientB, sandboxClient] = await Promise.all([
			gw.connectWs(victim.id),
			gw.connectWs(victim.id),
			connectWsWithToken(gw.wsBase, sandboxSession.id, sandboxToken),
		]);
		const sandboxFrames: unknown[] = [];
		const onSandboxMessage = (raw: unknown) => {
			try { sandboxFrames.push(JSON.parse(String(raw))); } catch { /* ignore non-JSON frames */ }
		};
		sandboxClient.on("message", onSandboxMessage);

		const store = projectStore(victim.id);
		const barrier = deferred();
		const flush = vi.spyOn(store, "flushAsync").mockImplementationOnce(() => barrier.promise);
		let deliveredA = false;
		let deliveredB = false;

		try {
			const eventA = waitForPinEvent(clientA, victim.id).then((event) => {
				deliveredA = true;
				return event;
			});
			const eventB = waitForPinEvent(clientB, victim.id).then((event) => {
				deliveredB = true;
				return event;
			});
			const request = putPin(victim.id, true);
			await waitUntilCalled(flush, 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(deliveredA, "UI invalidation must remain behind the persistence barrier").toBe(false);
			expect(deliveredB, "UI invalidation must remain behind the persistence barrier").toBe(false);
			expect(sandboxFrames.filter((frame) => (
				(frame as PinEvent)?.type === "sessions_changed"
				&& (frame as PinEvent)?.sessionId === victim.id
			))).toHaveLength(0);

			barrier.resolve();
			const result = await request;
			expect(result.response.status).toBe(200);
			expect(result.body.user_tags).toEqual(expect.arrayContaining([proofTag, "pinned=true"]));

			for (const event of await Promise.all([eventA, eventB])) {
				expect(event).toMatchObject({
					type: "sessions_changed",
					sessionId: victim.id,
					projectId: gw.defaultProjectId,
					user_tags: result.body.user_tags,
				});
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(sandboxFrames.filter((frame) => (
				(frame as PinEvent)?.type === "sessions_changed"
				&& (frame as PinEvent)?.sessionId === victim.id
			))).toHaveLength(0);
			expect(JSON.stringify(sandboxFrames)).not.toContain(proofTag);
		} finally {
			barrier.resolve();
			flush.mockRestore();
			clientA.close();
			clientB.close();
			sandboxClient.off("message", onSandboxMessage);
			sandboxClient.close();
			sandboxStore.removeSession(gw.defaultProjectId, sandboxSession.id);
			await store.flushAsync();
		}
	});

	it("sends goal state to UI principals while keeping sandbox session delivery scoped", async () => {
		const goal = await scope.createGoal({
			title: `Goal audience ${randomUUID()}`,
			spec: "A focused goal-state WebSocket audience regression fixture.",
			team: false,
			worktree: false,
		});
		const uiSession = await scope.createSession({});
		const sandboxSession = await scope.createSession({});
		const sandboxStore = gw.sessionManager.sandboxTokenStore;
		const sandboxToken = sandboxStore.register(gw.defaultProjectId);
		sandboxStore.addSession(gw.defaultProjectId, sandboxSession.id);
		const [uiClient, sandboxClient] = await Promise.all([
			gw.connectWs(uiSession.id),
			connectWsWithToken(gw.wsBase, sandboxSession.id, sandboxToken),
		]);
		const sandboxFrames: unknown[] = [];
		const onSandboxMessage = (raw: unknown) => {
			try { sandboxFrames.push(JSON.parse(String(raw))); } catch { /* ignore non-JSON frames */ }
		};
		sandboxClient.on("message", onSandboxMessage);

		try {
			const scopedTitle = `sandbox scoped ${randomUUID()}`;
			const targetedDelivery = waitForSessionTitleEvent(sandboxClient, sandboxSession.id, scopedTitle);
			expect(gw.sessionManager.setTitle(sandboxSession.id, scopedTitle)).toBe(true);
			await expect(targetedDelivery).resolves.toMatchObject({
				type: "session_title",
				sessionId: sandboxSession.id,
				title: scopedTitle,
			});

			const uiDelivery = waitForGoalStateEvent(uiClient, goal.id);
			const pause = await gw.api(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				headers: await humanOperatorHeaders(),
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);
			await expect(uiDelivery).resolves.toEqual({ type: "goal_state_changed", goalId: goal.id });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(sandboxFrames.filter(frame => (
				(frame as GoalStateEvent)?.type === "goal_state_changed"
				&& (frame as GoalStateEvent)?.goalId === goal.id
			))).toHaveLength(0);
		} finally {
			uiClient.close();
			sandboxClient.off("message", onSandboxMessage);
			sandboxClient.close();
			sandboxStore.removeSession(gw.defaultProjectId, sandboxSession.id);
		}
	});
});
