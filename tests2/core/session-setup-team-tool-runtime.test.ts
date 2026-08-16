import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import { resolveTools, type SessionSetupPlan } from "../../src/server/agent/session-setup.ts";
import { computeToolActivationArgs } from "../../src/server/agent/tool-activation.ts";
import { buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";

const TEAM_TOOL = {
	name: "team_spawn",
	description: "Start a constrained team member",
	group: "Team",
	providerType: "bobbit-extension",
};

const TEAM_EXTENSION = path.join("/mock/tools", "team", "extension.ts");

function toolManager() {
	return {
		getAvailableTools: () => [TEAM_TOOL],
		getToolProviders: () => new Map([
			["team_spawn", {
				type: "bobbit-extension",
				baseDir: "/mock/tools",
				groupDir: "team",
				extension: "extension.ts",
			}],
		]),
		getExtensionPath: (group: string, filename: string) => path.join("/mock/tools", group, filename),
	};
}

function teamLeadPlan(runtime: "pi" | "claude-agent-sdk"): SessionSetupPlan {
	return {
		id: `team-lead-${runtime}`,
		title: "Team Lead",
		cwd: "/workspace/project",
		mode: "normal",
		roleName: "team-lead",
		bridgeOptions: { runtime },
	} as SessionSetupPlan;
}

describe("session setup team-lead tool activation", () => {
	it("derives the same team-role tool selection for Pi activation and the SDK surface", () => {
		const tools = toolManager();
		const ctx = {
			roleManager: {
				getRole: (name: string) => name === "team-lead"
					? { toolPolicies: { team_spawn: "allow" } }
					: undefined,
			},
			toolManager: tools,
			mcpManager: null,
			groupPolicyStore: null,
			configCascade: null,
		};
		const piPlan = teamLeadPlan("pi");
		const sdkPlan = teamLeadPlan("claude-agent-sdk");

		resolveTools(piPlan, ctx as any);
		resolveTools(sdkPlan, ctx as any);

		assert.deepEqual(piPlan.effectiveAllowedTools, [{ kind: "yaml", name: "team_spawn" }]);
		assert.deepEqual(sdkPlan.effectiveAllowedTools, piPlan.effectiveAllowedTools);

		const piActivation = computeToolActivationArgs(piPlan.effectiveAllowedTools, tools as any);
		assert.ok(
			piActivation.args.some((arg, index) => arg === "--extension" && piActivation.args[index + 1] === TEAM_EXTENSION),
			"Pi receives the team extension from unified role activation",
		);

		const sdkSurface = buildClaudeSdkToolSurface({
			sessionId: sdkPlan.id,
			restriction: "restricted",
			entries: sdkPlan.effectiveAllowedTools!.map(tool => ({
				name: tool.name,
				description: TEAM_TOOL.description,
				group: TEAM_TOOL.group,
				inputSchema: { type: "object", properties: {} },
				policy: "allow" as const,
				invoke: async () => undefined,
			})),
			requestToolGrant: async () => ({ granted: false }),
		});
		assert.deepEqual(sdkSurface.sdkAllowNames, ["mcp__bobbit__team_spawn"]);
	});
});
