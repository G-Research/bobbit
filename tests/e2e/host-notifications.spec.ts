import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, test, type GatewayInfo } from "./gateway-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	createGoal,
	createSession,
	projectStateDirForRoot,
	readE2ETokenAsync,
	registerProject,
	waitForHealth,
	waitForSessionStatus,
	type WsMsg,
} from "./e2e-setup.js";
import { awaitableRm, pollUntil } from "./test-utils/cleanup.js";

type SocketHarness = {
	messages: WsMsg[];
	messageCount(): number;
	send(message: Record<string, unknown>): void;
	waitForFrom(index: number, predicate: (message: WsMsg) => boolean, timeoutMs?: number): Promise<WsMsg>;
	close(): void;
};

type DeliveryRow = {
	deliveryId: string;
	state: "pending" | "leased" | "accepted" | "cancelled" | "failed";
	attempt: number;
	leaseId?: string;
	leaseUntil?: number;
	updatedAt: number;
	notification: Record<string, any>;
};

type InboxFile = {
	staffId: string;
	entries: Array<{
		id: string;
		source: { type: string; triggerId?: string };
		notificationInput?: { notification: Record<string, any> };
	}>;
};

function notificationFor(message: WsMsg, name: string, aggregateId?: string): boolean {
	return message.type === "host_notification"
		&& message.notification?.name === name
		&& (aggregateId === undefined || message.notification?.aggregate?.id === aggregateId);
}

async function connectSocket(
	gateway: GatewayInfo,
	sessionId: string,
	clientKind: "app" | undefined,
): Promise<SocketHarness> {
	const token = await readE2ETokenAsync();
	const ws = new WebSocket(`${gateway.wsBase}/ws/${sessionId}`);
	const messages: WsMsg[] = [];
	const waiters: Array<{
		index: number;
		predicate: (message: WsMsg) => boolean;
		resolve: (message: WsMsg) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];

	ws.on("message", raw => {
		const message = JSON.parse(raw.toString()) as WsMsg;
		messages.push(message);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i]!;
			if (messages.length - 1 >= waiter.index && waiter.predicate(message)) {
				clearTimeout(waiter.timer);
				waiters.splice(i, 1);
				waiter.resolve(message);
			}
		}
	});

	const opened = new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	await opened;
	ws.send(JSON.stringify({ type: "auth", token, ...(clientKind ? { clientKind } : {}) }));

	const harness: SocketHarness = {
		messages,
		messageCount: () => messages.length,
		send: message => ws.send(JSON.stringify(message)),
		waitForFrom(index, predicate, timeoutMs = 15_000) {
			const existing = messages.slice(index).find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const waiterIndex = waiters.findIndex(waiter => waiter.timer === timer);
					if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
					reject(new Error(`host notification WS wait timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				waiters.push({ index, predicate, resolve, reject, timer });
			});
		},
		close: () => ws.close(),
	};

	await harness.waitForFrom(0, message => message.type === "auth_ok", 10_000);
	return harness;
}

async function assertSocketBarrierHasNoNotification(
	socket: SocketHarness,
	cursor: number,
	barrier: "state" | "pong",
	name: string,
	aggregateId: string,
): Promise<void> {
	socket.send(barrier === "state" ? { type: "get_state" } : { type: "ping" });
	await socket.waitForFrom(cursor, message => message.type === barrier);
	expect(
		socket.messages.slice(cursor).filter(message => notificationFor(message, name, aggregateId)),
		`${name} for ${aggregateId} must not cross this socket's authoritative binding`,
	).toHaveLength(0);
}

async function deleteProject(projectId: string | undefined): Promise<void> {
	if (!projectId) return;
	await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.crash();
	await gateway.restart();
	await waitForHealth(20_000);
}

test.describe.serial("canonical host notification E2E", () => {
	test("routes sessionForked only to app sockets bound to the exact project", async ({ gateway }) => {
		test.setTimeout(120_000);
		const root = mkdtempSync(join(tmpdir(), "bobbit-e2e-host-notification-routing-"));
		const projectARoot = join(root, "project-a");
		const projectBRoot = join(root, "project-b");
		mkdirSync(projectARoot, { recursive: true });
		mkdirSync(projectBRoot, { recursive: true });
		let projectAId: string | undefined;
		let projectBId: string | undefined;
		let sourceId: string | undefined;
		let peerId: string | undefined;
		let foreignId: string | undefined;
		let forkId: string | undefined;
		const sockets: SocketHarness[] = [];

		try {
			const projectA = await registerProject({ name: `host-notification-a-${Date.now()}`, rootPath: projectARoot });
			const projectB = await registerProject({ name: `host-notification-b-${Date.now()}`, rootPath: projectBRoot });
			projectAId = projectA.id;
			projectBId = projectB.id;
			sourceId = await createSession({ projectId: projectA.id, cwd: projectARoot });
			peerId = await createSession({ projectId: projectA.id, cwd: projectARoot });
			foreignId = await createSession({ projectId: projectB.id, cwd: projectBRoot });
			await Promise.all([
				waitForSessionStatus(sourceId, "idle", 20_000),
				waitForSessionStatus(peerId, "idle", 20_000),
				waitForSessionStatus(foreignId, "idle", 20_000),
			]);

			const sourceApp = await connectSocket(gateway, sourceId, "app");
			const projectPeerApp = await connectSocket(gateway, peerId, "app");
			const foreignApp = await connectSocket(gateway, foreignId, "app");
			const unboundSource = await connectSocket(gateway, sourceId, undefined);
			const viewer = await connectSocket(gateway, "__viewer__", "app");
			sockets.push(sourceApp, projectPeerApp, foreignApp, unboundSource, viewer);

			// Give the fork route a real persisted transcript, then begin every
			// routing assertion after that unrelated turn has completed.
			const turnCursor = sourceApp.messageCount();
			sourceApp.send({ type: "prompt", text: "HOST_NOTIFICATION_FORK_SOURCE" });
			await sourceApp.waitForFrom(turnCursor, agentEndPredicate(), 20_000);

			const sourceCursor = sourceApp.messageCount();
			const peerCursor = projectPeerApp.messageCount();
			const foreignCursor = foreignApp.messageCount();
			const unboundCursor = unboundSource.messageCount();
			const viewerCursor = viewer.messageCount();
			const forkResponse = await apiFetch(`/api/sessions/${encodeURIComponent(sourceId)}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			const forkText = await forkResponse.text();
			expect(forkResponse.status, `fork should succeed: ${forkText}`).toBe(201);
			const fork = JSON.parse(forkText) as { id: string; projectId: string };
			forkId = fork.id;

			const [sourceFrame, peerFrame] = await Promise.all([
				sourceApp.waitForFrom(sourceCursor, message => notificationFor(message, "sessionForked", fork.id)),
				projectPeerApp.waitForFrom(peerCursor, message => notificationFor(message, "sessionForked", fork.id)),
			]);
			for (const frame of [sourceFrame, peerFrame]) {
				expect(frame.notification).toMatchObject({
					scope: "project",
					name: "sessionForked",
					payloadVersion: 1,
					projectId: projectA.id,
					aggregate: { kind: "session", id: fork.id },
					payload: { sourceSessionId: sourceId, sessionId: fork.id, forkMode: "whole" },
				});
				expect(frame.notification.aggregate.revision).toBeDefined();
			}

			// Receipt proves the publication boundary is after durable destination
			// creation: the authoritative REST owner must already expose the fork.
			const persistedResponse = await apiFetch(`/api/sessions/${encodeURIComponent(fork.id)}`);
			expect(persistedResponse.status, await persistedResponse.clone().text()).toBe(200);
			expect(await persistedResponse.json()).toMatchObject({ id: fork.id, projectId: projectA.id });

			// Per-connection barriers make the negative assertions event-driven. Any
			// incorrectly queued notification precedes the subsequent state/pong frame.
			await Promise.all([
				assertSocketBarrierHasNoNotification(foreignApp, foreignCursor, "state", "sessionForked", fork.id),
				assertSocketBarrierHasNoNotification(unboundSource, unboundCursor, "state", "sessionForked", fork.id),
				assertSocketBarrierHasNoNotification(viewer, viewerCursor, "pong", "sessionForked", fork.id),
			]);
			expect(sourceApp.messages.slice(sourceCursor).filter(message => notificationFor(message, "sessionForked", fork.id))).toHaveLength(1);
			expect(projectPeerApp.messages.slice(peerCursor).filter(message => notificationFor(message, "sessionForked", fork.id))).toHaveLength(1);
		} finally {
			for (const socket of sockets) socket.close();
			for (const sessionId of [forkId, sourceId, peerId, foreignId]) {
				if (sessionId) await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
			}
			await deleteProject(projectBId);
			await deleteProject(projectAId);
			await awaitableRm(root, { maxAttempts: 5, backoffMs: 100 });
		}
	});

	test("reconciles the inbox-commit/outbox-ack crash window after a real restart without duplicates", async ({ gateway }) => {
		test.setTimeout(120_000);
		const root = mkdtempSync(join(tmpdir(), "bobbit-e2e-host-notification-staff-"));
		let projectId: string | undefined;
		let staffId: string | undefined;
		let staffSessionId: string | undefined;
		let goalId: string | undefined;
		let serverOnline = true;

		try {
			const project = await registerProject({ name: `host-notification-staff-${Date.now()}`, rootPath: root });
			projectId = project.id;
			const staffResponse = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `Host notification observer ${Date.now()}`,
					systemPrompt: "Observe canonical host notifications.",
					cwd: root,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
					triggers: [{
						id: "goal-created-notification",
						type: "notification",
						notification: { scope: "project", name: "goalCreated" },
						filter: { state: "todo" },
						enabled: true,
					}],
				}),
			});
			const staffText = await staffResponse.text();
			expect(staffResponse.status, `staff creation should succeed: ${staffText}`).toBe(201);
			const staff = JSON.parse(staffText) as { id: string; currentSessionId?: string };
			staffId = staff.id;
			staffSessionId = staff.currentSessionId;

			const goal = await createGoal({
				title: `Host notification durable intent ${Date.now()}`,
				spec: "Exercise durable notification staff delivery through the real gateway restart boundary.",
				cwd: root,
				projectId: project.id,
				worktree: false,
			});
			goalId = goal.id;

			const stateDir = projectStateDirForRoot(root);
			const deliveryFile = join(stateDir, "notification-deliveries.json");
			const inboxFile = join(stateDir, "inbox", `${staff.id}.json`);
			const accepted = await pollUntil(() => {
				const rows = JSON.parse(readFileSync(deliveryFile, "utf8")) as DeliveryRow[];
				const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as InboxFile;
				const row = rows.find(candidate => candidate.notification?.name === "goalCreated" && candidate.notification?.aggregate?.id === goal.id);
				const entries = row ? inbox.entries.filter(entry => entry.id === row.deliveryId) : [];
				return row?.state === "accepted" && entries.length === 1 ? { rows, row, inbox } : null;
			}, { timeoutMs: 20_000, label: "accepted goalCreated staff delivery" });

			const originalNotification = structuredClone(accepted.row.notification);
			expect(accepted.inbox.entries.find(entry => entry.id === accepted.row.deliveryId)?.notificationInput?.notification).toEqual(originalNotification);
			expect(accepted.row.deliveryId).toBe(createHash("sha256")
				.update(`${staff.id}|goal-created-notification|${originalNotification.id}`)
				.digest("hex"));

			// Model the exact durable crash checkpoint: InboxStore.putStrict has
			// committed the deterministic entry, but the outbox lease ACK did not.
			await gateway.crash();
			serverOnline = false;
			const crashRows = JSON.parse(readFileSync(deliveryFile, "utf8")) as DeliveryRow[];
			const crashRow = crashRows.find(row => row.deliveryId === accepted.row.deliveryId)!;
			crashRow.state = "leased";
			crashRow.attempt = Math.max(1, crashRow.attempt);
			crashRow.leaseId = "e2e-crash-after-inbox-commit";
			crashRow.leaseUntil = 0;
			crashRow.updatedAt = 0;
			writeFileSync(deliveryFile, JSON.stringify(crashRows, null, 2), "utf8");

			await gateway.restart();
			serverOnline = true;
			await waitForHealth(20_000);

			const reconciled = await pollUntil(() => {
				const rows = JSON.parse(readFileSync(deliveryFile, "utf8")) as DeliveryRow[];
				const row = rows.find(candidate => candidate.deliveryId === accepted.row.deliveryId);
				return row?.state === "accepted" ? row : null;
			}, { timeoutMs: 20_000, label: "restart reconciliation accepts expired staff lease" });
			const restartedInbox = JSON.parse(readFileSync(inboxFile, "utf8")) as InboxFile;
			const matchingEntries = restartedInbox.entries.filter(entry => entry.id === accepted.row.deliveryId);
			expect(matchingEntries, "idempotent inbox acceptance must retain exactly one entry").toHaveLength(1);
			expect(reconciled.notification, "restart must preserve the complete canonical notification").toEqual(originalNotification);
			expect(matchingEntries[0]?.notificationInput?.notification).toEqual(originalNotification);
		} finally {
			if (!serverOnline) {
				await restartGateway(gateway).then(() => { serverOnline = true; }).catch(() => undefined);
			}
			if (goalId) await apiFetch(`/api/goals/${encodeURIComponent(goalId)}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
			if (staffId) await apiFetch(`/api/staff/${encodeURIComponent(staffId)}`, { method: "DELETE" }).catch(() => undefined);
			if (staffSessionId) await apiFetch(`/api/sessions/${encodeURIComponent(staffSessionId)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
			await deleteProject(projectId);
			await awaitableRm(root, { maxAttempts: 5, backoffMs: 100 });
		}
	});
});
