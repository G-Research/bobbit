import { randomUUID } from "node:crypto";
import { expect, test } from "./_e2e/in-process-harness.js";
import { apiFetch, harnessDefaultProjectRoot } from "./_e2e/e2e-setup.js";

function archivedIds(body: any, prefix: string): string[] {
	return (body.archivedDelegates as any[])
		.map(session => session.id as string)
		.filter(id => id.startsWith(prefix));
}

function returnedArchivedIds(body: any, prefix: string): string[] {
	return (body.sessions as any[])
		.filter(session => session.status === "archived")
		.map(session => session.id as string)
		.filter(id => id.startsWith(prefix));
}

test.describe("archived session BFS route contracts", () => {
	test("preserves default and include-archived ordering, filters, offset, and cursor envelopes", async ({ gateway }) => {
		const prefix = `bfs-route-${randomUUID()}-`;
		const projectId = gateway.defaultProjectId as string;
		const sessionManager = gateway.sessionManager as any;
		const store = sessionManager.getSessionStore(projectId);
		const cwd = harnessDefaultProjectRoot();
		const now = Date.now();
		const liveId = `${prefix}live`;
		const directId = `${prefix}direct`;
		const grandchildId = `${prefix}grandchild`;
		const unreachableId = `${prefix}unreachable`;
		const otherProjectId = `${prefix}other-project`;
		const marker = prefix.toLowerCase();
		const ownedIds = [liveId, directId, grandchildId, unreachableId, otherProjectId];

		sessionManager.sessions.set(liveId, {
			id: liveId,
			title: `${marker} live`,
			cwd,
			projectId,
			status: "idle",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			isCompacting: false,
		});
		store.put({
			id: liveId,
			title: `${marker} live`,
			cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: now,
			projectId,
		});

		const putArchived = (id: string, archivedAt: number, extra: Record<string, unknown> = {}) => store.put({
			id,
			title: `${marker} ${id}`,
			cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: archivedAt,
			projectId,
			archived: true,
			archivedAt,
			...extra,
		});
		putArchived(directId, now + 300, { delegateOf: liveId, parentSessionId: liveId });
		putArchived(grandchildId, now + 200, { teamLeadSessionId: directId });
		putArchived(unreachableId, now + 100, { goalId: `${prefix}missing-goal` });
		putArchived(otherProjectId, now + 400, { projectId: `${prefix}unregistered-project` });

		try {
			const defaultResponse = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}&limit=200`);
			expect(defaultResponse.status).toBe(200);
			const defaultBody = await defaultResponse.json();
			expect(defaultBody).toMatchObject({
				generation: expect.any(Number),
				limit: 200,
				offset: 0,
				hasMore: false,
			});
			expect((defaultBody.sessions as any[]).some(session => session.id === liveId)).toBe(true);
			expect(archivedIds(defaultBody, prefix)).toEqual([directId, grandchildId]);
			expect((defaultBody.archivedDelegates as any[]).filter(session => session.id === directId)).toHaveLength(1);

			const offsetResponse = await apiFetch(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(marker)}&limit=1&offset=1`,
			);
			expect(offsetResponse.status).toBe(200);
			const offsetBody = await offsetResponse.json();
			expect(offsetBody).toMatchObject({
				generation: expect.any(Number),
				total: 3,
				limit: 1,
				offset: 1,
				hasMore: true,
				nextOffset: 2,
				nextCursor: now + 200,
			});
			expect(returnedArchivedIds(offsetBody, prefix)).toEqual([grandchildId]);
			expect(archivedIds(offsetBody, prefix)).toEqual([directId, grandchildId]);

			const cursorResponse = await apiFetch(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(marker)}&limit=1&cursor=${offsetBody.nextCursor}`,
			);
			expect(cursorResponse.status).toBe(200);
			const cursorBody = await cursorResponse.json();
			expect(cursorBody).toMatchObject({
				total: 3,
				limit: 1,
				hasMore: false,
				nextCursor: now + 100,
			});
			expect(cursorBody).not.toHaveProperty("offset");
			expect(cursorBody).not.toHaveProperty("nextOffset");
			expect(returnedArchivedIds(cursorBody, prefix)).toEqual([unreachableId]);
		} finally {
			sessionManager.sessions.delete(liveId);
			for (const id of ownedIds) store.remove(id);
		}
	});
});
