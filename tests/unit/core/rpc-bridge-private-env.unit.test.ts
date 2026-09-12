import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { resetAgentDirStateForTests } from "../../../src/server/bobbit-dir.js";
import { RpcBridge } from "../../../src/server/agent/rpc-bridge.js";
import { publicAgentCaCertPath } from "../../../src/server/agent/agent-process-env.js";
import { withEnv } from "../../../tests/support/harnesses/shared/with-env.js";

const roots: string[] = [];
const immediateClock = {
	now: () => 0,
	setTimeout(callback: () => void) { callback(); return {} as any; },
	setInterval() { return {} as any; },
	clearTimeout() {},
	clearInterval() {},
};

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-private-agent-env-"));
	roots.push(root);
	return root;
}

function stableChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		pid: 123,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => true,
	});
	return child;
}

function containsPath(value: unknown, candidate: string): boolean {
	const haystack = JSON.stringify(value);
	return process.platform === "win32"
		? haystack.toLocaleLowerCase("en-US").includes(candidate.toLocaleLowerCase("en-US"))
		: haystack.includes(candidate);
}

afterEach(() => {
	resetAgentDirStateForTests();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RpcBridge private server environment boundary", () => {
	it("publishes only the public CA copy and strips inherited and option private locators from direct agents", async () => {
		const root = temporaryRoot();
		const headquarters = path.join(root, "headquarters");
		const privateRoot = path.join(root, "private-server-secrets");
		const agentRoot = path.join(root, "agent-public");
		const privateCa = path.join(privateRoot, "tls", "ca.crt");
		const verifier = path.join(privateRoot, "mcp-operator-authorization.json");
		fs.mkdirSync(path.dirname(privateCa), { recursive: true });
		fs.writeFileSync(privateCa, "PUBLIC CA ONLY\n", "utf8");
		fs.writeFileSync(verifier, "operator-verifier-must-stay-private\n", "utf8");

		await withEnv({
			BOBBIT_DIR: headquarters,
			BOBBIT_AGENT_DIR: agentRoot,
			BOBBIT_SECRETS_DIR: privateRoot,
			NODE_EXTRA_CA_CERTS: privateCa,
		}, async () => {
			resetAgentDirStateForTests();
			let capturedEnv: NodeJS.ProcessEnv | undefined;
			const bridge = new RpcBridge({
				cliPath: path.join(root, "pi-cli.js"),
				cwd: root,
				args: ["--no-extensions"],
				gatewayToken: "scoped-agent-token",
				gatewayUrl: "https://127.0.0.1:7443",
				env: {
					BOBBIT_SESSION_ID: "session-direct",
					BOBBIT_SESSION_SECRET: "session-capability",
					BOBBIT_SECRETS_DIR: path.join(privateRoot, "caller-reintroduced"),
					NODE_EXTRA_CA_CERTS: path.join(privateRoot, "caller-ca.pem"),
				},
				clock: immediateClock,
			}, {
				spawnDirect: ((_command: string, _args: readonly string[] = [], options?: SpawnOptions) => {
					capturedEnv = options?.env;
					return stableChild();
				}) as typeof import("node:child_process").spawn,
			});

			await bridge.start();
			expect(capturedEnv).toBeDefined();
			expect(Object.keys(capturedEnv!).some((key) => key.toLocaleUpperCase("en-US") === "BOBBIT_SECRETS_DIR")).toBe(false);
			expect(containsPath(capturedEnv, privateRoot)).toBe(false);
			expect(containsPath(capturedEnv, verifier)).toBe(false);
			expect(capturedEnv!.NODE_EXTRA_CA_CERTS).toBe(publicAgentCaCertPath());
			expect(capturedEnv!.NODE_EXTRA_CA_CERTS).not.toBe(privateCa);
			expect(fs.readFileSync(publicAgentCaCertPath(), "utf8")).toBe("PUBLIC CA ONLY\n");
			expect(capturedEnv!.BOBBIT_TOKEN).toBe("scoped-agent-token");
			expect(capturedEnv!.BOBBIT_GATEWAY_URL).toBe("https://127.0.0.1:7443");
			expect(capturedEnv!.BOBBIT_SESSION_ID).toBe("session-direct");
			expect(capturedEnv!.BOBBIT_SESSION_SECRET).toBe("session-capability");
		});
	});

	it("strips private locators from Docker host and agent projections while retaining scoped gateway wiring", async () => {
		const root = temporaryRoot();
		const privateRoot = path.join(root, "private-server-secrets");
		const privateCa = path.join(privateRoot, "tls", "ca.crt");
		const verifier = path.join(privateRoot, "mcp-operator-authorization.json");

		await withEnv({
			BOBBIT_DIR: path.join(root, "headquarters"),
			BOBBIT_AGENT_DIR: path.join(root, "agent-public"),
			BOBBIT_SECRETS_DIR: privateRoot,
			NODE_EXTRA_CA_CERTS: privateCa,
		}, async () => {
			resetAgentDirStateForTests();
			let capturedArgs: string[] = [];
			let capturedEnv: NodeJS.ProcessEnv | undefined;
			const bridge = new RpcBridge({
				containerId: "container-private-env",
				sessionId: "session-docker",
				cwd: "/workspace",
				args: ["--no-extensions"],
				gatewayToken: "scoped-sandbox-token",
				gatewayUrl: "https://host.docker.internal:7443",
				env: {
					BOBBIT_SESSION_ID: "session-docker",
					BOBBIT_SESSION_SECRET: "sandbox-session-capability",
					BOBBIT_SECRETS_DIR: verifier,
					NODE_EXTRA_CA_CERTS: privateCa,
				},
				sandboxCredentials: {
					BOBBIT_SECRETS_DIR: privateRoot,
					NODE_EXTRA_CA_CERTS: privateCa,
					SAFE_PROVIDER_API_KEY: "provider-key",
				},
				clock: immediateClock,
			}, {
				spawnDocker: ((_command: string, args: readonly string[] = [], options?: SpawnOptions) => {
					capturedArgs = [...args];
					capturedEnv = options?.env;
					return stableChild();
				}) as typeof import("node:child_process").spawn,
			});

			await bridge.start();
			expect(containsPath(capturedArgs, privateRoot)).toBe(false);
			expect(containsPath(capturedArgs, verifier)).toBe(false);
			expect(containsPath(capturedEnv, privateRoot)).toBe(false);
			expect(Object.keys(capturedEnv!).some((key) => key.toLocaleUpperCase("en-US") === "BOBBIT_SECRETS_DIR")).toBe(false);
			expect(capturedArgs).toContain("BOBBIT_TOKEN=scoped-sandbox-token");
			expect(capturedArgs).toContain("BOBBIT_GATEWAY_URL=https://host.docker.internal:7443");
			expect(capturedArgs).toContain("BOBBIT_SESSION_ID=session-docker");
			expect(capturedArgs).toContain("BOBBIT_SESSION_SECRET=sandbox-session-capability");
			expect(capturedArgs).toContain("SAFE_PROVIDER_API_KEY=provider-key");

			const containerIndex = capturedArgs.indexOf("container-private-env");
			expect(capturedArgs.slice(containerIndex, containerIndex + 8)).toEqual([
				"container-private-env",
				"env", "-u", "BOBBIT_SECRETS_DIR", "-u", "NODE_EXTRA_CA_CERTS",
				"node", "--disable-warning=DEP0123",
			]);
		});
	});
});
