import { randomUUID } from "node:crypto";

import { test, expect } from "../../../../tests2/integration/_e2e/in-process-harness.js";

export const FAILURE_MARKER = "STAFF_FORK_IDENTITY_ISOLATION";

export function jsonBody(method: string, body: Record<string, unknown>): RequestInit {
	return { method, body: JSON.stringify(body) };
}

export async function createStaff(gateway: any, overrides: Record<string, unknown> = {}): Promise<any> {
	const project = gateway.projectContextManager.getRegistry().get(gateway.defaultProjectId);
	const response = await gateway.api("/api/staff", jsonBody("POST", {
		name: `Staff fork ${randomUUID()}`,
		description: "source description",
		systemPrompt: "Remain independent when forked.",
		projectId: project.id,
		cwd: project.rootPath,
		worktree: false,
		...overrides,
	}));
	expect(response.status, await response.clone().text()).toBe(201);
	return response.json();
}

export async function forkSession(
	gateway: any,
	sessionId: string,
	body: Record<string, unknown>,
): Promise<{ response: Response; value: any }> {
	const response = await gateway.api(`/api/sessions/${sessionId}/fork`, jsonBody("POST", body));
	return {
		response,
		value: await response.clone().json().catch(async () => ({ error: await response.clone().text() })),
	};
}

export async function listStaff(gateway: any, projectId?: string): Promise<any[]> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return (await gateway.apiJson(`/api/staff${suffix}`)).staff;
}

export async function inbox(gateway: any, staffId: string): Promise<any[]> {
	return (await gateway.apiJson(`/api/staff/${staffId}/inbox`)).entries;
}

export async function deleteStaff(gateway: any, staffId: string): Promise<Response> {
	return gateway.api(`/api/staff/${staffId}`, { method: "DELETE" });
}

export function sourceSnapshot(staff: any): Record<string, unknown> {
	return {
		id: staff.id,
		name: staff.name,
		description: staff.description,
		systemPrompt: staff.systemPrompt,
		cwd: staff.cwd,
		state: staff.state,
		triggers: staff.triggers,
		memory: staff.memory,
		roleId: staff.roleId,
		accessory: staff.accessory,
		currentSessionId: staff.currentSessionId,
		projectId: staff.projectId,
		sandboxed: staff.sandboxed,
		contextPolicy: staff.contextPolicy,
	};
}

/** Preserve the shared gateway's live staff and archived-session baselines after every test. */
export function installStaffForkCleanup(): void {
	let baselineStaffIds = new Set<string>();
	let baselineArchivedSessionIds = new Set<string>();

	test.beforeEach(async ({ gateway }) => {
		baselineStaffIds = new Set((await listStaff(gateway)).map((staff: any) => staff.id));
		baselineArchivedSessionIds = new Set(
			gateway.sessionManager.listArchivedSessions().map((session: any) => session.id as string),
		);
	});

	test.afterEach(async ({ gateway }) => {
		const extras = (await listStaff(gateway)).filter((staff: any) => !baselineStaffIds.has(staff.id));
		// Borrowers/forks must be released before their source owners.
		extras.sort((a: any, b: any) => Number(b.name?.startsWith("Fork: ")) - Number(a.name?.startsWith("Fork: ")));
		for (const staff of extras) await deleteStaff(gateway, staff.id).catch(() => undefined);

		const archivedExtras = gateway.sessionManager.listArchivedSessions()
			.map((session: any) => session.id as string)
			.filter((id: string) => !baselineArchivedSessionIds.has(id));
		for (const id of archivedExtras) {
			await gateway.sessionManager.purgeArchivedSession(id);
		}
		expect(new Set(
			gateway.sessionManager.listArchivedSessions().map((session: any) => session.id as string),
		)).toEqual(baselineArchivedSessionIds);
	});
}
