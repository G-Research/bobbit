import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type GatewayInfo } from "./gateway-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	registerProject,
	waitForHealth,
	waitForSessionStatus,
	type WsConnection,
} from "./e2e-setup.js";
import { awaitableRm } from "./test-utils/cleanup.js";

type ArchivedRow = {
	id: string;
	title: string;
	cwd: string;
	agentSessionFile: string;
	createdAt: number;
	lastActivity: number;
	projectId: string;
	archived: true;
	archivedAt: number;
	delegateOf?: string;
	parentSessionId?: string;
	teamLeadSessionId?: string;
	teamGoalId?: string;
	goalId?: string;
};

type SessionStoreLike = {
	put(session: ArchivedRow): void;
};

type SessionsEnvelope = {
	generation: number;
	sessions: Array<{ id: string; status?: string; archived?: boolean; archivedAt?: number }>;
	archivedDelegates: Array<{ id: string }>;
	total?: number;
	limit?: number;
	offset?: number;
	hasMore?: boolean;
	nextOffset?: number;
	nextCursor?: number;
};

const RELATION_FIELDS = ["delegateOf", "parentSessionId", "teamLeadSessionId", "teamGoalId", "goalId"] as const;

function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionStoreForProject(gateway: GatewayInfo, projectId: string): SessionStoreLike {
	const sm = gateway.sessionManager as {
		getProjectContextManager?: () => unknown;
		projectContextManager?: unknown;
	};
	const pcm = (sm.getProjectContextManager?.() ?? sm.projectContextManager) as {
		getOrCreate(id: string): { sessionStore: SessionStoreLike } | null;
	};
	const context = pcm.getOrCreate(projectId);
	if (!context) throw new Error(`missing project context ${projectId}`);
	return context.sessionStore;
}

function makeArchivedRows(
	projectId: string,
	rootPath: string,
	liveRootId: string,
	suffix: string,
): ArchivedRow[] {
	const now = Date.now() - 10_000;
	const rows: ArchivedRow[] = [];
	const add = (label: string, links: Partial<ArchivedRow>): ArchivedRow => {
		const id = `session-load-${suffix}-${label}`;
		const archivedAt = now - rows.length * 1_000;
		const row: ArchivedRow = {
			id,
			title: `Session loading ${label}`,
			cwd: rootPath,
			agentSessionFile: join(rootPath, `${id}.jsonl`),
			createdAt: archivedAt - 60_000,
			lastActivity: archivedAt - 30_000,
			projectId,
			archived: true,
			archivedAt,
			...links,
		};
		rows.push(row);
		return row;
	};

	// A wide reachable fan-out exercises the hot archived-child lookup. Rotate
	// through every supported relationship key so the API contract is pinned at
	// the public boundary rather than only for delegateOf.
	for (let i = 0; i < 20; i++) {
		add(`reachable-wide-${i}`, { [RELATION_FIELDS[i % RELATION_FIELDS.length]]: liveRootId });
	}

	// A deeper chain proves cursor-based BFS does not stop after direct children.
	let chainParent = liveRootId;
	for (let i = 0; i < 8; i++) {
		const row = add(`reachable-chain-${i}`, { [RELATION_FIELDS[i % RELATION_FIELDS.length]]: chainParent });
		chainParent = row.id;
	}

	// One row matches several buckets but must be returned once.
	add("reachable-dedup", {
		delegateOf: liveRootId,
		parentSessionId: liveRootId,
		teamLeadSessionId: liveRootId,
	});

	// Reachable cycle: traversal must terminate without changing stable order.
	const cycle0Id = `session-load-${suffix}-reachable-cycle-0`;
	const cycle1Id = `session-load-${suffix}-reachable-cycle-1`;
	const cycle2Id = `session-load-${suffix}-reachable-cycle-2`;
	add("reachable-cycle-0", { delegateOf: liveRootId, parentSessionId: cycle2Id });
	add("reachable-cycle-1", { delegateOf: cycle0Id });
	add("reachable-cycle-2", { delegateOf: cycle1Id, teamLeadSessionId: cycle0Id });

	// Equally wide unreachable data guards against leaking or cloning unrelated
	// archive rows into archivedDelegates.
	let unreachableParent = `session-load-${suffix}-unreachable-root`;
	for (let i = 0; i < 32; i++) {
		const row = add(`unreachable-${i}`, { [RELATION_FIELDS[i % RELATION_FIELDS.length]]: unreachableParent });
		unreachableParent = row.id;
	}

	return rows;
}

function naiveReachableIds(seedIds: string[], rows: ArchivedRow[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	for (let head = 0; head < queue.length; head++) {
		const parentId = queue[head];
		for (const row of rows) {
			if (seen.has(row.id)) continue;
			if (!RELATION_FIELDS.some((field) => row[field] === parentId)) continue;
			seen.add(row.id);
			result.push(row.id);
			queue.push(row.id);
		}
	}
	return result;
}

async function sessions(path: string): Promise<SessionsEnvelope> {
	const response = await apiFetch(path);
	const text = await response.text();
	expect(response.status, `${path}: ${text}`).toBe(200);
	return JSON.parse(text) as SessionsEnvelope;
}

function archivedPageIds(body: SessionsEnvelope): string[] {
	return body.sessions.filter((row) => row.archived === true).map((row) => row.id);
}

function snapshotMessages(data: unknown): any[] {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)) {
		return (data as { messages: any[] }).messages;
	}
	throw new Error(`unexpected messages snapshot: ${JSON.stringify(data)}`);
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

async function requestSnapshot(conn: WsConnection): Promise<any[]> {
	const cursor = conn.messageCount();
	conn.send({ type: "get_messages" });
	const frame = await conn.waitForFrom(cursor, (message) => message.type === "messages", 15_000);
	return snapshotMessages(frame.data);
}

async function requestState(conn: WsConnection): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "get_state" });
	await conn.waitForFrom(cursor, (message) => message.type === "state", 15_000);
}

async function promptAndWait(conn: WsConnection, text: string): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text });
	await conn.waitForFrom(cursor, agentEndPredicate(), 15_000);
	await conn.waitForFrom(
		cursor,
		(message) => message.type === "session_status" && message.status === "idle",
		15_000,
	);
}

async function primeRestorableSession(sessionId: string, marker: string): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		await promptAndWait(conn, marker);
		// The mock agent persists its production-shaped JSONL on get_state, just as
		// the real CLI does. This makes the subsequent boot exercise switch_session.
		await requestState(conn);
	} finally {
		conn.close();
	}
}

async function createTask(goalId: string, title: string): Promise<{ id: string }> {
	const response = await apiFetch(`/api/goals/${goalId}/tasks`, {
		method: "POST",
		body: JSON.stringify({ title, type: "testing", spec: `${title} session-loading E2E assignment.` }),
	});
	const text = await response.text();
	expect(response.status, `create task ${title}: ${text}`).toBe(201);
	return JSON.parse(text) as { id: string };
}

async function assignTask(taskId: string, sessionId: string): Promise<void> {
	const response = await apiFetch(`/api/tasks/${taskId}/assign`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
	const text = await response.text();
	expect(response.status, `assign ${taskId} to ${sessionId}: ${text}`).toBe(200);
}

async function hydratedTaskId(sessionId: string): Promise<string | undefined> {
	const conn = await connectWs(sessionId);
	try {
		const frame = await conn.waitFor(
			(message) => message.type === "cost_update" && message.sessionId === sessionId,
			15_000,
		);
		return frame.taskId as string | undefined;
	} finally {
		conn.close();
	}
}

async function sessionCost(sessionId: string): Promise<{
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
}> {
	const response = await apiFetch(`/api/sessions/${sessionId}/cost`);
	const text = await response.text();
	expect(response.status, `cost for ${sessionId}: ${text}`).toBe(200);
	return JSON.parse(text);
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.restart();
	await waitForHealth(10_000);
}

test.describe.serial("session loading performance contracts", () => {
	test.setTimeout(60_000);

	test("preserves archived pagination, snapshots, eager restore, cost tail, and task attribution", async ({ gateway }) => {
		const suffix = uniqueSuffix();
		const rootPath = join(tmpdir(), `bobbit-session-loading-${suffix}`);
		mkdirSync(rootPath, { recursive: true });
		let projectId: string | undefined;
		let serverOnline = true;
		const openConnections: WsConnection[] = [];

		try {
			const project = await registerProject({
				name: `session-loading-${suffix}`,
				rootPath,
			});
			projectId = project.id;
			const goal = await createGoal({
				title: `Session loading ${suffix}`,
				spec: "API-only E2E fixture for behavior-preserving session loading performance contracts.",
				projectId,
				cwd: rootPath,
				team: false,
				worktree: false,
			});

			const snapshotSessionId = await createSession({ cwd: rootPath, goalId: goal.id, projectId });
			const otherSessionId = await createSession({ cwd: rootPath, goalId: goal.id, projectId });
			const delegateResponse = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: rootPath,
					projectId,
					delegateOf: otherSessionId,
					instructions: "Persist and eagerly restore this delegate survivor.",
				}),
			});
			const delegateText = await delegateResponse.text();
			expect(delegateResponse.status, delegateText).toBe(201);
			const delegateSessionId = (JSON.parse(delegateText) as { id: string }).id;

			await Promise.all([
				waitForSessionStatus(snapshotSessionId, "idle"),
				waitForSessionStatus(otherSessionId, "idle"),
				waitForSessionStatus(delegateSessionId, "idle"),
			]);
			await primeRestorableSession(otherSessionId, `SECOND_SESSION_${suffix}`);
			await primeRestorableSession(delegateSessionId, `DELEGATE_SURVIVOR_${suffix}`);

			const wsA = await connectWs(snapshotSessionId);
			const wsB = await connectWs(snapshotSessionId);
			openConnections.push(wsA, wsB);

			const firstMarker = `SNAPSHOT_FIRST_${suffix}`;
			await promptAndWait(wsA, firstMarker);
			const aCursor = wsA.messageCount();
			const bCursor = wsB.messageCount();
			wsA.send({ type: "get_messages" });
			wsB.send({ type: "get_messages" });
			const [firstAFrame, firstBFrame] = await Promise.all([
				wsA.waitForFrom(aCursor, (message) => message.type === "messages", 15_000),
				wsB.waitForFrom(bCursor, (message) => message.type === "messages", 15_000),
			]);
			const firstA = snapshotMessages(firstAFrame.data);
			const firstB = snapshotMessages(firstBFrame.data);
			expect(JSON.stringify(firstA), "concurrent same-sequence snapshots must be byte-identical").toBe(JSON.stringify(firstB));
			expect(firstA).toHaveLength(2);
			expect(messageText(firstA[0])).toContain(firstMarker);

			const secondMarker = `SNAPSHOT_INVALIDATION_${suffix}`;
			await promptAndWait(wsA, secondMarker);
			const afterMutation = await requestSnapshot(wsA);
			expect(afterMutation).toHaveLength(4);
			expect(afterMutation.map(messageText)).toContain(secondMarker);
			expect(JSON.stringify(afterMutation)).not.toBe(JSON.stringify(firstA));

			// Prime task lookup hydration, mutate assignment, then prove a fresh
			// reconnect cannot receive the cached/stale task id.
			const taskA = await createTask(goal.id, `Session loading task A ${suffix}`);
			const taskB = await createTask(goal.id, `Session loading task B ${suffix}`);
			await assignTask(taskA.id, snapshotSessionId);
			expect(await hydratedTaskId(snapshotSessionId)).toBe(taskA.id);
			await assignTask(taskA.id, otherSessionId);
			await assignTask(taskB.id, snapshotSessionId);
			expect(await hydratedTaskId(snapshotSessionId)).toBe(taskB.id);

			const store = sessionStoreForProject(gateway, projectId);
			const archivedRows = makeArchivedRows(projectId, rootPath, snapshotSessionId, suffix);
			for (const row of archivedRows) store.put(row);
			const archivedIds = new Set(archivedRows.map((row) => row.id));
			const sortedArchivedIds = [...archivedRows]
				.sort((a, b) => b.archivedAt - a.archivedAt)
				.map((row) => row.id);

			const projectQuery = `projectId=${encodeURIComponent(projectId)}`;
			const defaultBody = await sessions(`/api/sessions?${projectQuery}`);
			const liveIds = defaultBody.sessions.map((row) => row.id);
			expect(liveIds).toEqual([snapshotSessionId, otherSessionId, delegateSessionId]);
			const expectedReachable = naiveReachableIds([...liveIds, goal.id], archivedRows);
			const actualReachable = defaultBody.archivedDelegates
				.map((row) => row.id)
				.filter((id) => archivedIds.has(id));
			expect(actualReachable).toEqual(expectedReachable);
			expect(actualReachable).toHaveLength(new Set(actualReachable).size);
			expect(actualReachable.length).toBeLessThan(archivedRows.length);

			const offsetBody = await sessions(`/api/sessions?include=archived&limit=5&offset=3&${projectQuery}`);
			expect(archivedPageIds(offsetBody)).toEqual(sortedArchivedIds.slice(3, 8));
			expect(offsetBody).toMatchObject({
				total: archivedRows.length,
				limit: 5,
				offset: 3,
				hasMore: true,
				nextOffset: 8,
			});
			expect(offsetBody.nextCursor).toBe(archivedRows[7].archivedAt);

			const cursorFirst = await sessions(`/api/sessions?include=archived&limit=7&${projectQuery}`);
			expect(archivedPageIds(cursorFirst)).toEqual(sortedArchivedIds.slice(0, 7));
			expect(cursorFirst.nextCursor).toBe(archivedRows[6].archivedAt);
			const cursorSecond = await sessions(
				`/api/sessions?include=archived&limit=7&cursor=${cursorFirst.nextCursor}&${projectQuery}`,
			);
			expect(archivedPageIds(cursorSecond)).toEqual(sortedArchivedIds.slice(7, 14));
			expect("offset" in cursorSecond).toBe(false);
			expect("nextOffset" in cursorSecond).toBe(false);

			// Record one last usage-bearing turn and begin graceful shutdown
			// immediately. With debounced persistence this tail is still pending when
			// shutdown starts and must be flushed before the second boot loads costs.
			const beforeTailCost = await sessionCost(snapshotSessionId);
			const tailMarker = `GRACEFUL_COST_TAIL_${suffix}`;
			await promptAndWait(wsA, tailMarker);
			await requestState(wsA);
			wsA.close();
			wsB.close();
			openConnections.length = 0;

			serverOnline = false;
			await gateway.crash();
			await restartGateway(gateway);
			serverOnline = true;

			// This is the first post-boot request: every regular session and the
			// delegate survivor must already be live/idle, without attach or prompt.
			const restoredDefault = await sessions(`/api/sessions?${projectQuery}`);
			expect(new Set(restoredDefault.sessions.map((row) => row.id))).toEqual(new Set([
				snapshotSessionId,
				otherSessionId,
				delegateSessionId,
			]));
			expect(restoredDefault.sessions).toHaveLength(3);
			for (const row of restoredDefault.sessions) {
				// The delegate owner may immediately receive the existing boot-time
				// collection reminder and become streaming. Both states prove a live
				// process; preparing/starting would mean restoration was deferred.
				const allowed = row.id === otherSessionId ? ["idle", "streaming"] : ["idle"];
				expect(allowed, `${row.id} eagerly restored`).toContain(row.status);
			}

			const restoredReachable = restoredDefault.archivedDelegates
				.map((row) => row.id)
				.filter((id) => archivedIds.has(id));
			expect(restoredReachable).toEqual(expectedReachable);
			const restoredOffset = await sessions(`/api/sessions?include=archived&limit=5&offset=3&${projectQuery}`);
			expect(archivedPageIds(restoredOffset)).toEqual(sortedArchivedIds.slice(3, 8));
			expect(restoredOffset).toMatchObject({ total: archivedRows.length, limit: 5, offset: 3, hasMore: true, nextOffset: 8 });

			const afterRestartWs = await connectWs(snapshotSessionId);
			openConnections.push(afterRestartWs);
			const restoredSnapshot = await requestSnapshot(afterRestartWs);
			expect(restoredSnapshot).toHaveLength(afterMutation.length + 2);
			expect(restoredSnapshot.slice(0, afterMutation.length)).toEqual(afterMutation);
			expect(messageText(restoredSnapshot[restoredSnapshot.length - 2])).toContain(tailMarker);
			expect(messageText(restoredSnapshot[restoredSnapshot.length - 1])).toBe("OK");

			const restoredCost = await sessionCost(snapshotSessionId);
			expect(restoredCost.inputTokens).toBe(beforeTailCost.inputTokens + 150);
			expect(restoredCost.outputTokens).toBe(beforeTailCost.outputTokens + 25);
			expect(restoredCost.totalCost).toBeCloseTo(beforeTailCost.totalCost + 0.00075, 6);
			expect(await hydratedTaskId(snapshotSessionId)).toBe(taskB.id);
		} finally {
			for (const conn of openConnections) conn.close();
			if (!serverOnline) {
				await restartGateway(gateway).catch(() => {});
			}
			if (projectId) {
				await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			}
			await awaitableRm(rootPath, {
				onFinalFailure: (error) => console.warn(`[session-loading-e2e] cleanup deferred: ${String(error)}`),
			});
		}
	});
});
