import { readFileSync } from "node:fs";

import { expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";

export const GENERAL_ROLE = "general";
export const CUSTOM_ROLE = "default-role-project-fixture";
export const MODEL = "anthropic/claude-opus-4-8";
export const THINKING = "xhigh";
export const GENERAL_PROMPT_MARKER = "DEFAULT_GENERAL_ROLE_PROMPT_MARKER";
export const CUSTOM_PROMPT_MARKER = "EXPLICIT_PROJECT_ROLE_PROMPT_MARKER";
const AGENT_CONTEXT_PREFIX = "RESOLVED_AGENT_CONTEXT=";
const AVAILABLE_ROLE_CONTEXT = "RESOLVED_AVAILABLE_ROLE_CONTEXT";
const CONDITIONAL_CONTEXT = "SUBGOALS_ENABLED_ROLE_CONTEXT";

export interface CreatedSession {
	id: string;
	projectId?: string;
	role?: string;
	accessory?: string;
	assistantType?: string;
	worktreePath?: string;
}

export interface RoleFixture {
	name: string;
	label: string;
	promptTemplate: string;
	accessory: string;
	toolPolicies: Record<string, "ask" | "never">;
	model: string;
	thinkingLevel: string;
}

function rolePromptFixture(marker: string): string {
	return [
		marker,
		`${AGENT_CONTEXT_PREFIX}{{AGENT_ID}}`,
		AVAILABLE_ROLE_CONTEXT,
		"{{AVAILABLE_ROLES}}",
		`{if:subGoalsEnabled}${CONDITIONAL_CONTEXT}{endif:subGoalsEnabled}`,
	].join("\n");
}

export const generalOverride: RoleFixture = {
	name: GENERAL_ROLE,
	label: "General",
	promptTemplate: rolePromptFixture(GENERAL_PROMPT_MARKER),
	accessory: "flask",
	toolPolicies: { Shell: "never", "File System": "ask" },
	model: MODEL,
	thinkingLevel: THINKING,
};

export const customRole: RoleFixture = {
	name: CUSTOM_ROLE,
	label: "Project Role Fixture",
	promptTemplate: rolePromptFixture(CUSTOM_PROMPT_MARKER),
	accessory: "magnifier",
	toolPolicies: { Shell: "never", "File System": "ask" },
	model: MODEL,
	thinkingLevel: THINKING,
};

export async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

export async function putProjectRole(projectId: string, role: RoleFixture): Promise<void> {
	const response = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({ ...role, projectId }),
	});
	const body = await readJson(response);
	expect(response.status, `create project role ${role.name}; body=${JSON.stringify(body)}`).toBe(201);
	expect(body).toMatchObject({
		name: role.name,
		promptTemplate: role.promptTemplate,
		accessory: role.accessory,
		toolPolicies: role.toolPolicies,
		model: MODEL,
		thinkingLevel: THINKING,
	});
}

export async function removeProjectRole(projectId: string, name: string): Promise<void> {
	await apiFetch(`/api/roles/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`, {
		method: "DELETE",
	}).catch(() => undefined);
}

export async function createSession(body: Record<string, unknown>): Promise<CreatedSession> {
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const payload = await readJson(response);
	expect(response.status, `POST /api/sessions failed; body=${JSON.stringify(payload)}`).toBe(201);
	expect(payload.id, "POST /api/sessions must return a session id").toBeTruthy();
	return payload as CreatedSession;
}

export async function purgeSession(id: string | undefined): Promise<void> {
	if (!id) return;
	await apiFetch(`/api/sessions/${encodeURIComponent(id)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
}

export async function roleSurfaces(
	gateway: any,
	created: CreatedSession,
	projectId: string,
): Promise<Record<string, string | null>> {
	const detailResponse = await apiFetch(`/api/sessions/${encodeURIComponent(created.id)}`);
	const detail = await readJson(detailResponse);
	expect(detailResponse.status, `GET /api/sessions/${created.id}; body=${JSON.stringify(detail)}`).toBe(200);

	const listResponse = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
	const listBody = await readJson(listResponse);
	expect(listResponse.status, `GET /api/sessions list; body=${JSON.stringify(listBody)}`).toBe(200);
	const listed = (listBody.sessions ?? listBody).find((session: any) => session.id === created.id);
	expect(listed, `GET /api/sessions must include ${created.id}`).toBeTruthy();

	return {
		post: created.role ?? null,
		live: gateway.sessionManager.getSession(created.id)?.role ?? null,
		persisted: gateway.sessionManager.getPersistedSession(created.id)?.role ?? null,
		detail: detail.role ?? null,
		list: listed.role ?? null,
	};
}

export async function expectRoleEverywhere(
	gateway: any,
	created: CreatedSession,
	projectId: string,
	expectedRole: string,
	message: string,
): Promise<void> {
	const observed = await roleSurfaces(gateway, created, projectId);
	expect(observed, message).toEqual({
		post: expectedRole,
		live: expectedRole,
		persisted: expectedRole,
		detail: expectedRole,
		list: expectedRole,
	});
}

export function expectInitialRoleConfiguration(
	gateway: any,
	sessionId: string,
	expected: { role: string; promptMarker: string; accessory: string },
): void {
	const live = gateway.sessionManager.getSession(sessionId);
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const promptParts = gateway.sessionManager.getPromptParts(sessionId);

	expect(live, `live session ${sessionId}`).toBeTruthy();
	expect(live.role).toBe(expected.role);
	expect(live.accessory).toBe(expected.accessory);
	expect(persisted?.role).toBe(expected.role);
	expect(persisted?.accessory).toBe(expected.accessory);
	const initialPromptPath = (live.rpcClient as any)?.options?.systemPromptPath as string | undefined;
	expect(initialPromptPath, "initial spawn must receive an assembled system prompt file").toBeTruthy();
	const prompts = {
		assembled: readFileSync(initialPromptPath!, "utf8"),
		reconstructed: String(promptParts?.rolePrompt ?? ""),
	};
	for (const [surface, prompt] of Object.entries(prompts)) {
		expect(prompt, `${surface} role prompt must contain its project-resolved marker`).toContain(expected.promptMarker);
		expect(prompt, `${surface} role prompt must substitute AGENT_ID`).toContain(
			`${AGENT_CONTEXT_PREFIX}${expected.role}-${sessionId.slice(0, 8)}`,
		);
		expect(prompt, `${surface} role prompt must contain resolved available-role context`).toContain(AVAILABLE_ROLE_CONTEXT);
		expect(prompt, `${surface} role prompt must substitute AVAILABLE_ROLES with role context`).toContain("**general**");
		expect(prompt, `${surface} role prompt must not retain AGENT_ID`).not.toContain("{{AGENT_ID}}");
		expect(prompt, `${surface} role prompt must not retain AVAILABLE_ROLES`).not.toContain("{{AVAILABLE_ROLES}}");
		expect(prompt, `${surface} enabled subgoal conditional must retain its content`).toContain(CONDITIONAL_CONTEXT);
		expect(prompt, `${surface} role prompt must not retain conditional delimiters`).not.toMatch(/\{(?:if|endif):subGoalsEnabled\}/);
	}
	expect(live.spawnPinnedModel, "resolved role model must reach initial spawn").toBe(MODEL);
	expect(live.spawnPinnedThinkingLevel, "resolved role thinking level must reach initial spawn").toBe(THINKING);
	expect(live.allowedTools, "resolved role tool policies must produce an initial allowlist").toContain("read");
	expect(live.allowedTools).not.toContain("bash");
	expect(live.allowedTools).not.toContain("bash_bg");
}

export async function sessionIdsBySurface(gateway: any, projectId: string): Promise<Record<string, string[]>> {
	const listResponse = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
	const listBody = await readJson(listResponse);
	expect(listResponse.status, JSON.stringify(listBody)).toBe(200);
	return {
		live: gateway.sessionManager.listSessions()
			.filter((session: any) => session.projectId === projectId)
			.map((session: any) => session.id)
			.sort(),
		persisted: gateway.projectContextManager.getAllSessions()
			.filter((session: any) => session.projectId === projectId)
			.map((session: any) => session.id)
			.sort(),
		api: (listBody.sessions ?? listBody).map((session: any) => session.id).sort(),
	};
}

export async function expectProjectRoles(projectId: string, roleNames: string[]): Promise<void> {
	const rolesResponse = await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`);
	const rolesBody = await readJson(rolesResponse);
	expect(rolesResponse.status, JSON.stringify(rolesBody)).toBe(200);
	for (const roleName of roleNames) {
		const role = (rolesBody.roles ?? []).find((candidate: any) => candidate.name === roleName);
		expect(role, `${roleName} must resolve through the project role cascade`).toBeTruthy();
		expect(role.origin, `${roleName} must be project-resolved, not a server fallback`).toBe("project");
	}
}
