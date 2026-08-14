/**
 * Controlled gateway journey for the Agent SDK Docker-sandbox runtime.
 *
 * The SDK and ProjectSandbox seams are deliberately in-process fakes: this
 * proves SessionManager's production sandbox wiring, recovery, persistence,
 * and transcript ownership without a Docker daemon or subscription.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./gateway-harness.js";
import { apiFetch, connectWs, defaultProjectId, gitCwd, nonGitCwd, waitForSessionStatus } from "./e2e-setup.js";
import { isDockerSandboxAvailable, SANDBOX_IMAGE } from "./test-utils/docker.js";
import { ProjectSandbox } from "../../src/server/agent/project-sandbox.js";

const SDK_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OAUTH_POLICY = "ANTHROPIC_OAUTH_TOKEN";

type DockerDispatcherLaunch = {
	containerId: string;
	cwd: string;
	command: string[];
	envNames: string[];
	hasScopedAuthority: boolean;
};

/**
 * The production dispatcher speaks newline-delimited `BOBBIT_SDK_DISPATCH:`
 * messages over the Docker-exec child pipes. This executable is placed first
 * in PATH only for this journey: it records the non-secret launch shape and
 * implements that protocol, rather than replacing SessionManager wiring or
 * the dispatcher itself.
 */
function installControlledDocker(root: string): { launches: () => DockerDispatcherLaunch[]; restore: () => void } {
	const bin = join(root, "controlled-docker-bin");
	const script = join(bin, "docker.mjs");
	const executable = join(bin, process.platform === "win32" ? "docker.cmd" : "docker");
	const log = join(root, "controlled-docker-launches.jsonl");
	const previousPath = process.env.PATH;
	const previousLog = process.env.BOBBIT_E2E_CONTROLLED_DOCKER_LOG;
	mkdirSync(bin, { recursive: true });
	writeFileSync(script, `import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const envNames = [];
let scopedToken = false;
let gatewayUrl = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "-e") continue;
  const entry = args[++index] || "";
  const equals = entry.indexOf("=");
  const name = equals < 0 ? entry : entry.slice(0, equals);
  const value = equals < 0 ? "" : entry.slice(equals + 1);
  envNames.push(name);
  if (name === "BOBBIT_TOKEN" && value.length > 0) scopedToken = true;
  if (name === "BOBBIT_GATEWAY_URL" && value.length > 0) gatewayUrl = true;
}
const worktree = args.indexOf("-w");
const cwd = worktree >= 0 ? args[worktree + 1] || "" : "";
const containerId = worktree >= 0 ? args[worktree + 2] || "" : "";
const command = worktree >= 0 ? args.slice(worktree + 3) : [];
if (command[0] === "node" && command[1] === "--input-type=module" && command[2] === "--eval") appendFileSync(process.env.BOBBIT_E2E_CONTROLLED_DOCKER_LOG, JSON.stringify({ containerId, cwd, command: command.slice(0, 3), envNames, hasScopedAuthority: scopedToken && gatewayUrl }) + "\\n");
let pending = "";
process.stdin.on("data", chunk => {
  pending += chunk.toString();
  const lines = pending.split("\\n");
  pending = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("BOBBIT_SDK_DISPATCH:")) continue;
    const message = JSON.parse(line.slice("BOBBIT_SDK_DISPATCH:".length));
    if (message.type === "init") {
      const names = [...new Set((message.manifest || []).flatMap(entry => entry.selectedToolNames || []))];
      process.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "ready", schemas: names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })), omittedConditional: [] }) + "\\n");
    }
    if (message.type === "invoke") process.stdout.write("BOBBIT_SDK_DISPATCH:" + JSON.stringify({ type: "result", id: message.id, result: { content: [{ type: "text", text: "controlled container dispatch" }] } }) + "\\n");
  }
});
`);
	writeFileSync(executable, process.platform === "win32"
		? "@echo off\r\nnode \"%~dp0docker.mjs\" %*\r\n"
		: "#!/usr/bin/env node\nimport \"./docker.mjs\";\n");
	chmodSync(executable, 0o755);
	process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
	process.env.BOBBIT_E2E_CONTROLLED_DOCKER_LOG = log;
	return {
		launches: () => {
			try {
				return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as DockerDispatcherLaunch);
			} catch { return []; }
		},
		restore: () => {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousLog === undefined) delete process.env.BOBBIT_E2E_CONTROLLED_DOCKER_LOG;
			else process.env.BOBBIT_E2E_CONTROLLED_DOCKER_LOG = previousLog;
		},
	};
}

type QueryArgs = { prompt: AsyncIterable<any>; options: Record<string, any> };
type SdkMessage = { type: "user" | "assistant"; uuid: string; session_id: string; message: any; parent_tool_use_id: null; parent_agent_id: null };

class ControlledQuery implements AsyncIterable<unknown> {
	readonly inputs: string[] = [];
	private readonly queued: unknown[] = [];
	private readonly readers: Array<(value: IteratorResult<unknown>) => void> = [];
	private closed = false;

	constructor(readonly args: QueryArgs, private readonly sdk: ControlledSdk) {
		this.queued.push({ type: "system", subtype: "init", session_id: SDK_SESSION_ID });
		void this.consume();
	}
	async initializationResult(): Promise<Record<string, never>> { return {}; }
	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
	}
	private emit(value: unknown): void {
		const reader = this.readers.shift();
		if (reader) reader({ done: false, value });
		else this.queued.push(value);
	}
	private async consume(): Promise<void> {
		try {
			for await (const input of this.args.prompt) {
				const text = typeof input?.message?.content === "string" ? input.message.content : "";
				this.inputs.push(text);
				const assistant = this.sdk.append(text);
				this.emit({ type: "assistant", session_id: SDK_SESSION_ID, uuid: assistant.uuid, message: assistant.message });
				this.emit({ type: "result", session_id: SDK_SESSION_ID, subtype: "success" });
			}
		} catch { /* Closing a bridge closes the async input. */ }
	}
	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return { next: () => {
			const value = this.queued.shift();
			if (value !== undefined) return Promise.resolve({ done: false, value });
			if (this.closed) return Promise.resolve({ done: true, value: undefined });
			return new Promise(resolve => this.readers.push(resolve));
		} };
	}
}

class ControlledSdk {
	readonly queries: ControlledQuery[] = [];
	readonly history: SdkMessage[] = [];
	private turn = 0;
	append(text: string): SdkMessage {
		const turn = ++this.turn;
		this.history.push({ type: "user", uuid: `sandbox-user-${turn}`, session_id: SDK_SESSION_ID, message: { role: "user", content: text, timestamp: turn }, parent_tool_use_id: null, parent_agent_id: null });
		const assistant: SdkMessage = { type: "assistant", uuid: `sandbox-assistant-${turn}`, session_id: SDK_SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: `SANDBOX_SDK:${text}` }], timestamp: turn }, parent_tool_use_id: null, parent_agent_id: null };
		this.history.push(assistant);
		return assistant;
	}
	async getSessionInfo(sessionId: string): Promise<any> {
		return sessionId === SDK_SESSION_ID ? { sessionId, summary: "controlled sandbox", lastModified: this.history.length } : undefined;
	}
	async getSessionMessages(sessionId: string): Promise<SdkMessage[]> {
		return sessionId === SDK_SESSION_ID ? structuredClone(this.history) : [];
	}
	readonly depsFactory = () => ({
		query: ((args: QueryArgs) => {
			const query = new ControlledQuery(args, this);
			this.queries.push(query);
			return query;
		}) as any,
		sessionAccess: { loadSdk: async () => this, sandboxSdk: this },
		clock: { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval },
	});
}

const sdk = new ControlledSdk();
const bridgeLaunches: Array<Record<string, any>> = [];
test.use({ claudeAgentSdkBridgeDepsFactory: { create: (options: Record<string, any>) => {
	if (options.claudeSdkSandboxLaunch) bridgeLaunches.push(options.claudeSdkSandboxLaunch);
	return sdk.depsFactory();
} } });

test.describe.serial("Claude Agent SDK controlled Docker sandbox", () => {
	test.setTimeout(90_000);

	test("fails closed for unavailable auth/image, then preserves sandbox SDK history and UUID across recovery and gateway restart", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const manager = gateway.sessionManager as any;
		const sandboxManager = manager.sandboxManager as any;
		// Patch the manager prototype so the fixture's real gateway restart gets
		// the same controlled pooled-container seam before it restores sessions.
		const sandboxPrototype = Object.getPrototypeOf(sandboxManager) as Record<string, any>;
		const originalEnsure = sandboxPrototype.ensureForProject;
		const originalGet = sandboxPrototype.get;
		const originalGetStats = sandboxPrototype.getStats;
		const authFile = join(gateway.bobbitDir, "agent", "auth.json");
		const originalAuth = readFileSync(authFile, "utf8");
		const docker = installControlledDocker(gateway.bobbitDir);
		const access = randomUUID();
		let containerId = "controlled-sdk-container-a";
		let capable = true;
		const sandbox = {
			getContainerId: async () => containerId,
			hasClaudeAgentSdkCapability: async () => capable,
			prepareClaudeAgentSdkSession: async () => undefined,
			createWorktree: async (branch: string) => `/workspace-wt/${branch}`,
			getStatus: () => ({ containerId, status: "ready", projectId }),
		};
		sandboxPrototype.ensureForProject = async function(this: unknown, id: string) {
			if (id === projectId) return;
			return originalEnsure.call(this, id);
		};
		sandboxPrototype.get = function(this: unknown, id: string) {
			return id === projectId ? sandbox : originalGet.call(this, id);
		};
		// The session route checks manager stats before invoking `docker info`.
		// Keep that check true to the controlled ready pooled container above,
		// while the later production dispatcher still runs through our Docker-exec
		// protocol executable.
		sandboxPrototype.getStats = function(this: unknown) {
			const stats = originalGetStats.call(this);
			return { ...stats, containers: [...stats.containers, { projectId, containerId, status: "ready" }] };
		};

		const createSandboxSdkSession = async (worktree = true, cwd = gitCwd()): Promise<Response> => apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId, cwd, sandboxed: true, worktree, initialModel: "claude-agent-sdk/controlled-sandbox" }),
		});
		const expectAsyncUnavailable = async (code: string, secret: string): Promise<void> => {
			const response = await createSandboxSdkSession();
			expect(response.status, await response.clone().text()).toBe(201);
			const { id } = await response.json() as { id: string };
			await waitForSessionStatus(id, "archived", 15_000);
			const archived = await apiFetch(`/api/sessions/${id}`);
			expect(archived.status, await archived.clone().text()).toBe(200);
			expect((await archived.json()).status).toBe("archived");
			const setupFailure = gateway.logs.ring.find(line => line.includes(`wireSandbox failed for ${id}`));
			expect(setupFailure).toContain(code);
			expect(setupFailure?.includes(secret)).toBe(false);
			expect(sdk.queries).toHaveLength(0);
		};
		const preferencesResponse = await apiFetch("/api/preferences");
		expect(preferencesResponse.status, await preferencesResponse.clone().text()).toBe(200);
		const originalPreferences = await preferencesResponse.json() as Record<string, unknown>;
		try {
			const config = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker", sandbox_tokens: [{ key: OAUTH_POLICY, enabled: true }] }),
			});
			expect(config.status, await config.text()).toBe(200);
			const provider = await apiFetch("/api/custom-providers", { method: "POST", body: JSON.stringify({
				id: "claude-agent-sdk", name: "claude-agent-sdk", type: "manual", baseUrl: "http://127.0.0.1:9",
				models: [{ id: "controlled-sandbox", name: "Controlled sandbox SDK" }],
			}) });
			expect(provider.status, await provider.text()).toBe(200);
			const preferences = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": "claude-agent-sdk/controlled-sandbox", "default.sessionThinkingLevel": "off" }),
			});
			expect(preferences.status, await preferences.text()).toBe(200);

			// Session creation deliberately returns 201 while sandbox worktree setup
			// runs. Observe the resulting archived session and its sanitized setup
			// diagnostic rather than treating the creation response as a synchronous failure.
			writeFileSync(authFile, JSON.stringify({ anthropic: { type: "oauth", refresh: access, expires: Date.now() + 60_000 } }));
			await expectAsyncUnavailable("CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE", access);

			writeFileSync(authFile, JSON.stringify({ anthropic: { type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60 * 60_000 } }));
			capable = false;
			await expectAsyncUnavailable("CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE", access);

			capable = true;
			// This deliberately uses synchronous `executePlan` (no worktree), where
			// SDK dispatcher preflight must wait for sandbox container wiring.
			const response = await createSandboxSdkSession(false, nonGitCwd());
			expect(response.status, await response.clone().text()).toBe(201);
			const { id } = await response.json() as { id: string };
			await waitForSessionStatus(id, "idle", 30_000);
			expect(sdk.queries).toHaveLength(1);
			expect(bridgeLaunches).toHaveLength(1);
			expect(bridgeLaunches[0].containerId).toBe("controlled-sdk-container-a");
			expect(bridgeLaunches[0].cwd).toMatch(/^\/workspace\/\.e2e-workspaces\/non-git-/);
			expect(bridgeLaunches[0].oauthAccessToken === access).toBe(true);
			const initialDispatches = docker.launches();
			expect(initialDispatches).toHaveLength(1);
			expect(initialDispatches[0]).toMatchObject({
				containerId: "controlled-sdk-container-a",
				cwd: bridgeLaunches[0].cwd,
				hasScopedAuthority: true,
			});
			expect(initialDispatches[0].command).toEqual(expect.arrayContaining(["node", "--input-type=module", "--eval"]));
			expect(initialDispatches[0].envNames).toEqual(expect.arrayContaining(["BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]));
			expect(initialDispatches[0].envNames).not.toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]));

			const connection = await connectWs(id);
			try {
				const cursor = connection.messageCount();
				connection.send({ type: "prompt", text: "SANDBOX_BEFORE_RESTART" });
				await connection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
			} finally { connection.close(); }
			const before = structuredClone(sdk.history);
			expect(JSON.stringify(before)).toContain("SANDBOX_SDK:SANDBOX_BEFORE_RESTART");
			const persisted = manager.getPersistedSession(id);
			expect(persisted).toMatchObject({ sandboxed: true, runtime: "claude-agent-sdk", claudeAgentSdkSessionId: SDK_SESSION_ID });
			expect(JSON.stringify(persisted).includes(access)).toBe(false);

			// A co-resident Pi session retains its own bridge: no SDK launch and no
			// Pi switch_session command are ever attributed to the SDK session.
			const piPreferences = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": "mock/mock-model", "default.sessionThinkingLevel": "off" }),
			});
			expect(piPreferences.status, await piPreferences.text()).toBe(200);
			const pi = await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify({ projectId, cwd: nonGitCwd(), worktree: false, initialModel: "mock/mock-model" }) });
			expect(pi.status, await pi.clone().text()).toBe(201);
			const piId = (await pi.json() as { id: string }).id;
			await waitForSessionStatus(piId, "idle");
			const piBefore = gateway.piCommandLog.length;

			containerId = "controlled-sdk-container-b";
			await gateway.crash();
			await gateway.restart();
			const restoredManager = gateway.sessionManager as any;
			await waitForSessionStatus(id, "idle", 30_000);
			await waitForSessionStatus(piId, "idle", 30_000);
			expect(sdk.queries).toHaveLength(2);
			expect(sdk.queries[1].args.options.resume).toBe(SDK_SESSION_ID);
			expect(bridgeLaunches[1].containerId).toBe("controlled-sdk-container-b");
			const recoveredDispatches = docker.launches();
			expect(recoveredDispatches).toHaveLength(2);
			expect(recoveredDispatches[1]).toMatchObject({
				containerId: "controlled-sdk-container-b",
				cwd: bridgeLaunches[1].cwd,
				hasScopedAuthority: true,
			});
			expect(recoveredDispatches[1].envNames).not.toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]));
			expect(sdk.history).toEqual(before);
			expect(gateway.piCommandLog.slice(piBefore).filter((row: any) => row.sessionId === id)).toEqual([]);
		} finally {
			docker.restore();
			writeFileSync(authFile, originalAuth);
			sandboxPrototype.ensureForProject = originalEnsure;
			sandboxPrototype.get = originalGet;
			sandboxPrototype.getStats = originalGetStats;
			await apiFetch("/api/custom-providers/claude-agent-sdk", { method: "DELETE" }).catch(() => undefined);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": originalPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": originalPreferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
			await apiFetch(`/api/projects/${projectId}/config`, { method: "PUT", body: JSON.stringify({ sandbox: "none", sandbox_tokens: null }) }).catch(() => undefined);
		}
	});

	test("migrates legacy SDK state in a private named volume and rejects replacement", async () => {
		const imageHasSdkUser = isDockerSandboxAvailable() && (() => {
			try {
				execFileSync("docker", ["run", "--rm", SANDBOX_IMAGE, "id", "-u", "bobbit-sdk"], { stdio: "ignore", timeout: 10_000 });
				return true;
			} catch { return false; }
		})();
		test.skip(!imageHasSdkUser, "requires a locally rebuilt bobbit-agent image with the SDK user");
		const stateVolume = `bobbit-sdk-state-${randomUUID().slice(0, 8)}`;
		const name = `bobbit-sdk-state-${randomUUID().slice(0, 8)}`;
		const replacement = `${name}-replacement`;
		const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000 });
		try {
			// Match ProjectSandbox's ownership labels so interrupted E2E cleanup can
			// discover this direct-volume security fixture after a crash.
			docker(["volume", "create", "--label", "bobbit-project=sdk-state-e2e", "--label", `bobbit-e2e-run=${process.env.BOBBIT_E2E_RUN_ID ?? "manual"}`, stateVolume]);
			docker(["run", "-d", "--name", name, "-v", `${stateVolume}:/bobbit-state/claude-agent-sdk`, SANDBOX_IMAGE, "sleep", "infinity"]);
			expect(docker(["inspect", "--format", "{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}{{end}}", name])).toContain(`volume:${stateVolume}:/bobbit-state/claude-agent-sdk`);
			// Simulate state written by the pre-lock UID-1000 container without
			// weakening the fresh named volume's root-owned mountpoint.
			docker(["exec", "-u", "root", name, "sh", "-c", "install -d -o node -g node -m 755 /bobbit-state/claude-agent-sdk/legacy-session/nested; printf legacy-history > /bobbit-state/claude-agent-sdk/legacy-session/history; printf nested > /bobbit-state/claude-agent-sdk/legacy-session/nested/entry; chown -R node:node /bobbit-state/claude-agent-sdk/legacy-session; chmod 755 /bobbit-state/claude-agent-sdk/legacy-session/nested; chmod 644 /bobbit-state/claude-agent-sdk/legacy-session/history"]);
			const sandbox = new ProjectSandbox({ projectId: "sdk-state-e2e", projectDir: gitCwd(), repoUrl: "https://example.test/repo.git", image: SANDBOX_IMAGE });
			(sandbox as any).containerId = name;

			// Establish an existing trusted marker first. A later failed migration
			// must revoke it rather than letting reconnect trust stale state.
			await (sandbox as any)._prepareClaudeAgentSdkStateParent(name);
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("secure");
			// A legacy hard link could retain an attacker-openable alias. The
			// lifecycle gate rejects it and invalidates the prior attestation.
			docker(["exec", "-u", "root", name, "ln", "/bobbit-state/claude-agent-sdk/legacy-session/history", "/bobbit-state/claude-agent-sdk/legacy-session/history-alias"]);
			await expect((sandbox as any)._prepareClaudeAgentSdkStateParent(name)).rejects.toThrow();
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("invalid");
			expect(docker(["exec", "-u", "root", name, "stat", "-c", "%h:%u:%a", "/bobbit-state/claude-agent-sdk/legacy-session/history"])).toBe("2:1001:600\n");
			docker(["exec", "-u", "root", name, "rm", "/bobbit-state/claude-agent-sdk/legacy-session/history-alias"]);

			// This retry attests every dormant child only after successful migration.
			await (sandbox as any)._prepareClaudeAgentSdkStateParent(name);
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("secure");
			expect(() => docker(["exec", "-u", "node", name, "cat", "/bobbit-state/claude-agent-sdk/legacy-session/history"])).toThrow();
			await sandbox.prepareClaudeAgentSdkSession("/workspace", "legacy-session");
			expect(docker(["exec", "-u", "root", name, "stat", "-c", "%u:%a", "/bobbit-state/claude-agent-sdk", "/bobbit-state/claude-agent-sdk/legacy-session", "/bobbit-state/claude-agent-sdk/legacy-session/nested", "/bobbit-state/claude-agent-sdk/legacy-session/history", "/bobbit-state/claude-agent-sdk/legacy-session/nested/entry"])).toBe("0:711\n1001:700\n1001:700\n1001:600\n1001:600\n");

			// The exact predecessor shape is an empty mkdir lock plus an empty
			// PID-suffixed pending directory. The v3 flock owner cleans both only
			// while exclusively holding its permanent lock inode.
			const lifecycle = "/bobbit-state/claude-agent-sdk";
			docker(["exec", "-u", "root", name, "sh", "-ceu", `mkdir ${lifecycle}/.bobbit-sdk-state-migration-lock-v1; install -d -m 700 ${lifecycle}/.bobbit-sdk-state-migration-pending-999999`]);
			// VERIFY running-container policy: never delete predecessor artifacts.
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("invalid");
			expect(docker(["exec", "-u", "root", name, "test", "-d", `${lifecycle}/.bobbit-sdk-state-migration-lock-v1`])).toBe("");
			docker(["restart", name]);
			await (sandbox as any)._prepareClaudeAgentSdkStateParent(name);
			expect(docker(["exec", "-u", "root", name, "sh", "-ceu", `test ! -e ${lifecycle}/.bobbit-sdk-state-migration-lock-v1; test ! -e ${lifecycle}/.bobbit-sdk-state-migration-pending-999999`])).toBe("");

			// A SIGKILL/replacement can leave bbffbee1's v2 file and directory
			// shapes. They are retired only by PREPARE on the restarted container.
			const v2Owner = "1 999999 1 0123456789abcdef0123456789abcdef";
			const v2Suffix = "1-999999-1-0123456789abcdef0123456789abcdef";
			docker(["exec", "-u", "root", name, "sh", "-ceu", `printf '${v2Owner}\\n' > ${lifecycle}/.bobbit-sdk-state-migration-lock-v2; chmod 600 ${lifecycle}/.bobbit-sdk-state-migration-lock-v2; printf '${v2Owner}\\n' > ${lifecycle}/.bobbit-sdk-state-migration-intent-v2-${v2Suffix}; chmod 600 ${lifecycle}/.bobbit-sdk-state-migration-intent-v2-${v2Suffix}; install -d -m 700 ${lifecycle}/.bobbit-sdk-state-migration-pending-v2-${v2Suffix}`]);
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("invalid");
			docker(["restart", name]);
			await (sandbox as any)._prepareClaudeAgentSdkStateParent(name);
			expect(docker(["exec", "-u", "root", name, "sh", "-ceu", `test ! -e ${lifecycle}/.bobbit-sdk-state-migration-lock-v2; test ! -e ${lifecycle}/.bobbit-sdk-state-migration-intent-v2-${v2Suffix}; test ! -e ${lifecycle}/.bobbit-sdk-state-migration-pending-v2-${v2Suffix}`])).toBe("");

			// Shared intent remains held by both the active writer and a queued
			// writer. VERIFY cannot overtake either phase of the migration handoff.
			const intent = `${lifecycle}/.bobbit-sdk-state-migration-intent-lock-v3`;
			const migration = `${lifecycle}/.bobbit-sdk-state-migration-lock-v3`;
			docker(["exec", "-d", "-u", "root", name, "sh", "-ceu", `exec 8<${intent}; flock -s 8; exec 9<${migration}; flock -x 9; : > /tmp/sdk-active-ready; while test ! -e /tmp/sdk-active-release; do sleep 1; done`]);
			docker(["exec", "-u", "root", name, "sh", "-ceu", "for _ in $(seq 1 50); do test -f /tmp/sdk-active-ready && exit 0; sleep 0.1; done; exit 1"]);
			docker(["exec", "-d", "-u", "root", name, "sh", "-ceu", `exec 8<${intent}; flock -s 8; : > /tmp/sdk-queued-ready; while test ! -e /tmp/sdk-queued-release; do sleep 1; done`]);
			docker(["exec", "-u", "root", name, "sh", "-ceu", "for _ in $(seq 1 50); do test -f /tmp/sdk-queued-ready && exit 0; sleep 0.1; done; exit 1"]);
			try {
				expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("busy");
				await expect((sandbox as any)._prepareClaudeAgentSdkStateParent(name)).rejects.toThrow();
				docker(["exec", "-u", "root", name, "touch", "/tmp/sdk-active-release"]);
				docker(["exec", "-u", "root", name, "sh", "-ceu", `for _ in $(seq 1 50); do flock -n -x ${migration} -c true && exit 0; sleep 0.1; done; exit 1`]);
				expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("busy");
			} finally {
				try { docker(["exec", "-u", "root", name, "sh", "-c", "touch /tmp/sdk-active-release /tmp/sdk-queued-release"]); } catch { /* best-effort detached holder cleanup */ }
			}
			docker(["exec", "-u", "root", name, "sh", "-ceu", `for _ in $(seq 1 50); do flock -n -x ${intent} -c true && exit 0; sleep 0.1; done; exit 1`]);
			expect(await (sandbox as any)._getClaudeAgentSdkStateParentStatus(name)).toBe("secure");
			expect(docker(["exec", "-u", "bobbit-sdk", name, "cat", "/bobbit-state/claude-agent-sdk/legacy-session/history"])).toBe("legacy-history");
			expect(() => docker(["exec", "-u", "node", name, "sh", "-c", "mv /bobbit-state/claude-agent-sdk/legacy-session /tmp/replaced; ln -s /tmp/replaced /bobbit-state/claude-agent-sdk/legacy-session"])).toThrow();
			// A replacement container reuses the private named volume, preserving
			// dormant history without leaving root-owned host project state behind.
			docker(["rm", "-f", name]);
			docker(["run", "-d", "--name", replacement, "-v", `${stateVolume}:/bobbit-state/claude-agent-sdk`, SANDBOX_IMAGE, "sleep", "infinity"]);
			expect(docker(["exec", "-u", "bobbit-sdk", replacement, "cat", "/bobbit-state/claude-agent-sdk/legacy-session/history"])).toBe("legacy-history");
			docker(["restart", replacement]);
			expect(docker(["exec", "-u", "bobbit-sdk", replacement, "cat", "/bobbit-state/claude-agent-sdk/legacy-session/history"])).toBe("legacy-history");
		} finally {
			try { docker(["rm", "-f", name]); } catch { /* test cleanup */ }
			try { docker(["rm", "-f", replacement]); } catch { /* test cleanup */ }
			try { docker(["volume", "rm", "-f", stateVolume]); } catch { /* test cleanup */ }
		}
	});

	test("keeps an OAuth-bearing SDK process outside the tool UID while workspace and SDK state survive restart", () => {
		const imageHasSdkUser = isDockerSandboxAvailable() && (() => {
			try {
				execFileSync("docker", ["run", "--rm", SANDBOX_IMAGE, "id", "-u", "bobbit-sdk"], { stdio: "ignore", timeout: 10_000 });
				return true;
			} catch { return false; }
		})();
		test.skip(!imageHasSdkUser, "requires a locally rebuilt bobbit-agent image with the SDK user");
		const name = `bobbit-sdk-uid-${randomUUID().slice(0, 8)}`;
		const sentinel = `sdk-proc-${randomUUID()}`;
		const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000 });
		try {
			docker(["run", "-d", "--name", name, SANDBOX_IMAGE, "sleep", "infinity"]);
			docker(["exec", "-u", "root", name, "install", "-d", "-o", "bobbit-sdk", "-g", "bobbit-sdk", "-m", "700", "/bobbit-state/claude-agent-sdk/sentinel"]);
			docker(["exec", "-d", "-u", "bobbit-sdk", "-e", `CLAUDE_CODE_OAUTH_TOKEN=${sentinel}`, name, "sh", "-c", "printf sdk-history > /bobbit-state/claude-agent-sdk/sentinel/history; exec sleep 30"]);
			// Positive control: the separate SDK UID can see its own live process
			// environment, so the following node-UID negative check is meaningful.
			expect(docker(["exec", "-u", "bobbit-sdk", name, "sh", "-c", "for p in /proc/[0-9]*/environ; do if grep -azq '^CLAUDE_CODE_OAUTH_TOKEN=' \"$p\" 2>/dev/null; then printf owned-env-readable; exit 0; fi; done; exit 1"])).toBe("owned-env-readable");

			// An allowed tool shell scans all peer process environments. It must not
			// observe even the secret variable name from the separate SDK UID.
			const scan = docker(["exec", "-u", "node", name, "sh", "-c", "for p in /proc/[0-9]*/environ; do grep -azl '^CLAUDE_CODE_OAUTH_TOKEN=' \"$p\" 2>/dev/null || true; done"]);
			expect(scan).toBe("");
			expect(scan).not.toContain(sentinel);
			docker(["exec", "-u", "node", name, "sh", "-c", "printf workspace-ok > /workspace/sdk-uid-workspace; test \"$(cat /workspace/sdk-uid-workspace)\" = workspace-ok"]);

			// A model-controlled workspace can swap a lexically valid path for a
			// symlink to SDK state. Workspace preparation runs as node, so Docker's
			// resolved CWD remains inaccessible and cannot widen the private config.
			docker(["exec", "-u", "root", name, "ln", "-s", "/bobbit-state/claude-agent-sdk/sentinel", "/workspace/sdk-uid-trap"]);
			const beforePrivateState = docker(["exec", "-u", "root", name, "sh", "-c", "stat -c '%a:%u:%g' /bobbit-state/claude-agent-sdk/sentinel /bobbit-state/claude-agent-sdk/sentinel/history; cat /bobbit-state/claude-agent-sdk/sentinel/history"]);
			expect(() => docker(["exec", "-u", "node", "-w", "/workspace/sdk-uid-trap", name, "chgrp", "-R", "bobbit-sdk", "."])).toThrow();
			expect(docker(["exec", "-u", "root", name, "sh", "-c", "stat -c '%a:%u:%g' /bobbit-state/claude-agent-sdk/sentinel /bobbit-state/claude-agent-sdk/sentinel/history; cat /bobbit-state/claude-agent-sdk/sentinel/history"])).toBe(beforePrivateState);

			docker(["restart", name]);
			expect(docker(["exec", "-u", "bobbit-sdk", name, "cat", "/bobbit-state/claude-agent-sdk/sentinel/history"])).toBe("sdk-history");
			expect(docker(["exec", "-u", "node", name, "cat", "/workspace/sdk-uid-workspace"])).toBe("workspace-ok");
		} finally {
			try { docker(["rm", "-f", name]); } catch { /* test cleanup */ }
		}
	});
});
