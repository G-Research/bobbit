import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { type ClientOptions } from "ws";

import {
	bobbitStateDir,
	getAgentDirState,
	getProjectRoot,
	initializeAgentDirRuntime,
	resetAgentDirStateForTests,
	setProjectRoot,
	type AgentDirRuntimeState,
} from "../../../../src/server/bobbit-dir.js";
import { initAuthorSidecarDir } from "../../../../src/server/agent/author-sidecar.js";
import { realClock, realCommandRunner, realFs, type GatewayDeps } from "../../../../src/server/gateway-deps.js";
import { scaffoldBobbitDir } from "../../../../src/server/scaffold.js";
import { loopbackForBind } from "../../../../src/server/cli-loopback.js";
import { createGateway, type GatewayConfig } from "../../../../src/server/server.js";
import { createRunChild, removeOwnedRunChild } from "../../../support/harnesses/run-isolation.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
// This test branch is developed in parallel with the gateway foundation branch.
// The required shared module is the activation sentinel: the suites run after
// the branches merge, while remaining compilable in the test-only worktree.
export const BASE_PATH_IMPLEMENTED = existsSync(join(REPO_ROOT, "src", "shared", "base-path.ts"));
export const TOKEN = "base-path-integration-token-" + "x".repeat(64);
export const MOUNT = "/team/bobbit";
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

function captureProcessState(): ProcessStateSnapshot {
	let agentDirState: AgentDirRuntimeState | undefined;
	try { agentDirState = getAgentDirState(); } catch { /* not initialized before the fork gateway boots */ }
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

	// createGateway also repoints this fork-global cache. Restore the already
	// running v2 harness before the temporary gateway root is removed.
	const restoredRoot = snapshot.env.BOBBIT_DIR;
	const restoredSecretsDir = snapshot.env.BOBBIT_SECRETS_DIR;
	if (restoredRoot && restoredSecretsDir && existsSync(join(restoredRoot, "state"))) {
		initAuthorSidecarDir(join(restoredRoot, "state"), { secretsDir: restoredSecretsDir });
	}
}

export interface RunningGateway {
	root: string;
	staticDir: string;
	origin: string;
	baseUrl: string;
	wsOrigin: string;
	gateway: ReturnType<typeof createGateway>;
	/** Exact callback information supplied by the gateway to LifecycleHub providers. */
	lifecycleGatewayInfo(): { baseUrl: string; token: string };
	/** Persisted URL consumed by direct and sandbox session launch paths. */
	agentGatewayUrl(): string | undefined;
	shutdown(): Promise<void>;
}

function isolatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw);
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
			return fetch(input, init);
		}
	} catch {
		// The production startup probe treats a failed discovery request as offline.
	}
	return Promise.resolve(new Response("network fenced by base-path integration test", { status: 503 }));
}

const gatewayDeps: GatewayDeps = {
	clock: realClock,
	commandRunner: realCommandRunner,
	fetchImpl: isolatedFetch,
	agentBridgeFactory: () => null,
	fsImpl: realFs,
};

function writeStaticFixture(staticDir: string): string {
	const shell = [
		"<!doctype html>",
		"<html><head>",
		'<meta charset="UTF-8">',
		'<script>window.__BOBBIT_BASE_PATH__ = "";</script>',
		'<link rel="icon" href="/icons/icon.png">',
		'<script type="module" src="/assets/app.js"></script>',
		"</head><body>base-path-shell</body></html>",
	].join("\n");
	mkdirSync(join(staticDir, "assets"), { recursive: true });
	mkdirSync(join(staticDir, "icons"), { recursive: true });
	writeFileSync(join(staticDir, "index.html"), shell);
	writeFileSync(join(staticDir, "assets", "app.js"), "globalThis.__basePathAssetLoaded = true;\n");
	writeFileSync(join(staticDir, "icons", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(staticDir, "manifest.json"), JSON.stringify({
		name: "Bobbit base-path fixture",
		start_url: "/",
		scope: "/",
		icons: [{ src: "/icons/icon.png", sizes: "192x192", type: "image/png" }],
	}));
	return shell;
}

export interface BootGatewayOptions {
	/** Default true. False exercises API-only callback publication. */
	serveStatic?: boolean;
	/** Seed both legacy fallbacks before start; listener publication must supersede them. */
	staleGatewayUrl?: string;
	/** Explicit callback publisher used to cover CLI/public-proxy overrides. */
	onBound?: GatewayConfig["onBound"];
	/** Observe the persisted agent URL at the exact restore-sessions boundary. */
	observeSessionRestoreGatewayUrl?: (gatewayUrl: string | undefined) => void;
}

export async function bootGateway(
	basePath: string,
	host = "127.0.0.1",
	forceAuth = true,
	options: BootGatewayOptions = {},
): Promise<RunningGateway> {
	const processState = captureProcessState();
	const root = createRunChild("base-path-gateway");
	const stateDir = join(root, "state");
	const staticDir = join(root, "static");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(join(root, "secrets"), { recursive: true });
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(stateDir, "session-prompts"), { recursive: true });
	writeFileSync(join(stateDir, "projects.json"), "[]");
	writeFileSync(join(stateDir, "setup-complete"), "test\n");
	writeStaticFixture(staticDir);

	process.env.BOBBIT_DIR = root;
	process.env.BOBBIT_SECRETS_DIR = join(root, "secrets");
	process.env.BOBBIT_AGENT_DIR = join(root, "agent");
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.NODE_ENV = "test";
	setProjectRoot(root);
	resetAgentDirStateForTests();
	scaffoldBobbitDir(root);
	if (options.staleGatewayUrl !== undefined) {
		process.env.BOBBIT_GATEWAY_URL = options.staleGatewayUrl;
		writeFileSync(join(stateDir, "gateway-url"), options.staleGatewayUrl);
	}

	const gatewayConfig = {
		host,
		port: 0,
		portExplicit: true,
		authToken: TOKEN,
		defaultCwd: root,
		...(options.serveStatic === false ? {} : { staticDir }),
		forceAuth,
		skipMcp: true,
		skipWorktreePool: true,
		skipTitleGeneration: true,
		skipRemotePush: true,
		skipNonLocalRemoteGit: true,
		builtinsDir: join(REPO_ROOT, "defaults"),
		builtinPacksDir: join(REPO_ROOT, "market-packs"),
		basePath,
		...(options.onBound ? { onBound: options.onBound } : {}),
	} as Parameters<typeof createGateway>[0] & { basePath: string };
	let gateway: ReturnType<typeof createGateway>;
	let port: number;
	try {
		gateway = createGateway(gatewayConfig, gatewayDeps);
		if (options.observeSessionRestoreGatewayUrl) {
			const restoreSessions = gateway.sessionManager.restoreSessions.bind(gateway.sessionManager);
			const agentGatewayUrl = gateway.sessionManager as unknown as {
				readGatewayUrlForAgent(): string | undefined;
			};
			gateway.sessionManager.restoreSessions = async () => {
				options.observeSessionRestoreGatewayUrl?.(agentGatewayUrl.readGatewayUrlForAgent());
				await restoreSessions();
			};
		}
		port = await gateway.start();
	} catch (error) {
		try { await gateway!.shutdown(); } catch { /* best-effort rejected-start cleanup */ }
		restoreProcessState(processState);
		removeOwnedRunChild(root);
		throw error;
	}
	const peerHost = loopbackForBind(host.trim());
	const unbracketedPeer = peerHost.startsWith("[") && peerHost.endsWith("]") ? peerHost.slice(1, -1) : peerHost;
	const connectHost = unbracketedPeer.includes(":") ? `[${unbracketedPeer}]` : unbracketedPeer;
	const origin = `http://${connectHost}:${port}`;
	const running: RunningGateway = {
		root,
		staticDir,
		origin,
		baseUrl: `${origin}${basePath}`,
		wsOrigin: `ws://${connectHost}:${port}`,
		gateway,
		lifecycleGatewayInfo() {
			const hub = gateway.sessionManager.lifecycleHub as unknown as {
				gatewayInfo: () => { baseUrl: string; token: string };
			};
			return hub.gatewayInfo();
		},
		agentGatewayUrl() {
			const manager = gateway.sessionManager as unknown as {
				readGatewayUrlForAgent(): string | undefined;
			};
			return manager.readGatewayUrlForAgent();
		},
		async shutdown() {
			try { await gateway.shutdown(); }
			finally {
				// createGateway resolves these process-wide values during startup. Restore
				// every one before deleting the directories they previously referenced.
				restoreProcessState(processState);
				removeOwnedRunChild(root);
			}
		},
	};
	return running;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

export async function api(baseUrl: string, route: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${baseUrl}${route}`, {
		...init,
		headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
	});
}

export function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0]!;
}

export function authenticateSocket(url: string, options: ClientOptions = {}, token = TOKEN): Promise<WebSocket> {
	return new Promise((resolveSocket, reject) => {
		const socket = new WebSocket(url, options);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out authenticating WebSocket ${url}`));
		}, 10_000);
		const fail = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once("error", fail);
		socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as { type?: string };
			if (message.type !== "auth_ok") return;
			clearTimeout(timer);
			socket.off("error", fail);
			resolveSocket(socket);
		});
	});
}

export function expectRejectedUpgrade(url: string, options: ClientOptions = {}): Promise<void> {
	return new Promise((resolveRejected, reject) => {
		const socket = new WebSocket(url, options);
		let opened = false;
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Off-mount WebSocket did not reject promptly: ${url}`));
		}, 5_000);
		const pass = () => {
			clearTimeout(timer);
			resolveRejected();
		};
		socket.once("open", () => {
			opened = true;
			socket.terminate();
			clearTimeout(timer);
			reject(new Error(`Off-mount WebSocket unexpectedly upgraded: ${url}`));
		});
		socket.once("unexpected-response", (_request, response) => {
			response.resume();
			pass();
		});
		socket.once("error", () => {
			if (!opened) pass();
		});
		socket.once("close", () => {
			if (!opened) pass();
		});
	});
}

export interface SseControl {
	payloads: Array<Record<string, unknown>>;
	waitForPayloadCount(count: number): Promise<void>;
	close(): void;
}

export function openPreviewEvents(url: string): Promise<SseControl> {
	return new Promise((resolveStream, reject) => {
		const request = http.request(url, { headers: authHeaders() });
		request.once("error", reject);
		request.once("response", (response) => {
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Preview SSE returned ${response.statusCode}`));
				return;
			}
			const payloads: Array<Record<string, unknown>> = [];
			const waiters: Array<{ count: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
			let buffered = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				buffered += chunk;
				for (;;) {
					const boundary = buffered.indexOf("\n\n");
					if (boundary < 0) break;
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					if (!frame.includes("event: preview-changed")) continue;
					const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
					if (!data) continue;
					payloads.push(JSON.parse(data) as Record<string, unknown>);
					for (let index = waiters.length - 1; index >= 0; index--) {
						if (payloads.length < waiters[index]!.count) continue;
						const waiter = waiters.splice(index, 1)[0]!;
						clearTimeout(waiter.timer);
						waiter.resolve();
					}
				}
			});
			resolveStream({
				payloads,
				waitForPayloadCount(count) {
					if (payloads.length >= count) return Promise.resolve();
					return new Promise<void>((resolveWait, rejectWait) => {
						const timer = setTimeout(() => {
							const index = waiters.findIndex((waiter) => waiter.timer === timer);
							if (index >= 0) waiters.splice(index, 1);
							rejectWait(new Error(`Timed out waiting for ${count} preview SSE payloads; received ${payloads.length}`));
						}, 10_000);
						waiters.push({ count, resolve: resolveWait, reject: rejectWait, timer });
					});
				},
				close() {
					for (const waiter of waiters.splice(0)) {
						clearTimeout(waiter.timer);
						waiter.reject(new Error("Preview SSE closed"));
					}
					response.destroy();
					request.destroy();
				},
			});
		});
		request.end();
	});
}

export async function registerArchivedSession(running: RunningGateway): Promise<string> {
	const projectRoot = join(running.root, "project");
	mkdirSync(projectRoot, { recursive: true });
	const response = await api(running.baseUrl, "/api/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "base-path-project", rootPath: projectRoot, upsert: true, acceptCanonical: true }),
	});
	if (response.status !== 200 && response.status !== 201) {
		throw new Error(`Project registration returned ${response.status}: ${await response.text()}`);
	}
	const project = await response.json() as { id: string };
	const sessionId = randomUUID();
	const store = running.gateway.sessionManager.getSessionStore(project.id);
	store.put({
		id: sessionId,
		projectId: project.id,
		cwd: projectRoot,
		title: "Mounted archived session",
		createdAt: Date.now(),
		lastActivity: Date.now(),
		archived: true,
		archivedAt: Date.now(),
	} as any);
	return sessionId;
}
