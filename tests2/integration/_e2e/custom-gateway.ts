/**
 * Custom-layout gateway boot for v2-integration ports that need a DEDICATED
 * gateway with a bespoke on-disk layout (same-root Headquarters split, override
 * BOBBIT_DIR, restart persistence) — i.e. tests the fork-scoped singleton
 * (tests2/harness/gateway.ts) cannot express.
 *
 * Mirrors the durable parts of tests/e2e/headquarters-api.spec.ts's
 * startHeadquartersGateway / headquarters-server-scope-guards.ts's startGateway,
 * but boots from `src/` with GatewayDeps (fenced CommandRunner/fetch, manual
 * clock, in-process mock bridge) instead of `BOBBIT_TEST_*` / `BOBBIT_SKIP_*`
 * env flags.
 *
 * Each boot snapshots and restores every env var + setProjectRoot() +
 * resetAgentDirStateForTests() it mutates, so it is safe inside a shared
 * (isolate:false) fork alongside the singleton gateway: during a boot's lifetime
 * no other gateway serves requests, and teardown returns global module state to
 * exactly what it was.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setProjectRoot, getProjectRoot, resetAgentDirStateForTests } from "../../../src/server/bobbit-dir.js";
import { scaffoldBobbitDir } from "../../../src/server/scaffold.js";
import { loadOrCreateToken } from "../../../src/server/auth/token.js";
import type { GatewayDeps } from "../../../src/server/gateway-deps.js";
import { createManualClock } from "../../harness/clock.js";
import { createFencedCommandRunner } from "../../harness/fenced-command-runner.js";
import { createFencedFetch } from "../../harness/fenced-fetch.js";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, "..", "..", "..");
const MOCK_AGENT = resolve(REPO_ROOT, "tests", "e2e", "mock-agent.mjs");
const BUILTINS_DIR = resolve(REPO_ROOT, "defaults");
const MOCK_BRIDGE_SPECIFIER = new URL("../../../tests/e2e/in-process-mock-bridge.mjs", import.meta.url).href;

const ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_PI_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_GATEWAY_URL",
	"BOBBIT_TOKEN",
] as const;

export interface CustomGatewayHandle {
	baseURL: string;
	token: string;
	serverRoot: string;
	headquartersDir: string;
	agentDir: string;
	request(path: string, init?: RequestInit): Promise<Response>;
	json(path: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }>;
	shutdown(): Promise<void>;
}

export interface CustomGatewayOptions {
	serverRoot: string;
	/** When set, overrides the Headquarters directory itself (BOBBIT_DIR). Default HQ = <serverRoot>/.bobbit/headquarters. */
	headquartersDir?: string;
	agentDir?: string;
	/** Provide builtin tools/roles (defaults/) so config-store cascade works. Default true. */
	builtins?: boolean;
}

async function makeDeps(): Promise<GatewayDeps> {
	const mockBridge: any = await import(MOCK_BRIDGE_SPECIFIER);
	const agentBridgeFactory: GatewayDeps["agentBridgeFactory"] = (opts: any) => {
		if (mockBridge.shouldUseInProcessMock(opts.cliPath)) return new mockBridge.InProcessMockBridge(opts);
		return null;
	};
	return {
		clock: createManualClock(),
		commandRunner: createFencedCommandRunner(),
		fetchImpl: createFencedFetch(),
		agentBridgeFactory,
	};
}

/**
 * Boot a dedicated gateway at `serverRoot`. Snapshots env + projectRoot before
 * mutating and restores both on shutdown().
 */
export async function startCustomGateway(opts: CustomGatewayOptions): Promise<CustomGatewayHandle> {
	const serverRoot = realpathSync(opts.serverRoot);
	const usesOverride = opts.headquartersDir !== undefined;
	const headquartersDir = usesOverride ? opts.headquartersDir! : resolve(serverRoot, ".bobbit", "headquarters");
	const agentDir = opts.agentDir ?? resolve(serverRoot, ".agent");

	const savedEnv = new Map<string, string | undefined>();
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
	const previousProjectRoot = getProjectRoot();

	resetAgentDirStateForTests?.();
	if (usesOverride) process.env.BOBBIT_DIR = headquartersDir;
	else delete process.env.BOBBIT_DIR;
	// Isolate live server secrets so they never land in the real OS home dir.
	process.env.BOBBIT_SECRETS_DIR = resolve(serverRoot, ".bobbit-secrets");
	delete process.env.BOBBIT_PI_DIR;
	process.env.BOBBIT_AGENT_DIR = agentDir;
	delete process.env.BOBBIT_GATEWAY_URL;
	delete process.env.BOBBIT_TOKEN;

	mkdirSync(serverRoot, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	setProjectRoot(serverRoot);

	const deps = await makeDeps();
	const { createGateway } = await import("../../../src/server/server.js");
	const { configureAigwRuntimeFlags } = await import("../../../src/server/agent/aigw-manager.js");

	scaffoldBobbitDir(serverRoot);
	const token = loadOrCreateToken();

	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: serverRoot,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
		skipMcp: true,
		skipWorktreePool: true,
		skipTitleGeneration: true,
		skipRemotePush: true,
		skipNonLocalRemoteGit: true,
		...(opts.builtins === false ? {} : { builtinsDir: BUILTINS_DIR }),
	}, deps);
	configureAigwRuntimeFlags({ skipAigwDiscovery: true, testNoExternal: true, e2e: true });

	const port = await gw.start();
	const baseURL = `http://127.0.0.1:${port}`;
	writeFileSync(resolve(headquartersDir, "state", "gateway-url"), baseURL, "utf-8");
	process.env.BOBBIT_GATEWAY_URL = baseURL;
	process.env.BOBBIT_TOKEN = token;

	const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init.headers as Record<string, string> | undefined),
		},
	});
	const json = async (path: string, init: RequestInit = {}) => {
		const resp = await request(path, init);
		const text = await resp.text();
		let body: any;
		try { body = text ? JSON.parse(text) : null; } catch { body = null; }
		return { status: resp.status, body, text };
	};

	return {
		baseURL,
		token,
		serverRoot,
		headquartersDir,
		agentDir,
		request,
		json,
		async shutdown() {
			try { await gw.shutdown(); }
			finally {
				resetAgentDirStateForTests?.();
				setProjectRoot(previousProjectRoot);
				for (const key of ENV_KEYS) {
					const prev = savedEnv.get(key);
					if (prev === undefined) delete process.env[key];
					else process.env[key] = prev;
				}
			}
		},
	};
}

export { rmSync };
