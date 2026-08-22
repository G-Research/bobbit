import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGateway, type EntityCounts, type GatewayFixture } from "../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createScope, type TestScope } from "../harness/scope.js";

interface CapturedSocket {
	readonly ws: WebSocket;
	readonly frames: any[];
	waitFor(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
}

let gw: GatewayFixture;
let scope: TestScope;
let baseline: EntityCounts;
const sockets: WebSocket[] = [];

beforeAll(async () => {
	gw = await getGateway();
	baseline = snapshotEntities(gw);
});
beforeEach(() => { scope = createScope(gw); });
afterEach(async () => {
	for (const ws of sockets.splice(0)) ws.close();
	await scope.cleanup();
});
afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

async function connect(sessionId: string, token: string): Promise<CapturedSocket> {
	const ws = new WebSocket(`${gw.wsBase}/ws/${sessionId}`);
	sockets.push(ws);
	const frames: any[] = [];
	ws.on("message", raw => {
		try { frames.push(JSON.parse(String(raw))); } catch { /* ignore non-JSON frames */ }
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const waitFor = (predicate: (frame: any) => boolean, timeoutMs = 3_000): Promise<any> => {
		const existing = frames.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`WebSocket frame timed out for ${sessionId}`));
			}, timeoutMs);
			const onMessage = (raw: unknown) => {
				let frame: any;
				try { frame = JSON.parse(String(raw)); } catch { return; }
				if (!predicate(frame)) return;
				cleanup();
				resolve(frame);
			};
			const cleanup = () => {
				clearTimeout(timer);
				ws.off("message", onMessage);
			};
			ws.on("message", onMessage);
		});
	};
	ws.send(JSON.stringify({ type: "auth", token, clientKind: "app" }));
	await waitFor(frame => frame.type === "auth_ok");
	return { ws, frames, waitFor };
}

describe("host notification WebSocket principal isolation", () => {
	it("does not bind a sandbox token that claims the app client kind", async () => {
		const session = await scope.createSession({});
		const sandboxStore = gw.sessionManager.sandboxTokenStore;
		const sandboxToken = sandboxStore.register(gw.defaultProjectId);
		sandboxStore.addSession(gw.defaultProjectId, session.id);
		try {
			const admin = await connect(session.id, gw.token);
			const sandbox = await connect(session.id, sandboxToken);
			const adminCursor = admin.frames.length;
			const sandboxCursor = sandbox.frames.length;
			const aggregateId = `goal-${randomUUID()}`;
			const context = gw.projectContextManager.getOrCreate(gw.defaultProjectId);
			expect(context).not.toBeNull();

			const notification = context!.publishHostNotification("goalUpdated", {
				aggregateId,
				aggregateRevision: 1,
				payload: { goalId: aggregateId, state: "in-progress", changedFields: ["title"] },
			});
			expect(notification).toBeDefined();
			await admin.waitFor(frame => frame.type === "host_notification" && frame.notification?.id === notification!.id);

			sandbox.ws.send(JSON.stringify({ type: "ping" }));
			await sandbox.waitFor(frame => frame.type === "pong");
			expect(admin.frames.slice(adminCursor)).toContainEqual(expect.objectContaining({
				type: "host_notification",
				notification: expect.objectContaining({ id: notification!.id, projectId: gw.defaultProjectId }),
			}));
			expect(sandbox.frames.slice(sandboxCursor).filter(frame =>
				frame.type === "host_notification" || frame.type === "host_notifications_refresh_required",
			)).toEqual([]);
		} finally {
			sandboxStore.removeSession(gw.defaultProjectId, session.id);
		}
	});
});
