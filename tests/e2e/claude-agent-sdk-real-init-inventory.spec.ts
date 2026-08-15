/**
 * Real Agent SDK / bundled-Claude initialization inventory.
 *
 * This lives in the Playwright E2E lane so the SDK and its bundled CLI start in
 * an isolated worker process. It deliberately sends an empty prompt and aborts
 * immediately after initialization: no model turn or external service is used.
 */
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { createRunChild } from "../../tests2/harness/run-isolation.js";
import { buildClaudeAgentSdkEnv } from "../../dist/server/agent/claude-agent-sdk-bridge.js";
import { buildClaudeAgentSdkQueryOptions, buildClaudeSdkSubagentPolicy, buildClaudeSdkToolSurface } from "../../dist/server/agent/claude-agent-sdk-tool-surface.js";

const EXPECTED_INVENTORY = {
	sdkPackageVersion: "0.3.222",
	claudeCodeVersion: "2.1.222",
	tools: ["Skill", "mcp__bobbit__find", "mcp__bobbit__grep", "mcp__bobbit__read"],
	skills: ["batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "design-sync", "doctor", "fewer-permission-prompts", "loop", "run", "run-skill-generator", "simplify", "update-config", "verify"],
	agents: ["Explore", "Plan", "bobbit-backend-parity-reviewer", "bobbit-billing-safety-auditor", "bobbit-protocol-scout", "claude", "general-purpose", "statusline-setup"],
	slash_commands: ["__remote-workflow", "agents", "autocompact", "batch", "claude-api", "clear", "code-review", "color", "compact", "config", "context", "dataviz", "debug", "deep-research", "design", "design-consent", "design-revoke", "design-sync", "doctor", "effort", "fast", "fewer-permission-prompts", "goal", "heapdump", "init", "insights", "loop", "mcp", "model", "recap", "reload-skills", "rename", "review", "run", "run-skill-generator", "security-review", "simplify", "team-onboarding", "update-config", "usage", "verify", "workflow-launch-exec"],
	mcp_servers: ["bobbit"],
	plugins: [],
	settingSources: [],
	strictMcpConfig: true,
	autoMemoryEnabled: false,
} as const;

function writeFixture(root: string, file: string, content: string): void {
	const target = join(root, file);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function allFiles(root: string): string[] {
	const visit = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
		const target = join(directory, entry);
		return statSync(target).isDirectory() ? visit(target) : [relative(root, target)];
	});
	return existsSync(root) ? visit(root).sort() : [];
}

function names(rows: readonly { name: string }[] | undefined): string[] {
	return (rows ?? []).map(row => row.name).sort();
}

test.describe("Claude Agent SDK real initialization inventory", () => {
	test.setTimeout(30_000);

	test("uses only the live Bobbit MCP server despite hostile external Claude sources", async () => {
		const root = createRunChild(`claude-sdk-real-init-${process.pid}`);
		const hostHome = join(root, "host-home");
		const project = join(root, "project");
		const isolatedConfig = join(root, "isolated-claude-config");
		const gatewaySecret = "gateway-secret-must-not-leak";
		const projectSecret = "project-secret-must-not-leak";
		const providerSecret = "provider-secret-must-not-leak";
		const memorySentinel = "HOSTILE_AUTO_MEMORY_MUST_NOT_BE_READ_OR_WRITTEN";

		try {
			for (const directory of [hostHome, project, isolatedConfig]) mkdirSync(directory, { recursive: true });
			// Every discovery source contains a distinct hostile marker. `settingSources`
			// and `strictMcpConfig` must make all of these inert in the reported init.
			writeFixture(hostHome, ".claude/settings.json", JSON.stringify({ mcpServers: { hostile_user: { command: "echo" } }, autoMemoryEnabled: true }));
			writeFixture(hostHome, ".claude/skills/hostile-user/SKILL.md", "# hostile-user\n");
			writeFixture(hostHome, ".claude/agents/hostile-user.md", "---\nname: hostile-user\n---\n");
			writeFixture(hostHome, ".claude/commands/hostile-user.md", "hostile user command\n");
			writeFixture(project, ".claude/settings.json", JSON.stringify({ mcpServers: { hostile_project: { command: "echo" } }, autoMemoryEnabled: true }));
			writeFixture(project, ".claude/settings.local.json", JSON.stringify({ mcpServers: { hostile_local: { command: "echo" } } }));
			writeFixture(project, ".mcp.json", JSON.stringify({ mcpServers: { hostile_mcp_json: { command: "echo" } } }));
			writeFixture(project, ".claude/plugins/hostile/.claude-plugin/plugin.json", JSON.stringify({ name: "hostile-plugin" }));
			writeFixture(project, ".claude/plugins/hostile/skills/hostile-plugin-skill/SKILL.md", "# hostile-plugin-skill\n");
			writeFixture(project, ".claude/agent-memory/hostile/MEMORY.md", `${memorySentinel}\n`);
			writeFixture(isolatedConfig, "settings.json", JSON.stringify({ mcpServers: { hostile_config_dir: { command: "echo" } }, autoMemoryEnabled: true }));
			writeFixture(isolatedConfig, "projects/hostile/memory/MEMORY.md", `${memorySentinel}\n`);
			const hostFilesBefore = allFiles(hostHome);
			const isolatedMemoryFilesBefore = allFiles(isolatedConfig).filter(file => file.includes("/memory/") || file.startsWith("memory/"));

			// Production D4 projection: all three exact cascade-resolved roles and
			// only the read/find/grep child subset. This is intentionally not a
			// hand-written `agents` substitute.
			const entries = [
				{ name: "read", description: "Bobbit read", group: "filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow" as const, invoke: async () => "ok" },
				{ name: "find", description: "Bobbit find", group: "filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow" as const, invoke: async () => "ok" },
				{ name: "grep", description: "Bobbit grep", group: "filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow" as const, invoke: async () => "ok" },
			];
			const subagentPolicy = buildClaudeSdkSubagentPolicy({
				sessionId: "sdk-real-inventory",
				goalBranch: "goal/sdk-real-inventory",
				entries,
				roles: {
					"claude-protocol-scout": { name: "claude-protocol-scout", promptTemplate: "Protocol scout {{AGENT_ID}} {{GOAL_BRANCH}}" },
					"backend-parity-reviewer": { name: "backend-parity-reviewer", promptTemplate: "Parity reviewer {{AGENT_ID}} {{GOAL_BRANCH}}" },
					"billing-safety-auditor": { name: "billing-safety-auditor", promptTemplate: "Billing auditor {{AGENT_ID}} {{GOAL_BRANCH}}" },
				},
			});
			const surface = buildClaudeSdkToolSurface({
				sessionId: "sdk-real-inventory",
				restriction: "restricted",
				entries,
				subagentPolicy,
				requestToolGrant: async () => ({ granted: false }),
			});
			const abortController = new AbortController();
			const env = {
				...buildClaudeAgentSdkEnv({ env: {
					BOBBIT_SESSION_ID: "sdk-real-inventory",
					BOBBIT_SESSION_SECRET: "session-secret",
					BOBBIT_TOKEN: gatewaySecret,
					PROJECT_TOKEN: projectSecret,
					ANTHROPIC_API_KEY: providerSecret,
				} }),
				HOME: hostHome,
				CLAUDE_CONFIG_DIR: isolatedConfig,
			};
			const options = buildClaudeAgentSdkQueryOptions(surface, {
				cwd: project,
				env,
				abortController,
				model: "claude-haiku-4-5",
			});

			expect({
				settingSources: options.settingSources,
				strictMcpConfig: options.strictMcpConfig,
				autoMemoryEnabled: options.managedSettings?.autoMemoryEnabled,
				mcpServers: Object.keys(options.mcpServers ?? {}).sort(),
			}).toEqual({
				settingSources: EXPECTED_INVENTORY.settingSources,
				strictMcpConfig: EXPECTED_INVENTORY.strictMcpConfig,
				autoMemoryEnabled: EXPECTED_INVENTORY.autoMemoryEnabled,
				mcpServers: EXPECTED_INVENTORY.mcp_servers,
			});
			// `init.tools` reports literal callable tools only. The programmatic
			// `agents` definitions are the real Agent meta-facility inventory.
			expect(options.tools).toEqual(["Skill", "Agent"]);
			expect(options.skills).toEqual(EXPECTED_INVENTORY.skills);
			expect(options.agents && Object.keys(options.agents).sort()).toEqual([
				"bobbit-backend-parity-reviewer", "bobbit-billing-safety-auditor", "bobbit-protocol-scout",
			]);
			expect(options.allowedTools).toEqual(["Agent", "mcp__bobbit__find", "mcp__bobbit__grep", "mcp__bobbit__read"]);
			// Agent's official bare allow entry shadows canUseTool, so invalid
			// helper requests must still be stopped by the independent hook gate.
			const preToolUse = (options.hooks?.PreToolUse as any)[0].hooks[0];
			expect((await preToolUse({
				tool_name: "Agent", tool_use_id: "invalid-agent", tool_input: {
					subagent_type: "general-purpose", prompt: "must not escape", run_in_background: false,
				},
			})).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(options.allowedTools).not.toContain("Task");
			expect(options.disallowedTools).toContain("Task");
			for (const forbidden of [gatewaySecret, projectSecret, providerSecret]) {
				expect(JSON.stringify(options.env)).not.toContain(forbidden);
			}

			// This is the official SDK's real Query and bundled Claude binary. An empty
			// prompt forces process initialization without submitting a model turn.
			const live = query({ prompt: "", options });
			try {
				const iterator = live[Symbol.asyncIterator]();
				const [first, initialization] = await Promise.all([iterator.next(), live.initializationResult()]);
				expect(first.done).toBe(false);
				const init = first.value as Record<string, any>;
				expect(init).toMatchObject({ type: "system", subtype: "init" });
				const require = createRequire(import.meta.url);
				const sdkPackage = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
				const observed = {
					sdkPackageVersion: sdkPackage.version,
					claudeCodeVersion: init.claude_code_version,
					tools: [...init.tools].sort(),
					skills: [...init.skills].sort(),
					agents: [...(init.agents ?? [])].sort(),
					slash_commands: [...init.slash_commands].sort(),
					mcp_servers: names(init.mcp_servers),
					plugins: names(init.plugins),
					settingSources: options.settingSources,
					strictMcpConfig: options.strictMcpConfig,
					autoMemoryEnabled: options.managedSettings?.autoMemoryEnabled,
				};
				try {
					expect(observed).toEqual(EXPECTED_INVENTORY);
				} catch (error) {
					// Pin upgrades must be reviewed against the literal live report, never
					// accepted by regenerating the fixture. In 2.1.222 `init.tools` omits
					// Agent: the agent definitions are the real meta-facility inventory.
					console.error("[claude-sdk-real-init-inventory] observed", JSON.stringify(observed));
					throw error;
				}
				expect(names(initialization.commands)).toEqual(EXPECTED_INVENTORY.slash_commands);
				expect(names(initialization.agents)).toEqual(EXPECTED_INVENTORY.agents);
				expect(await live.mcpServerStatus()).toEqual([
					{ name: "bobbit", status: "connected", scope: "dynamic", tools: [{ name: "read", annotations: {} }, { name: "find", annotations: {} }, { name: "grep", annotations: {} }] },
				]);
				const report = JSON.stringify({ init, initialization });
				for (const hostile of ["hostile_user", "hostile_project", "hostile_local", "hostile_mcp_json", "hostile_config_dir", "hostile-plugin", "hostile-user", "hostile-plugin-skill", memorySentinel]) {
					expect(report).not.toContain(hostile);
				}
			} finally {
				abortController.abort();
				await live.return?.().catch(() => undefined);
			}

			expect(readFileSync(join(isolatedConfig, "projects/hostile/memory/MEMORY.md"), "utf8")).toContain(memorySentinel);
			expect(allFiles(hostHome)).toEqual(hostFilesBefore);
			expect(allFiles(isolatedConfig).filter(file => file.includes("/memory/") || file.startsWith("memory/"))).toEqual(isolatedMemoryFilesBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
