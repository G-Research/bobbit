// v2-native — real Agent SDK initialization inventory pin.
// This stays in-process because tier-1 tests must not spawn Node binaries.  It
// calls the same official createSdkMcpServer/tool seam used by production; a
// subprocess would test process creation, not SDK composition.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { buildClaudeAgentSdkQueryOptions, buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { buildClaudeAgentSdkEnv } from "../../src/server/agent/claude-agent-sdk-bridge.ts";

const EXPECTED_INVENTORY = {
	sdkPackageVersion: "0.3.222",
	claudeCodeVersion: "2.1.222",
	tools: ["Skill", "mcp__bobbit__ask_user_choices", "mcp__bobbit__read"],
	skills: [], agents: [], slash_commands: [], mcp_servers: ["bobbit"], plugins: [],
	settingSources: [], strictMcpConfig: true, autoMemoryEnabled: false,
} as const;

describe("Claude Agent SDK real initialization inventory", () => {
	it("pins the official SDK server initialization seam to the isolated Bobbit-only inventory", () => {
		const require = createRequire(import.meta.url);
		const packageEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
		const packageJson = JSON.parse(fs.readFileSync(path.join(path.dirname(packageEntry), "package.json"), "utf8"));
		const surface = buildClaudeSdkToolSurface({
			sessionId: "sdk-real-inventory", restriction: "restricted",
			entries: [
				{ name: "read", description: "Bobbit read", group: "filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow", invoke: async () => "ok" },
				{ name: "ask_user_choices", description: "Bobbit ask", group: "prompts", inputSchema: { type: "object", properties: { questions: { type: "array" } } }, policy: "ask", invoke: async () => "ok" },
			],
			requestToolGrant: async () => ({ granted: false }),
		});
		const env = { ...buildClaudeAgentSdkEnv({ env: {
			BOBBIT_SESSION_ID: "sdk-real-inventory", BOBBIT_SESSION_SECRET: "session-secret",
			BOBBIT_TOKEN: "gateway-secret-must-not-leak", PROJECT_TOKEN: "project-secret-must-not-leak",
			ANTHROPIC_API_KEY: "provider-secret-must-not-leak",
		} }), CLAUDE_CONFIG_DIR: "/isolated/claude" }; // created per-session by ClaudeAgentSdkBridge
		const options = buildClaudeAgentSdkQueryOptions(surface, { cwd: "/isolated/project", env, abortController: new AbortController() });
		const observed = {
			sdkPackageVersion: packageJson.version, claudeCodeVersion: packageJson.claudeCodeVersion,
			tools: [...(options.tools ?? []), ...surface.entriesBySdkRawLower.values()].map(value => typeof value === "string" ? value : value.rawName).sort(),
			skills: options.skills ?? [], agents: Object.keys(options.agents ?? {}).sort(), slash_commands: [],
			mcp_servers: Object.keys(options.mcpServers ?? {}).sort(), plugins: options.plugins ?? [],
			settingSources: options.settingSources, strictMcpConfig: options.strictMcpConfig,
			autoMemoryEnabled: options.managedSettings?.autoMemoryEnabled,
		};
		expect(observed).toEqual(EXPECTED_INVENTORY);
		expect(options.env).toMatchObject({ BOBBIT_SESSION_ID: "sdk-real-inventory", CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit", CLAUDE_CONFIG_DIR: "/isolated/claude" });
		for (const forbidden of ["gateway-secret-must-not-leak", "project-secret-must-not-leak", "provider-secret-must-not-leak"]) {
			expect(JSON.stringify({ env: options.env, mcpServers: Object.keys(options.mcpServers ?? {}), settingSources: options.settingSources })).not.toContain(forbidden);
		}
	});
});
