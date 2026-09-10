import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createCA, createCert } from "mkcert";
import { WebSocket } from "ws";
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
import { buildStartupUrls } from "../../../src/server/cli.js";
import { createGateway } from "../../../src/server/server.js";
import { createRunChild, removeOwnedRunChild } from "../../../tests/support/harnesses/shared/run-isolation.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TOKEN = `request-admission-config-${"x".repeat(64)}`;
const MOUNT = "/team/bobbit";
const VITE_ORIGIN = "http://127.0.0.1:5173";
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

function plainRequest(
	port: number,
	path: string,
	headers: Record<string, string>,
	method = "GET",
	body?: string,
): Promise<RawResponse> {
	return new Promise((resolveRequest, rejectRequest) => {
		const outgoing = http.request({
			hostname: "127.0.0.1",
			port,
			path,
			method,
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
		outgoing.end(body);
	});
}

function webSocketAuthResult(port: number, token: string): Promise<"auth_ok" | "auth_failed"> {
	return new Promise((resolveResult, rejectResult) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/viewer`, {
			headers: { Host: "public.example" },
		});
		const timer = setTimeout(() => finish(undefined, new Error("WebSocket authentication timed out")), 5_000);
		const finish = (result?: "auth_ok" | "auth_failed", error?: Error): void => {
			clearTimeout(timer);
			ws.removeAllListeners();
			ws.close();
			if (error) rejectResult(error);
			else resolveResult(result!);
		};
		ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token, clientKind: "app" })));
		ws.on("message", (raw) => {
			try {
				const frame = JSON.parse(String(raw)) as { type?: string };
				if (frame.type === "auth_ok" || frame.type === "auth_failed") finish(frame.type);
			} catch { /* ignore unrelated frames */ }
		});
		ws.once("error", (error) => finish(undefined, error));
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

	it("allows the finite standard Vite HTTP origin and rejects its opposite scheme", async () => {
		const targetAuthority = `127.0.0.1:${port}`;
		const allowed = await request(port, `${MOUNT}/api/health`, browserHeaders(targetAuthority, VITE_ORIGIN));
		expect(allowed.status, allowed.body).toBe(200);
		expect(allowed.headers["access-control-allow-origin"]).toBe(VITE_ORIGIN);

		const rejected = await request(
			port,
			`${MOUNT}/api/health`,
			browserHeaders(targetAuthority, "https://127.0.0.1:5173"),
		);
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

describe.sequential("public authority provenance on a loopback backend", () => {
	let processState: ProcessStateSnapshot;
	let root: string;
	let port: number;
	let gateway: ReturnType<typeof createGateway>;
	let gatewayConfig: Parameters<typeof createGateway>[0];

	beforeAll(async () => {
		processState = captureProcessState();
		root = createRunChild("request-admission-public-provenance");
		const stateDir = join(root, "state");
		const secretsDir = join(root, "secrets");
		const agentDir = join(root, "agent");
		for (const directory of [stateDir, secretsDir, agentDir, join(stateDir, "session-prompts")]) {
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

		gatewayConfig = {
			host: "127.0.0.1",
			port: 0,
			portExplicit: true,
			authToken: TOKEN,
			defaultCwd: root,
			forceAuth: false,
			staticDir: join(REPO_ROOT, "public"),
			publicOrigins: ["https://public.example"],
			skipMcp: true,
			skipWorktreePool: true,
			skipTitleGeneration: true,
			skipRemotePush: true,
			skipNonLocalRemoteGit: true,
			builtinsDir: join(REPO_ROOT, "defaults"),
			builtinPacksDir: join(REPO_ROOT, "market-packs"),
		} as Parameters<typeof createGateway>[0] & { publicOrigins: string[] };
		gateway = createGateway(gatewayConfig, gatewayDeps);
		port = await gateway.start();
	}, 60_000);

	afterAll(async () => {
		try { await gateway?.shutdown(); }
		finally {
			if (processState) restoreProcessState(processState);
			if (root) removeOwnedRunChild(root);
		}
	}, 60_000);

	it("requires credentials for public Host API, preview, and WebSocket traffic", async () => {
		expect(gateway.trustedLocal).toBe(false);
		const startupUrls = buildStartupUrls({
			protocol: "http",
			host: "127.0.0.1",
			port,
			token: TOKEN,
			trustedLocal: gateway.trustedLocal,
		});
		expect(startupUrls.authEnforced).toBe(true);
		expect(startupUrls.uiUrl).toBe(`http://127.0.0.1:${port}/?token=${TOKEN}`);
		expect(startupUrls.openUrl).toBe(startupUrls.uiUrl);
		const publishedUrl = readFileSync(join(root, "state", "gateway-url"), "utf8");
		expect(new URL(publishedUrl).search).toBe("");

		const rebinding = await plainRequest(port, "/api/health", {
			Host: "attacker.example",
			Origin: "http://attacker.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			...authorization(),
		});
		expect(rebinding.status).toBe(403);

		const unauthenticatedApi = await plainRequest(port, "/api/health", { Host: "public.example" });
		expect(unauthenticatedApi.status).toBe(401);

		const authenticatedApi = await plainRequest(port, "/api/health", {
			Host: "public.example",
			...authorization(),
		});
		expect(authenticatedApi.status, authenticatedApi.body).toBe(200);
		expect(JSON.parse(authenticatedApi.body)).toMatchObject({ localhost: false });

		const sessionId = randomUUID();
		const body = JSON.stringify({ html: "<!doctype html><body>public preview</body>", workspaceTab: false });
		const mount = await plainRequest(port, `/api/preview/mount?sessionId=${sessionId}`, {
			Host: "public.example",
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(body)),
			...authorization(),
		}, "POST", body);
		expect(mount.status, mount.body).toBe(200);
		const previewPath = (JSON.parse(mount.body) as { url: string }).url;
		const unauthenticatedPreview = await plainRequest(port, previewPath, { Host: "public.example" });
		expect(unauthenticatedPreview.status).toBe(401);

		expect(await webSocketAuthResult(port, "arbitrary-token")).toBe("auth_failed");
		expect(await webSocketAuthResult(port, TOKEN)).toBe("auth_ok");
	});

	it("mints a Secure cookie from the exact admitted HTTPS origin and uses it for preview", async () => {
		const bootstrap = await plainRequest(port, "/api/health", {
			Host: "public.example",
			Origin: "https://public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			...authorization(),
		});
		expect(bootstrap.status, bootstrap.body).toBe(200);
		const setCookie = bootstrap.headers["set-cookie"]?.[0];
		expect(setCookie).toContain("bobbit_session=");
		expect(setCookie).toMatch(/; Secure(?:;|$)/);
		const cookie = setCookie!.split(";", 1)[0]!;

		const sessionId = randomUUID();
		const body = JSON.stringify({ html: "<!doctype html><body>cookie preview</body>", workspaceTab: false });
		const mount = await plainRequest(port, `/api/preview/mount?sessionId=${sessionId}`, {
			Host: "public.example",
			Origin: "https://public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(body)),
			...authorization(),
		}, "POST", body);
		expect(mount.status, mount.body).toBe(200);
		const previewPath = (JSON.parse(mount.body) as { url: string }).url;
		const preview = await plainRequest(port, previewPath, {
			Host: "public.example",
			Cookie: cookie,
			Origin: "https://public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "iframe",
		});
		expect(preview.status, preview.body).toBe(200);
		expect(preview.body).toContain("cookie preview");
	});

	it("mints a Secure cookie for an originless browser API request through the configured HTTPS origin", async () => {
		const bootstrap = await plainRequest(port, "/api/health", {
			Host: "public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			...authorization(),
		});
		expect(bootstrap.status, bootstrap.body).toBe(200);
		const setCookie = bootstrap.headers["set-cookie"]?.[0];
		expect(setCookie).toContain("bobbit_session=");
		expect(setCookie).toMatch(/; Secure(?:;|$)/);
		const cookie = setCookie!.split(";", 1)[0]!;

		const sessionId = randomUUID();
		const body = JSON.stringify({ html: "<!doctype html><body>originless cookie preview</body>", workspaceTab: false });
		const mount = await plainRequest(port, `/api/preview/mount?sessionId=${sessionId}`, {
			Host: "public.example",
			Origin: "https://public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(body)),
			...authorization(),
		}, "POST", body);
		expect(mount.status, mount.body).toBe(200);
		const previewPath = (JSON.parse(mount.body) as { url: string }).url;
		const preview = await plainRequest(port, previewPath, {
			Host: "public.example",
			Cookie: cookie,
			Origin: "https://public.example",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "iframe",
		});
		expect(preview.status, preview.body).toBe(200);
		expect(preview.body).toContain("originless cookie preview");
	});

	it("retains the credential-free bypass for a genuinely all-loopback policy", async () => {
		const localGateway = createGateway({ ...gatewayConfig, publicOrigins: undefined }, gatewayDeps);
		expect(() => localGateway.trustedLocal).toThrow(/before successful start/i);
		try {
			const localPort = await localGateway.start();
			expect(localGateway.trustedLocal).toBe(true);
			const response = await plainRequest(localPort, "/api/health", { Host: `127.0.0.1:${localPort}` });
			expect(response.status, response.body).toBe(200);
			expect(JSON.parse(response.body)).toMatchObject({ localhost: true });
		} finally {
			await localGateway.shutdown();
		}
	});
});
