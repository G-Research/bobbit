import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeAgentSdkEnv } from "../../src/server/agent/claude-agent-sdk-bridge.ts";
import { SANDBOX_SDK_MODULE_PATH } from "../../src/server/agent/claude-agent-sdk-session-access.ts";
import { createClaudeSdkDockerSpawn, redactDockerArgs, spawnDockerExec } from "../../src/server/agent/docker-exec-spawn.ts";
import {
	ClaudeAgentSdkDirectAuthUnavailableError,
	ClaudeAgentSdkSandboxAuthUnavailableError,
	resolveDirectClaudeAgentSdkOAuthAccessToken,
	resolveSandboxClaudeAgentSdkOAuthAccessToken,
} from "../../src/server/agent/host-tokens.ts";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.ts";
import { CLAUDE_AGENT_SDK_SANDBOX_CLAUDE_VERSION, CLAUDE_AGENT_SDK_SANDBOX_VERSION, ProjectSandbox } from "../../src/server/agent/project-sandbox.ts";

const originalAgentDir = process.env.BOBBIT_AGENT_DIR;
let authRoot: string | undefined;

function dockerChild({ pipes = true }: { pipes?: boolean } = {}): any {
	const child = new EventEmitter() as any;
	child.stdin = pipes ? new PassThrough() : null;
	child.stdout = pipes ? new PassThrough() : null;
	child.stderr = new PassThrough();
	child.killed = false;
	child.exitCode = null;
	child.signalCode = null;
	child.kill = vi.fn((signal?: string) => {
		child.killed = true;
		child.signalCode = signal ?? "SIGTERM";
		return true;
	});
	return child;
}

function installHostAuth(anthropic: unknown): void {
	if (authRoot) rmSync(authRoot, { recursive: true, force: true });
	authRoot = mkdtempSync(path.join(tmpdir(), "claude-sdk-sandbox-auth-"));
	process.env.BOBBIT_AGENT_DIR = path.join(authRoot, "agent");
	resetAgentDirStateForTests();
	mkdirSync(process.env.BOBBIT_AGENT_DIR, { recursive: true });
	writeFileSync(path.join(process.env.BOBBIT_AGENT_DIR, "auth.json"), JSON.stringify({ anthropic }));
}

afterEach(() => {
	vi.restoreAllMocks();
	if (authRoot) rmSync(authRoot, { recursive: true, force: true });
	authRoot = undefined;
	if (originalAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = originalAgentDir;
	resetAgentDirStateForTests();
});

describe("Claude Agent SDK sandbox spawn", () => {
	it("executes only the image-pinned wrapper with opaque SDK args and an allowlisted environment", () => {
		const child = dockerChild();
		let dockerSpawnCall: [command: string, args: string[], options: { stdio?: unknown }] | undefined;
		const spawn = vi.fn((command: string, args: string[], options: { stdio?: unknown }) => {
			dockerSpawnCall = [command, args, options];
			return child;
		});
		const launch = createClaudeSdkDockerSpawn({
			containerId: "sandbox-current",
			cwd: "/workspace-wt/team/session",
			env: {
			HOME: "/home/bobbit-sdk",
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			TMPDIR: "/tmp",
			LANG: "C.UTF-8",
			BOBBIT_SESSION_ID: "session-1",
			BOBBIT_TOKEN: "scoped-gateway-token",
			BOBBIT_GATEWAY_URL: "http://gateway.test",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth-access-token",
			CLAUDE_CONFIG_DIR: "/bobbit-state/claude-agent-sdk/session-1",
			CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
			UNDEFINED_VALUE: undefined,
			"invalid-name": "ignored",
		},
			command: ["/usr/local/bin/bobbit-claude-agent-sdk"],
			spawn: spawn as any,
		});
		const controller = new AbortController();
		const process = launch({
			args: ["--sdk-owned-flag", "value", "--extension", "/not-pi-remapped"],
			env: {
				ANTHROPIC_API_KEY: "must-not-forward",
				ANTHROPIC_AUTH_TOKEN: "must-not-forward",
				CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit-sdk",
				CLAUDE_AGENT_SDK_VERSION: "0.3.222",
				CLAUDE_CODE_ENTRYPOINT: "sdk",
				HOST_SECRET: "must-not-forward",
			},
			signal: controller.signal,
			command: "attacker-controlled-command",
		} as any);

		expect(spawn).toHaveBeenCalledOnce();
		if (!dockerSpawnCall) throw new Error("Expected Docker spawn arguments to be captured");
		const [bin, args, options] = dockerSpawnCall;
		expect(bin).toBe("docker");
		expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
		expect(args).toEqual([
			"exec", "-i", "-u", "bobbit-sdk",
			"-e", "HOME=/home/bobbit-sdk",
			"-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"-e", "TMPDIR=/tmp",
			"-e", "LANG=C.UTF-8",
			"-e", "BOBBIT_SESSION_ID=session-1",
			"-e", "BOBBIT_TOKEN=scoped-gateway-token",
			"-e", "BOBBIT_GATEWAY_URL=http://gateway.test",
			"-e", "CLAUDE_CODE_OAUTH_TOKEN=oauth-access-token",
			"-e", "CLAUDE_CONFIG_DIR=/bobbit-state/claude-agent-sdk/session-1",
			"-e", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1",
			"-e", "CLAUDE_AGENT_SDK_CLIENT_APP=bobbit-sdk",
			"-e", "CLAUDE_AGENT_SDK_VERSION=0.3.222",
			"-e", "CLAUDE_CODE_ENTRYPOINT=sdk",
			"-w", "/workspace-wt/team/session", "sandbox-current",
			"/usr/local/bin/bobbit-claude-agent-sdk",
			"--sdk-owned-flag", "value", "--extension", "/not-pi-remapped",
		]);
		expect(args.join(" ")).not.toContain("must-not-forward");
		expect(args).not.toContain("attacker-controlled-command");
		expect(process.stdin).toBe(child.stdin);
		expect(process.stdout).toBe(child.stdout);
	});

	it("uses a closed SDK environment with deterministic state and no host credential inheritance", () => {
		const env = buildClaudeAgentSdkEnv({
			env: { ANTHROPIC_API_KEY: "host-key", BOBBIT_TOKEN: "host-token", PATH: "/host/path" },
			claudeSdkSandboxLaunch: {
				containerId: "sandbox", cwd: "/workspace", sessionId: "session-closed", sessionSecret: "session-secret",
				gatewayToken: "gateway-token", gatewayUrl: "http://gateway.test", oauthAccessToken: "oauth-access",
			},
		});
		expect(env).toEqual({
			HOME: "/home/bobbit-sdk",
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			TMPDIR: "/tmp",
			LANG: "C.UTF-8",
			BOBBIT_SESSION_ID: "session-closed",
			BOBBIT_SESSION_SECRET: "session-secret",
			CLAUDE_CONFIG_DIR: "/bobbit-state/claude-agent-sdk/session-closed",
			CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit",
			CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
		});
		expect(JSON.stringify(env)).not.toContain("host-key");
		expect(JSON.stringify(env)).not.toContain("gateway-token");
		expect(JSON.stringify(env)).not.toContain("oauth-access");
	});

	it("delegates process lifecycle and removes its abort listener on child settlement", () => {
		const child = dockerChild();
		const spawn = vi.fn(() => child);
		const controller = new AbortController();
		const process = createClaudeSdkDockerSpawn({
			containerId: "sandbox", cwd: "/workspace", env: {}, command: ["/usr/local/bin/bobbit-claude-agent-sdk"], spawn: spawn as any,
		})({ args: [], env: {}, signal: controller.signal } as any);

		expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
		expect(() => child.stdin.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }))).not.toThrow();
		expect(() => child.stdin.emit("error", Object.assign(new Error("destroyed stream"), { code: "ERR_STREAM_DESTROYED" }))).not.toThrow();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(() => child.stdin.emit("error", Object.assign(new Error("secret must not appear"), { code: "ECONNRESET" }))).not.toThrow();
		expect(warn).toHaveBeenCalledWith("[docker-exec] stdin error: ECONNRESET");
		expect(warn.mock.calls.flat().join(" ")).not.toContain("secret must not appear");
		expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
		child.stderr.write(Buffer.alloc(65 * 1024, "x"));
		expect(child.stderr.readableLength).toBe(0);

		process.kill("SIGKILL");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		child.emit("exit", 0, null);
		controller.abort();
		expect(child.kill).toHaveBeenCalledTimes(1);

		const abortingChild = dockerChild();
		const abortingController = new AbortController();
		createClaudeSdkDockerSpawn({
			containerId: "sandbox", cwd: "/workspace", env: {}, command: ["/usr/local/bin/bobbit-claude-agent-sdk"], spawn: (() => abortingChild) as any,
		})({ args: [], env: {}, signal: abortingController.signal } as any);
		abortingController.abort();
		expect(abortingChild.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("fails before spawn for invalid container paths and terminates children with missing pipe stdio", () => {
		const spawn = vi.fn(() => dockerChild());
		expect(() => spawnDockerExec({
			containerId: "sandbox", cwd: "/workspace", env: {}, command: ["command"], user: "root" as any, spawn: spawn as any,
		})).toThrow("Docker sandbox execution user is invalid");
		expect(() => spawnDockerExec({
			containerId: "sandbox", cwd: "/host/project", env: {}, command: ["command"], spawn: spawn as any,
		})).toThrow("Docker sandbox working directory is invalid");
		expect(() => spawnDockerExec({
			containerId: "sandbox", cwd: "/workspace/../../host", env: {}, command: ["command"], spawn: spawn as any,
		})).toThrow("Docker sandbox working directory is invalid");
		expect(spawn).not.toHaveBeenCalled();

		const pipeFailure = dockerChild({ pipes: false });
		expect(() => createClaudeSdkDockerSpawn({
			containerId: "sandbox", cwd: "/workspace", env: {}, command: ["/usr/local/bin/bobbit-claude-agent-sdk"], spawn: (() => pipeFailure) as any,
		})({ args: [], env: {}, signal: new AbortController().signal } as any)).toThrow("did not provide pipe stdio");
		expect(pipeFailure.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("redacts every supported credential form from docker diagnostics", () => {
		const secretArgs = [
			"exec", "-e", "CLAUDE_CODE_OAUTH_TOKEN=oauth-secret", "-e", "ANTHROPIC_API_KEY=api-secret",
			"-e", "BOBBIT_TOKEN", "gateway-secret", "-e", "AWS_SECRET=cloud-secret",
		];
		const rendered = redactDockerArgs(secretArgs);
		expect(rendered).toContain("CLAUDE_CODE_OAUTH_TOKEN=<REDACTED>");
		expect(rendered).toContain("ANTHROPIC_API_KEY=<REDACTED>");
		expect(rendered).toContain("BOBBIT_TOKEN <REDACTED>");
		expect(rendered).not.toMatch(/oauth-secret|api-secret|gateway-secret|cloud-secret/);

		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		let toolArgs: string[] = [];
		spawnDockerExec({
			containerId: "sandbox", cwd: "/workspace", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" }, command: ["command"],
			spawn: ((_command: string, args: string[]) => { toolArgs = args; return dockerChild(); }) as any,
		});
		expect(toolArgs).not.toContain("-u");
		expect(log.mock.calls.join(" ")).not.toContain("oauth-secret");
	});

	it("requires Bobbit OAuth for direct sessions and explicit policy for Docker", async () => {
		await expect(resolveSandboxClaudeAgentSdkOAuthAccessToken({ entries: [] })).rejects.toBeInstanceOf(ClaudeAgentSdkSandboxAuthUnavailableError);
		await expect(resolveSandboxClaudeAgentSdkOAuthAccessToken({
			entries: [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true, value: "project-api-key" }],
		})).rejects.toMatchObject({ code: "CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE" });

		installHostAuth({ type: "api_key", key: "host-api-key" });
		await expect(resolveDirectClaudeAgentSdkOAuthAccessToken()).rejects.toBeInstanceOf(ClaudeAgentSdkDirectAuthUnavailableError);
		await expect(resolveSandboxClaudeAgentSdkOAuthAccessToken({
			entries: [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		})).rejects.toMatchObject({
			code: "CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE",
			message: expect.not.stringContaining("host-api-key"),
		});

		installHostAuth({ type: "oauth", access: "current-access-only", refresh: "renewable-host-secret", expires: Date.now() + 60_000 });
		await expect(resolveDirectClaudeAgentSdkOAuthAccessToken()).resolves.toBe("current-access-only");
		await expect(resolveSandboxClaudeAgentSdkOAuthAccessToken({
			entries: [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		})).resolves.toBe("current-access-only");
	});

	it("fails closed unless the image label and fixed SDK wrapper both match", async () => {
		const sandbox = new ProjectSandbox({ projectId: "sdk-capability", projectDir: "/host/project", repoUrl: "https://example.test/repo.git", image: "bobbit:test" });
		(sandbox as any).containerId = "container-current";
		const inspect = vi.fn(async (args: string[]) => ({
			stdout: args[0] === "image"
				? `${CLAUDE_AGENT_SDK_SANDBOX_VERSION}\n`
				: args.includes("bobbit-claude-agent-sdk")
					? `${CLAUDE_AGENT_SDK_SANDBOX_CLAUDE_VERSION} (Claude Code)\n`
					: "",
			stderr: "",
		}));
		const wrapper = vi.fn(async (_containerId: string, args: string[]) => args[0] === "id" ? "1001\n" : "");
		(sandbox as any).execDocker = inspect;
		(sandbox as any)._dockerExec = wrapper;
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(true);
		expect(inspect).toHaveBeenNthCalledWith(1, expect.arrayContaining(["image", "inspect", "--format"]), expect.any(Object));
		expect(inspect).toHaveBeenNthCalledWith(2, ["exec", "-i", "-u", "bobbit-sdk", "container-current", "/usr/local/bin/bobbit-claude-agent-sdk", "--version"], expect.objectContaining({ timeout: 5_000 }));
		expect(inspect).toHaveBeenNthCalledWith(3, ["exec", "-i", "-u", "bobbit-sdk", "container-current", "test", "-r", SANDBOX_SDK_MODULE_PATH], expect.objectContaining({ timeout: 5_000 }));
		expect(wrapper).toHaveBeenNthCalledWith(1, "container-current", ["test", "-x", "/usr/local/bin/bobbit-claude-agent-sdk"], { timeout: 5_000 });
		expect(wrapper).toHaveBeenNthCalledWith(2, "container-current", ["id", "-u", "bobbit-sdk"], { timeout: 5_000 });

		(sandbox as any).execDocker = async () => ({ stdout: "0.3.221\n", stderr: "" });
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
		(sandbox as any).execDocker = async (args: string[]) => ({
			stdout: args[0] === "image" ? `${CLAUDE_AGENT_SDK_SANDBOX_VERSION}\n` : "2.1.221 (Claude Code)\n",
			stderr: "",
		});
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
		(sandbox as any).execDocker = async (args: string[]) => {
			if (args.includes("bobbit-claude-agent-sdk")) throw Object.assign(new Error("wrapper exited"), { code: 127, stdout: "secret", stderr: "secret" });
			return { stdout: `${CLAUDE_AGENT_SDK_SANDBOX_VERSION}\n`, stderr: "" };
		};
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
		(sandbox as any).execDocker = async (args: string[]) => {
			if (args.includes(SANDBOX_SDK_MODULE_PATH)) throw new Error("missing module wrapper");
			return { stdout: args[0] === "image" ? `${CLAUDE_AGENT_SDK_SANDBOX_VERSION}\n` : `${CLAUDE_AGENT_SDK_SANDBOX_CLAUDE_VERSION} (Claude Code)\n`, stderr: "" };
		};
		(sandbox as any)._dockerExec = wrapper;
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
		(sandbox as any).execDocker = inspect;
		(sandbox as any)._dockerExec = async () => { throw new Error("missing launcher wrapper"); };
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
		(sandbox as any)._dockerExec = async (_containerId: string, args: string[]) => args[0] === "id" ? "1000\n" : "";
		await expect(sandbox.hasClaudeAgentSdkCapability()).resolves.toBe(false);
	});
});
