import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCA, createCert } from "mkcert";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	bobbitStateDir,
	getAgentDirState,
	getProjectRoot,
	initializeAgentDirRuntime,
	resetAgentDirStateForTests,
	setProjectRoot,
	type AgentDirRuntimeState,
} from "../../../src/server/bobbit-dir.js";
import { initAuthorSidecarDir } from "../../../src/server/agent/author-sidecar.js";
import { realClock, realCommandRunner, realFs, type GatewayDeps } from "../../../src/server/gateway-deps.js";
import { scaffoldBobbitDir } from "../../../src/server/scaffold.js";
import { createGateway } from "../../../src/server/server.js";
import { createRunChild, removeOwnedRunChild } from "../../../tests/support/harnesses/shared/run-isolation.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TOKEN = `request-admission-config-${"x".repeat(64)}`;
const MOUNT = "/team/bobbit";
const VITE_ORIGIN = "https://localhost:43123";
const ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_LLM_REVIEW_SKIP",
	"BOBBIT_GATEWAY_URL",
	"NODE_ENV",
] as const;

interface ProcessStateSnapshot {
	env: Record<(typeof ENV_KEYS)[number], string | undefined>;
	projectRoot: string;
	agentDirState?: AgentDirRuntimeState;
}

interface RawResponse {
	status: number;
	body: string;
	headers: IncomingHttpHeaders;
}

function captureProcessState(): ProcessStateSnapshot {
	let agentDirState: AgentDirRuntimeState | undefined;
	try { agentDirState = getAgentDirState(); } catch { /* not initialized in a fresh worker */ }
	return {
		env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as ProcessStateSnapshot["env"],
		projectRoot: getProjectRoot(),
		...(agentDirState ? { agentDirState } : {}),
	};
}

function restoreProcessState(snapshot: ProcessStateSnapshot): void {
	for (const key of ENV_KEYS) {
		const previous = snapshot.env[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	setProjectRoot(snapshot.projectRoot);
	resetAgentDirStateForTests();
	if (snapshot.agentDirState) {
		initializeAgentDirRuntime({
			env: process.env,
			projectRoot: snapshot.agentDirState.startup.projectRoot,
			stateDir: bobbitStateDir(snapshot.agentDirState.startup.projectRoot),
			persisted: snapshot.agentDirState.persisted,
		});
	}
	const restoredRoot = snapshot.env.BOBBIT_DIR;
	const restoredSecrets = snapshot.env.BOBBIT_SECRETS_DIR;
	if (restoredRoot && restoredSecrets) {
		initAuthorSidecarDir(join(restoredRoot, "state"), { secretsDir: restoredSecrets });
	}
}

function fencedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw);
		if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return fetch(input, init);
	} catch { /* startup discovery treats an unavailable endpoint as offline */ }
	return Promise.resolve(new Response("network fenced by request-admission config test", { status: 503 }));
}

const gatewayDeps: GatewayDeps = {
	clock: realClock,
	commandRunner: realCommandRunner,
	fetchImpl: fencedFetch,
	agentBridgeFactory: () => null,
	fsImpl: realFs,
};

function request(port: number, path: string, headers: Record<string, string>): Promise<RawResponse> {
	return new Promise((resolveRequest, rejectRequest) => {
		const outgoing = https.request({
			hostname: "127.0.0.1",
			port,
			path,
			method: "GET",
			rejectUnauthorized: false,
			headers: { Connection: "close", ...headers },
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("end", () => resolveRequest({
				status: response.statusCode ?? 0,
				body: Buffer.concat(chunks).toString("utf8"),
				headers: response.headers,
			}));
		});
		outgoing.once("error", rejectRequest);
		outgoing.end();
	});
}

function authorization(token = TOKEN): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function browserHeaders(authority: string, origin: string): Record<string, string> {
	return {
		Host: authority,
		Origin: origin,
		"Sec-Fetch-Site": "same-origin",
		"Sec-Fetch-Mode": "cors",
		...authorization(),
	};
}

describe.sequential("configured request-admission authorities", () => {
	let processState: ProcessStateSnapshot;
	let root: string;
	let port: number;
	let gateway: ReturnType<typeof createGateway>;

	beforeAll(async () => {
		processState = captureProcessState();
		root = createRunChild("request-admission-config");
		const stateDir = join(root, "state");
		const secretsDir = join(root, "secrets");
		const agentDir = join(root, "agent");
		const tlsDir = join(secretsDir, "tls");
		for (const directory of [stateDir, secretsDir, agentDir, tlsDir, join(stateDir, "session-prompts")]) {
			mkdirSync(directory, { recursive: true });
		}
		writeFileSync(join(stateDir, "projects.json"), "[]");
		writeFileSync(join(stateDir, "setup-complete"), "test\n");

		process.env.BOBBIT_DIR = root;
		process.env.BOBBIT_SECRETS_DIR = secretsDir;
		process.env.BOBBIT_AGENT_DIR = agentDir;
		process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
		process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
		process.env.NODE_ENV = "test";
		setProjectRoot(root);
		resetAgentDirStateForTests();
		scaffoldBobbitDir(root);

		const ca = await createCA({
			organization: "Bobbit Request Admission Test",
			countryCode: "US",
			state: "Test",
			locality: "Test",
			validity: 2,
		});
		const leaf = await createCert({
			ca,
			domains: ["localhost", "127.0.0.1", "tls.mesh.example", "published.example"],
			validity: 1,
		});
		const cert = join(tlsDir, "cert.pem");
		const key = join(tlsDir, "key.pem");
		writeFileSync(cert, leaf.cert);
		writeFileSync(key, leaf.key);

		const config = {
			host: "0.0.0.0",
			port: 0,
			portExplicit: true,
			authToken: TOKEN,
			defaultCwd: root,
			basePath: MOUNT,
			forceAuth: true,
			tls: { cert, key },
			publicOrigins: ["https://public.example", "https://100.64.0.8:4443"],
			viteOrigins: [VITE_ORIGIN],
			tlsHostnames: ["tls.mesh.example"],
			onBound: (actualPort: number) => `https://published.example:${actualPort}${MOUNT}`,
			skipMcp: true,
			skipWorktreePool: true,
			skipTitleGeneration: true,
			skipRemotePush: true,
			skipNonLocalRemoteGit: true,
			builtinsDir: join(REPO_ROOT, "defaults"),
			builtinPacksDir: join(REPO_ROOT, "market-packs"),
		} as Parameters<typeof createGateway>[0] & {
			publicOrigins: string[];
			viteOrigins: string[];
			tlsHostnames: string[];
		};
		gateway = createGateway(config, gatewayDeps);
		port = await gateway.start();
	}, 60_000);

	afterAll(async () => {
		try { await gateway?.shutdown(); }
		finally {
			if (processState) restoreProcessState(processState);
			if (root) removeOwnedRunChild(root);
		}
	}, 60_000);

	it("uses the actual ephemeral TLS port for every loopback alias beneath the configured base path", async () => {
		expect(port).toBeGreaterThan(0);
		const authorities = [
			`127.0.0.1:${port}`,
			`LOCALHOST.:${port}`,
			`[0:0:0:0:0:0:0:1]:${port}`,
		];
		for (const authority of authorities) {
			const response = await request(port, `${MOUNT}/api/health`, { Host: authority, ...authorization() });
			expect.soft(response.status, `${authority}: ${response.body}`).toBe(200);
		}

		const unresolvedConfiguredPort = await request(port, `${MOUNT}/api/health`, {
			Host: "127.0.0.1:0",
			...authorization(),
		});
		expect(unresolvedConfiguredPort.status).toBe(403);

		const offMount = await request(port, "/api/health", {
			Host: `127.0.0.1:${port}`,
			...authorization(),
		});
		expect(offMount.status).toBe(404);
	});

	it("accepts configured TLS, published, public-default-port, and mesh authorities", async () => {
		const cases = [
			{ authority: `tls.mesh.example:${port}`, origin: `https://tls.mesh.example:${port}` },
			{ authority: `published.example:${port}`, origin: `https://published.example:${port}` },
			{ authority: "public.example", origin: "https://public.example" },
			{ authority: "100.64.0.8:4443", origin: "https://100.64.0.8:4443" },
		];
		for (const testCase of cases) {
			const response = await request(
				port,
				`${MOUNT}/api/health`,
				browserHeaders(testCase.authority, testCase.origin),
			);
			expect.soft(response.status, `${testCase.authority}: ${response.body}`).toBe(200);
		}
	});

	it("allows only the finite configured Vite origin for the trusted gateway target", async () => {
		const targetAuthority = `127.0.0.1:${port}`;
		const allowed = await request(port, `${MOUNT}/api/health`, browserHeaders(targetAuthority, VITE_ORIGIN));
		expect(allowed.status, allowed.body).toBe(200);
		expect(allowed.headers["access-control-allow-origin"]).toBe(VITE_ORIGIN);

		const unlistedOrigin = "https://localhost:43124";
		const rejected = await request(port, `${MOUNT}/api/health`, browserHeaders(targetAuthority, unlistedOrigin));
		expect(rejected.status).toBe(403);
		expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("keeps originless CLI and sandbox traffic behind authentication", async () => {
		const authority = `localhost:${port}`;
		const admin = await request(port, `${MOUNT}/api/health`, { Host: authority, ...authorization() });
		expect(admin.status, admin.body).toBe(200);

		const unauthenticated = await request(port, `${MOUNT}/api/health`, { Host: authority });
		expect(unauthenticated.status).toBe(401);

		const sandboxToken = (gateway.sessionManager as unknown as {
			sandboxTokenStore: { register(projectId: string): string };
		}).sandboxTokenStore.register("request-admission-sandbox-project");
		const sandbox = await request(port, `${MOUNT}/api/health`, {
			Host: authority,
			...authorization(sandboxToken),
		});
		expect(sandbox.status, sandbox.body).toBe(200);
	});

	it("does not trust wildcard listener or forwarded authorities", async () => {
		const wildcard = await request(port, `${MOUNT}/api/health`, browserHeaders(
			`0.0.0.0:${port}`,
			`https://0.0.0.0:${port}`,
		));
		expect(wildcard.status).toBe(403);

		const forwardedOnly = await request(port, `${MOUNT}/api/health`, {
			Host: `attacker.example:${port}`,
			Forwarded: "host=public.example;proto=https",
			"X-Forwarded-Host": "public.example",
			"X-Forwarded-Proto": "https",
			...authorization(),
		});
		expect(forwardedOnly.status).toBe(403);

		const ignoredHostileForwarding = await request(port, `${MOUNT}/api/health`, {
			Host: `127.0.0.1:${port}`,
			Forwarded: "host=attacker.example;proto=http",
			"X-Forwarded-Host": "attacker.example",
			"X-Forwarded-Proto": "http",
			...authorization(),
		});
		expect(ignoredHostileForwarding.status, ignoredHostileForwarding.body).toBe(200);
	});
});
