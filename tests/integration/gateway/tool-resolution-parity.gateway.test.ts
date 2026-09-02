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

test.describe.serial("tool catalogue and generated guard parity", () => {
	test("Headquarters session_prompt ask override immediately governs a normal project's new team-lead guard", async ({ gateway, scope }) => {
		const fixtureId = randomUUID();
		const projectRoot = path.join(gateway.bobbitDir, `tool-resolution-parity-${fixtureId}`);
		const serverAgentTools = path.join(gateway.bobbitDir, "config", "tools", "agent");
		const backupRoot = path.join(gateway.bobbitDir, `.tool-resolution-parity-backup-${fixtureId}`);
		const backupAgentTools = path.join(backupRoot, "agent");
		const hadServerAgentTools = existsSync(serverAgentTools);

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
			scope.trackProject(project.id);

			// Warm both read surfaces at the builtin policy before mutating the same
			// live gateway. This makes the following ask assertions an invalidation test.
			const builtinListTool = (await projectToolList(gateway, project.id)).find((tool) => tool.name === TOOL_NAME);
			const builtinDetail = await projectToolDetail(gateway, project.id);
			expect(builtinListTool).toMatchObject({ name: TOOL_NAME, grantPolicy: "never", origin: "builtin" });
			expect(builtinDetail).toMatchObject({ name: TOOL_NAME, grantPolicy: "never", origin: "builtin" });

			const role = await jsonResponse(
				await gateway.api(`/api/roles/${ROLE_NAME}?projectId=${encodeURIComponent(project.id)}`),
				"project team-lead role",
			);
			expect(role.toolPolicies?.[TOOL_NAME], "control: team-lead has no explicit session_prompt override").toBeUndefined();

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

			const listTool = (await projectToolList(gateway, project.id)).find((tool) => tool.name === TOOL_NAME);
			const detail = await projectToolDetail(gateway, project.id);
			const mixedCaseDetail = await projectToolDetail(gateway, project.id, "SESSION_PROMPT");
			expect(listTool).toMatchObject({
				name: TOOL_NAME,
				grantPolicy: "ask",
				origin: "server",
				overrides: "builtin",
			});
			expect(detail).toMatchObject(listTool!);
			expect(mixedCaseDetail).toMatchObject(listTool!);

			const askSession = await createTeamLeadSession(gateway, scope, project.id, projectRoot);
			expect(askSession.allowedTools.map((name: string) => name.toLowerCase())).toContain(TOOL_NAME);
			const askGuard = generatedGuardForSession(gateway, askSession.id);
			expect(askGuard.askPolicies[TOOL_NAME]).toEqual({ policy: "ask", group: listTool!.group });
			expect(askGuard.neverPolicies[TOOL_NAME]).toBeUndefined();

			// Revert through the same API and prove the already-warm catalogue and a
			// newly generated session guard both immediately reveal builtin `never`.
			await jsonResponse(
				await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=server&projectId=headquarters`, { method: "DELETE" }),
				"revert Headquarters override",
			);
			const revertedListTool = (await projectToolList(gateway, project.id)).find((tool) => tool.name === TOOL_NAME);
			const revertedDetail = await projectToolDetail(gateway, project.id);
			expect(revertedListTool).toMatchObject({ name: TOOL_NAME, grantPolicy: "never", origin: "builtin" });
			expect(revertedDetail).toMatchObject(revertedListTool!);

			const neverSession = await createTeamLeadSession(gateway, scope, project.id, projectRoot);
			expect(neverSession.allowedTools.map((name: string) => name.toLowerCase())).not.toContain(TOOL_NAME);
			const neverGuard = generatedGuardForSession(gateway, neverSession.id);
			expect(neverGuard.askPolicies[TOOL_NAME]).toBeUndefined();
			expect(neverGuard.neverPolicies[TOOL_NAME]).toEqual({ policy: "never", group: revertedListTool!.group });
		} finally {
			// The server override copies the whole agent group. Restore it byte-for-byte
			// rather than assuming this fork started empty, then force one live read so
			// subsequent fork-mates cannot observe a stale winner.
			await gateway.api(`/api/tools/${TOOL_NAME}/override?scope=server&projectId=headquarters`, { method: "DELETE" }).catch(() => undefined);
			rmSync(serverAgentTools, { recursive: true, force: true });
			if (hadServerAgentTools && existsSync(backupAgentTools)) {
				cpSync(backupAgentTools, serverAgentTools, { recursive: true });
			}
			rmSync(backupRoot, { recursive: true, force: true });
			await gateway.api("/api/tools?projectId=headquarters").catch(() => undefined);
		}
	});
});
