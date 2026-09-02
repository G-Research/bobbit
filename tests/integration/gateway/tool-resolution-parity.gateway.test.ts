import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";

const TOOL_NAME = "session_prompt";
const ROLE_NAME = "team-lead";

type ToolRow = {
	name: string;
	group: string;
	grantPolicy?: string;
	origin?: string;
	overrides?: string;
	originPackId?: string | null;
	originPackName?: string | null;
};

type GuardPolicies = Record<string, { policy: "ask" | "never"; group: string }>;

async function jsonResponse(response: Response, label: string): Promise<any> {
	const text = await response.text();
	expect(response.status, `${label}: ${text}`).toBeGreaterThanOrEqual(200);
	expect(response.status, `${label}: ${text}`).toBeLessThan(300);
	return text ? JSON.parse(text) : undefined;
}

async function projectToolList(gateway: any, projectId: string): Promise<ToolRow[]> {
	const body = await jsonResponse(
		await gateway.api(`/api/tools?projectId=${encodeURIComponent(projectId)}`),
		"project tool list",
	);
	return body.tools;
}

async function projectToolDetail(gateway: any, projectId: string, name = TOOL_NAME): Promise<ToolRow> {
	return jsonResponse(
		await gateway.api(`/api/tools/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`),
		`project tool detail ${name}`,
	);
}

function parseGuardPolicies(source: string, variable: "askPolicies" | "neverPolicies"): GuardPolicies {
	const match = source.match(new RegExp(`const ${variable} = (\\{[^\\n]*\\});`));
	if (!match) throw new Error(`Generated tool guard did not declare ${variable}`);
	return JSON.parse(match[1]) as GuardPolicies;
}

function generatedGuardForSession(gateway: any, sessionId: string): {
	askPolicies: GuardPolicies;
	neverPolicies: GuardPolicies;
} {
	const live = gateway.sessionManager.getSession(sessionId);
	expect(live, `live session ${sessionId}`).toBeDefined();
	const args: string[] = live.rpcClient?.options?.args ?? [];
	const guardPaths = args.flatMap((arg, index) =>
		arg === "--extension" && typeof args[index + 1] === "string"
			&& args[index + 1].replaceAll("\\", "/").includes("/state/tool-guard/")
			? [args[index + 1]]
			: [],
	);
	expect(guardPaths, `actual spawn args for ${sessionId} must contain one generated tool guard`).toHaveLength(1);
	const source = readFileSync(guardPaths[0], "utf8");
	return {
		askPolicies: parseGuardPolicies(source, "askPolicies"),
		neverPolicies: parseGuardPolicies(source, "neverPolicies"),
	};
}

async function createTeamLeadSession(gateway: any, scope: any, projectId: string, cwd: string): Promise<any> {
	const session = await scope.createSession({
		projectId,
		cwd,
		roleId: ROLE_NAME,
		sandboxed: false,
		worktree: false,
	});
	await expect.poll(
		() => gateway.sessionManager.getSession(session.id)?.status,
		{ timeout: 10_000, interval: 25, message: `team-lead session ${session.id} becomes idle` },
	).toBe("idle");
	return gateway.sessionManager.getSession(session.id);
}

type ToolWinnerSnapshot = Pick<
	ToolRow,
	"name" | "group" | "grantPolicy" | "origin" | "overrides" | "originPackId" | "originPackName"
>;

function toolWinnerSnapshot(tool: ToolRow): ToolWinnerSnapshot {
	return {
		name: tool.name,
		group: tool.group,
		grantPolicy: tool.grantPolicy,
		origin: tool.origin,
		overrides: tool.overrides,
		originPackId: tool.originPackId,
		originPackName: tool.originPackName,
	};
}

async function expectAskCatalogueWinner(
	gateway: any,
	projectId: string,
	expected?: ToolWinnerSnapshot,
): Promise<ToolWinnerSnapshot> {
	const listTool = (await projectToolList(gateway, projectId))
		.find((tool) => tool.name.toLowerCase() === TOOL_NAME);
	expect(listTool, "session_prompt appears in the project tool list").toBeDefined();
	const detail = await projectToolDetail(gateway, projectId);
	const mixedCaseDetail = await projectToolDetail(gateway, projectId, "SESSION_PROMPT");
	const snapshot = toolWinnerSnapshot(listTool!);
	expect(snapshot.grantPolicy).toBe("ask");
	expect(toolWinnerSnapshot(detail)).toEqual(snapshot);
	expect(toolWinnerSnapshot(mixedCaseDetail)).toEqual(snapshot);
	if (expected) expect(snapshot).toEqual(expected);
	return snapshot;
}

async function expectNewSessionPolicy(
	gateway: any,
	scope: any,
	projectId: string,
	cwd: string,
	group: string,
	policy: "allow" | "ask" | "never",
): Promise<void> {
	const session = await createTeamLeadSession(gateway, scope, projectId, cwd);
	const allowedTools = session.allowedTools.map((name: string) => name.toLowerCase());
	if (policy === "never") expect(allowedTools).not.toContain(TOOL_NAME);
	else expect(allowedTools).toContain(TOOL_NAME);

	const guard = generatedGuardForSession(gateway, session.id);
	if (policy === "ask") {
		expect(guard.askPolicies[TOOL_NAME]).toEqual({ policy: "ask", group });
		expect(guard.neverPolicies[TOOL_NAME]).toBeUndefined();
	} else if (policy === "never") {
		expect(guard.askPolicies[TOOL_NAME]).toBeUndefined();
		expect(guard.neverPolicies[TOOL_NAME]).toEqual({ policy: "never", group });
	} else {
		expect(guard.askPolicies[TOOL_NAME]).toBeUndefined();
		expect(guard.neverPolicies[TOOL_NAME]).toBeUndefined();
	}
}

async function setProjectRolePolicy(
	gateway: any,
	projectId: string,
	inheritedPolicies: Record<string, string>,
	policy: "allow" | "never",
): Promise<void> {
	await jsonResponse(
		await gateway.api(`/api/roles/${ROLE_NAME}?projectId=${encodeURIComponent(projectId)}`, {
			method: "PUT",
			body: JSON.stringify({
				projectId,
				toolPolicies: { ...inheritedPolicies, [TOOL_NAME]: policy },
			}),
		}),
		`set project team-lead session_prompt policy to ${policy}`,
	);
}

test.describe.serial("tool catalogue and generated guard parity", () => {
	test("server and project YAML ask winners stay stable while role policy governs each new guard", async ({ gateway, scope }) => {
		const fixtureId = randomUUID();
		const projectRoot = path.join(gateway.bobbitDir, `tool-resolution-parity-${fixtureId}`);
		const serverAgentTools = path.join(gateway.bobbitDir, "config", "tools", "agent");
		const backupRoot = path.join(gateway.bobbitDir, `.tool-resolution-parity-backup-${fixtureId}`);
		const backupAgentTools = path.join(backupRoot, "agent");
		const hadServerAgentTools = existsSync(serverAgentTools);
		let projectId = "";

		mkdirSync(path.join(projectRoot, ".bobbit", "config", "tools"), { recursive: true });
		if (hadServerAgentTools) {
			mkdirSync(backupRoot, { recursive: true });
			cpSync(serverAgentTools, backupAgentTools, { recursive: true });
		}

		try {
			// Start from the shipped winner even if another fork-mate left a server
			// customization behind. The exact prior directory is restored in finally.
			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=server&projectId=headquarters`, { method: "DELETE" }),
				"clear server override fixture",
			);

			const project = await jsonResponse(
				await gateway.api("/api/projects", {
					method: "POST",
					body: JSON.stringify({
						name: `tool-resolution-parity-${fixtureId}`,
						rootPath: projectRoot,
						acceptCanonical: true,
					}),
				}),
				"register normal project",
			);
			projectId = project.id;
			scope.trackProject(projectId);

			// Warm list and detail at the builtin policy before mutating the live gateway.
			const builtinListTool = (await projectToolList(gateway, projectId)).find((tool) => tool.name === TOOL_NAME);
			const builtinDetail = await projectToolDetail(gateway, projectId);
			expect(builtinListTool).toMatchObject({ name: TOOL_NAME, grantPolicy: "never", origin: "builtin" });
			expect(toolWinnerSnapshot(builtinDetail)).toEqual(toolWinnerSnapshot(builtinListTool!));

			const role = await jsonResponse(
				await gateway.api(`/api/roles/${ROLE_NAME}?projectId=${encodeURIComponent(projectId)}`),
				"project team-lead role",
			);
			const inheritedRolePolicies = { ...(role.toolPolicies ?? {}) } as Record<string, string>;
			expect(inheritedRolePolicies[TOOL_NAME], "control: team-lead has no explicit session_prompt override").toBeUndefined();

			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}/customize?scope=server&projectId=headquarters`, { method: "POST" }),
				"customize Headquarters tool",
			);
			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}?projectId=headquarters`, {
					method: "PUT",
					body: JSON.stringify({ projectId: "headquarters", grantPolicy: "ask" }),
				}),
				"set Headquarters policy to ask",
			);

			const serverWinner = await expectAskCatalogueWinner(gateway, projectId);
			expect(serverWinner).toMatchObject({
				name: TOOL_NAME,
				origin: "server",
				overrides: "builtin",
				originPackId: null,
				originPackName: null,
			});
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, serverWinner.group, "ask");

			await jsonResponse(
				await gateway.api(`/api/roles/${ROLE_NAME}/customize?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "POST" }),
				"customize project team-lead role for server winner",
			);
			await setProjectRolePolicy(gateway, projectId, inheritedRolePolicies, "allow");
			await expectAskCatalogueWinner(gateway, projectId, serverWinner);
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, serverWinner.group, "allow");

			await setProjectRolePolicy(gateway, projectId, inheritedRolePolicies, "never");
			await expectAskCatalogueWinner(gateway, projectId, serverWinner);
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, serverWinner.group, "never");

			await jsonResponse(
				await gateway.api(`/api/roles/${ROLE_NAME}/override?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }),
				"revert project team-lead role after server winner",
			);
			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=server&projectId=headquarters`, { method: "DELETE" }),
				"revert Headquarters override",
			);

			// The server winner is now the shipped builtin again. Override only this
			// project and prove the same catalogue/role-policy split at project scope.
			const revertedListTool = (await projectToolList(gateway, projectId)).find((tool) => tool.name === TOOL_NAME);
			const revertedDetail = await projectToolDetail(gateway, projectId, "SESSION_PROMPT");
			expect(revertedListTool).toMatchObject({ name: TOOL_NAME, grantPolicy: "never", origin: "builtin" });
			expect(toolWinnerSnapshot(revertedDetail)).toEqual(toolWinnerSnapshot(revertedListTool!));
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, revertedListTool!.group, "never");

			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}/customize?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "POST" }),
				"customize project session_prompt tool",
			);
			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}?projectId=${encodeURIComponent(projectId)}`, {
					method: "PUT",
					body: JSON.stringify({ projectId, grantPolicy: "ask" }),
				}),
				"set project session_prompt policy to ask",
			);

			const projectWinner = await expectAskCatalogueWinner(gateway, projectId);
			expect(projectWinner).toMatchObject({
				name: TOOL_NAME,
				origin: "project",
				overrides: "builtin",
				originPackId: null,
				originPackName: null,
			});
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, projectWinner.group, "ask");

			await jsonResponse(
				await gateway.api(`/api/roles/${ROLE_NAME}/customize?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "POST" }),
				"customize project team-lead role for project winner",
			);
			await setProjectRolePolicy(gateway, projectId, inheritedRolePolicies, "allow");
			await expectAskCatalogueWinner(gateway, projectId, projectWinner);
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, projectWinner.group, "allow");

			await setProjectRolePolicy(gateway, projectId, inheritedRolePolicies, "never");
			await expectAskCatalogueWinner(gateway, projectId, projectWinner);
			await expectNewSessionPolicy(gateway, scope, projectId, projectRoot, projectWinner.group, "never");
		} finally {
			// Restore every mutable fixture independently so one cleanup failure cannot
			// prevent the remaining role/tool state from being put back.
			if (projectId) {
				await gateway.api(`/api/roles/${ROLE_NAME}/override?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
				await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=project&projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
			}
			await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=server&projectId=headquarters`, { method: "DELETE" }).catch(() => undefined);
			rmSync(serverAgentTools, { recursive: true, force: true });
			if (hadServerAgentTools && existsSync(backupAgentTools)) {
				cpSync(backupAgentTools, serverAgentTools, { recursive: true });
			}
			rmSync(backupRoot, { recursive: true, force: true });
			if (projectId) await gateway.api(`/api/tools?projectId=${encodeURIComponent(projectId)}`).catch(() => undefined);
			await gateway.api("/api/tools?projectId=headquarters").catch(() => undefined);
		}
	});
});
