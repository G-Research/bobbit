import { expect, test, type GatewayInfo } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	defaultProject,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";

type TaggedSession = {
	id: string;
	projectId?: string;
	archived?: boolean;
	user_tags?: unknown;
	server_tags?: unknown;
};

type SessionList = {
	sessions?: TaggedSession[];
	archivedDelegates?: TaggedSession[];
};

function allRows(list: SessionList): TaggedSession[] {
	return [...(list.sessions ?? []), ...(list.archivedDelegates ?? [])];
}

async function authenticatedList(path: string): Promise<SessionList> {
	const response = await apiFetch(path);
	const text = await response.text();
	expect(response.status, `authenticated GET ${path}: ${text}`).toBe(200);
	return JSON.parse(text) as SessionList;
}

function rowById(list: SessionList, sessionId: string): TaggedSession {
	const rows = allRows(list).filter((row) => row.id === sessionId);
	expect(rows, `authenticated list should contain ${sessionId} exactly once`).toHaveLength(1);
	return rows[0]!;
}

function expectTagProjection(
	row: TaggedSession,
	expected: { archived: boolean; pinned: boolean; projectId: string },
): void {
	expect(row.archived === true).toBe(expected.archived);
	expect(row.projectId).toBe(expected.projectId);
	expect(Array.isArray(row.user_tags), "user_tags is serialized on every list row").toBe(true);
	expect(Array.isArray(row.server_tags), "server_tags is serialized on every list row").toBe(true);

	const userTags = row.user_tags as string[];
	const serverTags = row.server_tags as string[];
	expect(userTags.filter((tag) => tag.startsWith("pinned="))).toEqual(
		expected.pinned ? ["pinned=true"] : [],
	);
	expect(serverTags.filter((tag) => tag.startsWith("archive-state="))).toEqual([
		`archive-state=${expected.archived ? "archived" : "live"}`,
	]);
	expect(serverTags).toContain(`project-id=${expected.projectId}`);
}

async function putPin(sessionId: string, pinned: boolean): Promise<string[]> {
	const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
		method: "PUT",
		body: JSON.stringify({ pinned }),
	});
	const text = await response.text();
	expect(response.status, `PUT pin=${pinned}: ${text}`).toBe(200);
	const body = JSON.parse(text) as { user_tags?: unknown };
	expect(Array.isArray(body.user_tags)).toBe(true);
	return body.user_tags as string[];
}

async function restartGateway(gateway: GatewayInfo, markOnline: (online: boolean) => void): Promise<void> {
	await gateway.crash();
	markOnline(false);
	await gateway.restart();
	markOnline(true);
	await waitForHealth(20_000);
}

test.describe.serial("session pin archive restart persistence", () => {
	test("pin and archived unpin survive separate production gateway restarts", async ({ gateway }) => {
		test.setTimeout(120_000);
		const project = await defaultProject();
		const sessionId = await createSession({ projectId: project.id });
		let serverOnline = true;

		try {
			await waitForSessionStatus(sessionId, "idle", 20_000);

			const unauthenticated = await fetch(
				`${gateway.baseURL}/api/sessions?projectId=${encodeURIComponent(project.id)}`,
			);
			expect(unauthenticated.status, "production session list requires gateway authentication").toBe(401);

			expect(await putPin(sessionId, true)).toEqual(["pinned=true"]);
			const liveList = await authenticatedList(
				`/api/sessions?projectId=${encodeURIComponent(project.id)}`,
			);
			expectTagProjection(rowById(liveList, sessionId), {
				archived: false,
				pinned: true,
				projectId: project.id,
			});

			const archive = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
				method: "DELETE",
			});
			expect(archive.status, await archive.clone().text()).toBe(200);

			const liveAfterArchive = await authenticatedList(
				`/api/sessions?projectId=${encodeURIComponent(project.id)}`,
			);
			expect(allRows(liveAfterArchive).some((row) => row.id === sessionId)).toBe(false);
			const archivedBeforeRestart = await authenticatedList(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(project.id)}`,
			);
			expectTagProjection(rowById(archivedBeforeRestart, sessionId), {
				archived: true,
				pinned: true,
				projectId: project.id,
			});

			await restartGateway(gateway, (online) => { serverOnline = online; });
			const pinnedAfterRestart = await authenticatedList(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(project.id)}`,
			);
			expectTagProjection(rowById(pinnedAfterRestart, sessionId), {
				archived: true,
				pinned: true,
				projectId: project.id,
			});

			expect(await putPin(sessionId, false)).toEqual([]);
			const unpinnedBeforeRestart = await authenticatedList(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(project.id)}`,
			);
			expectTagProjection(rowById(unpinnedBeforeRestart, sessionId), {
				archived: true,
				pinned: false,
				projectId: project.id,
			});

			await restartGateway(gateway, (online) => { serverOnline = online; });
			const unpinnedAfterRestart = await authenticatedList(
				`/api/sessions?include=archived&projectId=${encodeURIComponent(project.id)}`,
			);
			expectTagProjection(rowById(unpinnedAfterRestart, sessionId), {
				archived: true,
				pinned: false,
				projectId: project.id,
			});
		} finally {
			if (!serverOnline) {
				await gateway.restart().then(() => waitForHealth(20_000)).catch(() => undefined);
			}
			await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}?purge=true`, {
				method: "DELETE",
			}).catch(() => undefined);
		}
	});
});
