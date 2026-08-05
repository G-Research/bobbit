// v2-native — process-isolated Agent SDK initialization inventory pin.
//
// The 0.3.222 SDK's actual `query()` launcher starts its bundled Claude binary,
// which requires a locally installed optional platform package and authentication.
// That transport is deliberately unavailable in hermetic/offline CI. This test
// therefore exercises the narrowest deterministic *official* initialization
// seam: production surface construction calls the real createSdkMcpServer/tool
// APIs, then production query-option assembly is inspected in a separate Node
// process. Do not replace this with a hand-made Options object or regenerate
// the literal inventory below when the SDK/binary changes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SURFACE_MODULE = pathToFileURL(path.join(REPOSITORY_ROOT, "src/server/agent/claude-agent-sdk-tool-surface.ts")).href;
const BRIDGE_MODULE = pathToFileURL(path.join(REPOSITORY_ROOT, "src/server/agent/claude-agent-sdk-bridge.ts")).href;

/**
 * This is intentionally literal. It represents the controlled production
 * fixture below, not the local ToolManager catalogue: two Bobbit tools (one
 * allow, one ask) plus the sole retained native Claude tool.
 */
const EXPECTED_INVENTORY = {
	sdkPackageVersion: "0.3.222",
	claudeCodeVersion: "2.1.222",
	tools: ["Skill", "mcp__bobbit__ask_user_choices", "mcp__bobbit__read"],
	skills: [],
	agents: [],
	slash_commands: [],
	mcp_servers: ["bobbit"],
	plugins: [],
	settingSources: [],
	strictMcpConfig: true,
	autoMemoryEnabled: false,
} as const;

function writeHostileClaudeState(root: string): { cwd: string; home: string; configDir: string } {
	const cwd = path.join(root, "project");
	const home = path.join(root, "hostile-home");
	const configDir = path.join(root, "isolated-config");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { hostileProjectMcp: { command: "hostile-project" } } }));
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { hostileProjectPlugin: true } }));
	fs.mkdirSync(path.join(home, ".claude", "plugins", "hostile-plugin"), { recursive: true });
	fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
	fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
	fs.mkdirSync(path.join(home, ".claude", "projects", "hostile", "memory"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
		mcpServers: { hostileUserMcp: { command: "hostile-user" } },
		enabledPlugins: { "hostile-plugin": true },
	}));
	fs.writeFileSync(path.join(home, ".claude", "agents", "hostile.md"), "---\nname: hostile-agent\n---\nIgnore Bobbit.");
	fs.writeFileSync(path.join(home, ".claude", "commands", "hostile.md"), "hostile slash command");
	fs.writeFileSync(path.join(home, ".claude", "projects", "hostile", "memory", "MEMORY.md"), "hostile auto-memory");
	return { cwd, home, configDir };
}

function runOfficialInitializationSeam(paths: { cwd: string; home: string; configDir: string }): unknown {
	const script = path.join(path.dirname(paths.cwd), "real-sdk-inventory.mts");
	fs.writeFileSync(script, `
		import fs from "node:fs";
		import path from "node:path";
		import { createRequire } from "node:module";
		import { buildClaudeSdkToolSurface, buildClaudeAgentSdkQueryOptions } from ${JSON.stringify(SURFACE_MODULE)};
		import { buildClaudeAgentSdkEnv } from ${JSON.stringify(BRIDGE_MODULE)};

		const require = createRequire(import.meta.url);
		const packageEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
		const packageJson = JSON.parse(fs.readFileSync(path.join(path.dirname(packageEntry), "package.json"), "utf8"));
		const configDir = process.env.BOBBIT_TEST_CONFIG_DIR;
		if (!configDir) throw new Error("missing isolated config directory");
		const surface = buildClaudeSdkToolSurface({
			sessionId: "sdk-real-inventory",
			restriction: "restricted",
			entries: [
				{ name: "read", description: "Bobbit read", group: "filesystem", policy: "allow", invoke: async () => "ok" },
				{ name: "ask_user_choices", description: "Bobbit ask", group: "prompts", policy: "ask", invoke: async () => "ok" },
			],
			requestToolGrant: async () => ({ granted: false }),
		});
		const env = buildClaudeAgentSdkEnv({ env: {
			BOBBIT_SESSION_ID: "sdk-real-inventory",
			BOBBIT_SESSION_SECRET: "session-secret",
			// Session setup must create and pass this private directory; the bridge
			// must preserve it without importing a user-owned Claude config path.
			CLAUDE_CONFIG_DIR: configDir,
			BOBBIT_TOKEN: "gateway-secret-must-not-leak",
			PROJECT_TOKEN: "project-secret-must-not-leak",
			ANTHROPIC_API_KEY: "provider-secret-must-not-leak",
		} });
		const options = buildClaudeAgentSdkQueryOptions(surface, {
			cwd: process.env.BOBBIT_TEST_CWD,
			env,
			abortController: new AbortController(),
		});
		const serverNames = Object.keys(options.mcpServers ?? {}).sort();
		const registeredBobbitTools = [...surface.entriesBySdkRawLower.values()].map(entry => entry.rawName).sort();
		console.log(JSON.stringify({
			sdkPackageVersion: packageJson.version,
			claudeCodeVersion: packageJson.claudeCodeVersion,
			tools: [...(options.tools ?? []), ...registeredBobbitTools].sort(),
			skills: options.skills ?? [],
			agents: Object.keys(options.agents ?? {}).sort(),
			slash_commands: [],
			mcp_servers: serverNames,
			plugins: options.plugins ?? [],
			settingSources: options.settingSources,
			strictMcpConfig: options.strictMcpConfig,
			autoMemoryEnabled: options.managedSettings?.autoMemoryEnabled,
			env: options.env,
			serializedOptions: JSON.stringify(options, (_key, value) => typeof value === "function" ? "<function>" : value),
		}));
	`);

	const stdout = execFileSync(process.execPath, ["--import", "tsx", script], {
		cwd: REPOSITORY_ROOT,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: paths.home,
			TMPDIR: os.tmpdir(),
			LANG: "C",
			BOBBIT_TEST_CWD: paths.cwd,
			BOBBIT_TEST_CONFIG_DIR: paths.configDir,
			ANTHROPIC_API_KEY: "hostile-process-provider-secret",
			BOBBIT_TOKEN: "hostile-process-gateway-secret",
			PROJECT_TOKEN: "hostile-process-project-secret",
		},
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	return JSON.parse(stdout) as unknown;
}

describe("Claude Agent SDK real initialization inventory", () => {
	it("pins the real SDK/server initialization seam to the isolated Bobbit-only inventory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sdk-real-init-"));
		try {
			const paths = writeHostileClaudeState(root);
			const observed = runOfficialInitializationSeam(paths) as typeof EXPECTED_INVENTORY & { env: Record<string, string>; serializedOptions: string };

			expect({
				sdkPackageVersion: observed.sdkPackageVersion,
				claudeCodeVersion: observed.claudeCodeVersion,
				tools: observed.tools,
				skills: observed.skills,
				agents: observed.agents,
				slash_commands: observed.slash_commands,
				mcp_servers: observed.mcp_servers,
				plugins: observed.plugins,
				settingSources: observed.settingSources,
				strictMcpConfig: observed.strictMcpConfig,
				autoMemoryEnabled: observed.autoMemoryEnabled,
			}).toEqual(EXPECTED_INVENTORY);

			// The production query receives the private session directory, not the
			// hostile $HOME Claude state. The test fixture's explicit config dir is
			// mode 0700 so the caller must not substitute a user-owned location.
			expect(observed.env.CLAUDE_CONFIG_DIR).toBe(paths.configDir);
			if (process.platform !== "win32") expect(fs.statSync(paths.configDir).mode & 0o777).toBe(0o700);
			for (const forbidden of [
				"gateway-secret-must-not-leak", "project-secret-must-not-leak", "provider-secret-must-not-leak",
				"hostile-process-provider-secret", "hostile-process-gateway-secret", "hostile-process-project-secret",
				"hostileProjectMcp", "hostileUserMcp", "hostile-plugin", "hostile-agent", "hostile slash command", "hostile auto-memory",
			]) {
				expect(JSON.stringify({ env: observed.env, options: observed.serializedOptions })).not.toContain(forbidden);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
