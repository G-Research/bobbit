import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { type ClientOptions } from "ws";

import {
	bobbitStateDir,
	getAgentDirState,
	getProjectRoot,
	initializeAgentDirRuntime,
	resetAgentDirStateForTests,
	setProjectRoot,
	type AgentDirRuntimeState,
} from "../../src/server/bobbit-dir.js";
import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.js";
import { realClock, realCommandRunner, realFs, type GatewayDeps } from "../../src/server/gateway-deps.js";
import { scaffoldBobbitDir } from "../../src/server/scaffold.js";
import { CookieStore } from "../../src/server/auth/cookie.js";
import { createGateway } from "../../src/server/server.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// This test branch is developed in parallel with the gateway foundation branch.
// The required shared module is the activation sentinel: the suites run after
// the branches merge, while remaining compilable in the test-only worktree.
const BASE_PATH_IMPLEMENTED = existsSync(join(REPO_ROOT, "src", "shared", "base-path.ts"));
const TOKEN = "base-path-integration-token-" + "x".repeat(64);
const MOUNT = "/team/bobbit";
const ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_LLM_REVIEW_SKIP",
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

interface RunningGateway {
	root: string;
	staticDir: string;
	origin: string;
	baseUrl: string;
	wsOrigin: string;
	gateway: ReturnType<typeof createGateway>;
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

async function bootGateway(basePath: string, host = "127.0.0.1", forceAuth = true): Promise<RunningGateway> {
	const processState = captureProcessState();
	let root = mkdtempSync(join(tmpdir(), "bobbit-base-path-gateway-"));
	try { root = realpathSync(root); } catch { /* platform edge */ }
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

	const gateway = createGateway({
		host,
		port: 0,
		portExplicit: true,
		authToken: TOKEN,
		defaultCwd: root,
		staticDir,
		forceAuth,
		skipMcp: true,
		skipWorktreePool: true,
		skipTitleGeneration: true,
		skipRemotePush: true,
		skipNonLocalRemoteGit: true,
		builtinsDir: join(REPO_ROOT, "defaults"),
		builtinPacksDir: join(REPO_ROOT, "market-packs"),
		basePath,
	} as Parameters<typeof createGateway>[0] & { basePath: string }, gatewayDeps);
	const port = await gateway.start();
	const connectHost = host.toLowerCase() === "localhost" ? "localhost" : "127.0.0.1";
	const origin = `http://${connectHost}:${port}`;
	return {
		root,
		staticDir,
		origin,
		baseUrl: `${origin}${basePath}`,
		wsOrigin: `ws://${connectHost}:${port}`,
		gateway,
		async shutdown() {
			try { await gateway.shutdown(); }
			finally {
				// createGateway resolves these process-wide values during startup. Restore
				// every one before deleting the directories they previously referenced.
				restoreProcessState(processState);
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function api(baseUrl: string, route: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${baseUrl}${route}`, {
		...init,
		headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
	});
}

function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0]!;
}

function authenticateSocket(url: string, options: ClientOptions = {}, token = TOKEN): Promise<WebSocket> {
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

function expectRejectedUpgrade(url: string, options: ClientOptions = {}): Promise<void> {
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

interface SseControl {
	payloads: Array<Record<string, unknown>>;
	waitForPayloadCount(count: number): Promise<void>;
	close(): void;
}

function openPreviewEvents(url: string): Promise<SseControl> {
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

async function registerArchivedSession(running: RunningGateway): Promise<string> {
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

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("in-process gateway mounted at a nested base path", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("serves mounted API/static/deep-link routes and rejects every off-mount lookalike", async () => {
		const health = await api(running.baseUrl, "/api/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok" });

		for (const path of ["/", "/api/health", "/team", "/team/bobbit-other", "/other/team/bobbit"]) {
			const response = await fetch(`${running.origin}${path}`, { redirect: "manual", headers: authHeaders() });
			expect(response.status, `off-mount ${path}`).toBe(404);
		}

		const redirect = await fetch(`${running.origin}${MOUNT}?x=1&y=two`, { redirect: "manual" });
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get("location")).toBe(`${MOUNT}/?x=1&y=two`);

		const asset = await fetch(`${running.baseUrl}/assets/app.js`);
		expect(asset.status).toBe(200);
		expect(await asset.text()).toBe("globalThis.__basePathAssetLoaded = true;\n");
		expect((await fetch(`${running.origin}/assets/app.js`)).status).toBe(404);

		const shell = await fetch(`${running.baseUrl}/session/copied-id`);
		expect(shell.status).toBe(200);
		const html = await shell.text();
		expect(html).toContain(`window.__BOBBIT_BASE_PATH__ = ${JSON.stringify(MOUNT)}`);
		expect(html).toContain(`src="${MOUNT}/assets/app.js"`);
		expect(html).toContain(`href="${MOUNT}/icons/icon.png"`);
	});

	it("rewrites plain and tokenized manifests and scopes browser cookies to the mount", async () => {
		const plainResponse = await fetch(`${running.baseUrl}/manifest.json`);
		expect(plainResponse.status).toBe(200);
		const plain = await plainResponse.json() as any;
		expect(plain.start_url).toBe(`${MOUNT}/`);
		expect(plain.scope).toBe(`${MOUNT}/`);
		expect(plain.icons[0].src).toBe(`${MOUNT}/icons/icon.png`);

		const tokenResponse = await fetch(`${running.baseUrl}/manifest.json?token=${encodeURIComponent(TOKEN)}`);
		const tokenized = await tokenResponse.json() as any;
		expect(tokenized.start_url).toBe(`${MOUNT}/?token=${encodeURIComponent(TOKEN)}`);
		expect(tokenized.scope).toBe(`${MOUNT}/`);

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: {
				Origin: running.origin,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(browserHealth.status).toBe(200);
		const setCookie = browserHealth.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/^bobbit_session=/);
		expect(setCookie).toContain(`Path=${MOUNT}/`);
		expect(setCookie).not.toContain("; Secure");
	});

	it("migrates legacy root cookies and binds HTTP, CORS preflight, and WebSocket use to the bootstrapping UI origin", async () => {
		const signingKey = readFileSync(join(running.root, "secrets", "cookie-signing-key"));
		const cookieStore = new CookieStore(signingKey);
		const legacy = cookieStore.mint();
		const uiOrigin = "http://127.0.0.1:5173";
		const otherOrigin = "http://127.0.0.1:5174";
		const rootBound = cookieStore.mint({ basePath: "", origin: uiOrigin });
		const staleRootCookies = `bobbit_session=${legacy}; bobbit_session=${rootBound}`;
		const migration = await fetch(`${running.baseUrl}/api/health`, {
			headers: {
				...authHeaders(),
				Cookie: staleRootCookies,
				Origin: uiOrigin,
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(migration.status).toBe(200);
		const setCookies = (migration.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
			?? [migration.headers.get("set-cookie") ?? ""];
		expect(setCookies.some((value) => /bobbit_session=;.*Path=\/;.*Max-Age=0/.test(value))).toBe(true);
		const mountedSetCookie = setCookies.find((value) => value.includes(`Path=${MOUNT}/`) && value.includes("bobbit_session=v1.2."));
		expect(mountedSetCookie).toBeDefined();
		const mountedCookie = cookiePair(mountedSetCookie!);

		const staleOnly = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: staleRootCookies, Origin: uiOrigin },
		});
		expect(staleOnly.status).toBe(401);
		expect(staleOnly.headers.get("access-control-allow-origin")).toBeNull();

		const exact = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: mountedCookie, Origin: uiOrigin },
		});
		expect(exact.status).toBe(200);
		expect(exact.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		expect(exact.headers.get("access-control-allow-credentials")).toBe("true");

		const mismatch = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatch.status).toBe(401);
		expect(mismatch.headers.get("access-control-allow-origin")).toBeNull();
		expect(mismatch.headers.get("access-control-allow-credentials")).toBeNull();

		const mismatchSse = await fetch(`${running.baseUrl}/api/sessions/00000000-0000-4000-8000-000000000001/preview-events`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatchSse.status).toBe(401);
		const mismatchPreview = await fetch(`${running.baseUrl}/preview/00000000-0000-4000-8000-000000000001/index.html`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatchPreview.status).toBe(401);

		const exactPreflight = await fetch(`${running.baseUrl}/api/config`, {
			method: "OPTIONS",
			headers: {
				Origin: uiOrigin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(exactPreflight.status).toBe(204);
		expect(exactPreflight.headers.get("access-control-allow-origin")).toBe(uiOrigin);

		const mismatchPreflight = await fetch(`${running.baseUrl}/api/config`, {
			method: "OPTIONS",
			headers: {
				Origin: otherOrigin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(mismatchPreflight.status).toBe(204);
		expect(mismatchPreflight.headers.get("access-control-allow-origin")).toBeNull();
		expect(mismatchPreflight.headers.get("access-control-allow-credentials")).toBeNull();

		// Reloaded cookie-compatible clients persist only the non-secret
		// `localhost` sentinel. The exact bound HttpOnly cookie must therefore
		// authorize both socket types before that first auth frame is evaluated.
		const sessionId = await registerArchivedSession(running);
		const socketOptions = { origin: uiOrigin, headers: { Cookie: mountedCookie } };
		const exactViewer = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/viewer`,
			socketOptions,
			"localhost",
		);
		const exactSession = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/${sessionId}`,
			socketOptions,
			"localhost",
		);
		exactViewer.close();
		exactSession.close();
		await expectRejectedUpgrade(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: otherOrigin,
			headers: { Cookie: mountedCookie },
		});
	});

	it("keeps preview API, restore, bootstrap, and live SSE payloads mount-relative while browser outputs are prefixed once", async () => {
		const sessionId = randomUUID();
		const mountRoute = `/api/preview/mount?sessionId=${sessionId}`;
		const firstMount = await api(running.baseUrl, mountRoute, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ html: "<!doctype html><head></head><body>first</body>", workspaceTab: false }),
		});
		if (firstMount.status !== 200) throw new Error(`Preview mount returned ${firstMount.status}: ${await firstMount.text()}`);
		const first = await firstMount.json() as { url: string; entry: string; artifactId: string };
		expect(first.url).toBe(`/preview/${sessionId}/${first.entry}`);
		expect(first.url).not.toContain(MOUNT);

		const snapshotResponse = await api(running.baseUrl, `/api/preview/mount?sessionId=${sessionId}`);
		expect(snapshotResponse.status).toBe(200);
		const snapshot = await snapshotResponse.json() as { url: string };
		expect(snapshot.url).toBe(first.url);

		const stream = await openPreviewEvents(`${running.baseUrl}/api/sessions/${sessionId}/preview-events`);
		try {
			await stream.waitForPayloadCount(1);
			expect(stream.payloads[0]?.url).toBe(first.url);

			const secondMount = await api(running.baseUrl, mountRoute, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!doctype html><head></head><body>second</body>", entry: "second.html", workspaceTab: false }),
			});
			expect(secondMount.status).toBe(200);
			const second = await secondMount.json() as { url: string };
			await stream.waitForPayloadCount(2);
			expect(stream.payloads[1]?.url).toBe(second.url);
			expect(second.url).toBe(`/preview/${sessionId}/second.html`);

			const restore = await api(running.baseUrl, `/api/preview/artifacts/${encodeURIComponent(first.artifactId)}/restore?sessionId=${sessionId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ artifactId: first.artifactId }),
			});
			expect(restore.status).toBe(200);
			expect((await restore.json() as { url: string }).url).toBe(first.url);
		} finally {
			stream.close();
		}

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: { Origin: running.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		const cookie = cookiePair(browserHealth.headers.get("set-cookie") ?? "");
		expect(cookie).toMatch(/^bobbit_session=/);

		const noCookie = await fetch(`${running.baseUrl}/preview/${sessionId}/${first.entry}`, { redirect: "manual" });
		expect(noCookie.status).toBe(401);

		const barePreview = await fetch(`${running.baseUrl}/preview/${sessionId}`, {
			redirect: "manual",
			headers: { Cookie: cookie },
		});
		expect(barePreview.status).toBe(301);
		expect(barePreview.headers.get("location")).toBe(`${MOUNT}/preview/${sessionId}/`);

		const entryRedirect = await fetch(`${running.baseUrl}/preview/${sessionId}/`, {
			redirect: "manual",
			headers: { Cookie: cookie },
		});
		expect(entryRedirect.status).toBe(302);
		expect(entryRedirect.headers.get("location")).toBe(`${MOUNT}/preview/${sessionId}/${first.entry}`);

		const content = await fetch(`${running.baseUrl}/preview/${sessionId}/${first.entry}`, { headers: { Cookie: cookie } });
		expect(content.status).toBe(200);
		const previewHtml = await content.text();
		expect(previewHtml).toContain(`data-bobbit-preview-base`);
		expect(previewHtml).toContain(`href="${MOUNT}/preview/${sessionId}/"`);
		expect(previewHtml).not.toContain(`${MOUNT}${MOUNT}`);
	});

	it("accepts mounted viewer and session sockets but rejects unprefixed and sibling upgrades", async () => {
		const sessionId = await registerArchivedSession(running);
		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`);
		const session = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/${sessionId}`);
		viewer.close();
		session.close();

		await expectRejectedUpgrade(`${running.wsOrigin}/ws/viewer`);
		await expectRejectedUpgrade(`${running.wsOrigin}${MOUNT}-other/ws/viewer`);
		await expectRejectedUpgrade(`${running.wsOrigin}/team/ws/viewer`);
	});
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("direct cross-port browser cookie binding", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT, "localhost", true);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("binds a real-bearer bootstrap to an equivalent trailing-dot UI host", async () => {
		const uiOrigin = "http://localhost.:5173";
		const bootstrap = await fetch(`${running.baseUrl}/api/health`, {
			headers: {
				...authHeaders(),
				Origin: uiOrigin,
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(bootstrap.status).toBe(200);
		expect(bootstrap.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		const setCookie = bootstrap.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("bobbit_session=v1.2.");
		expect(setCookie).toContain(`Path=${MOUNT}/`);
		const cookie = cookiePair(setCookie);

		const reload = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: cookie, Origin: uiOrigin },
		});
		expect(reload.status).toBe(200);
		expect(reload.headers.get("access-control-allow-origin")).toBe(uiOrigin);

		const wrongPortOrigin = "http://localhost.:5174";
		const mismatch = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: cookie, Origin: wrongPortOrigin },
		});
		expect(mismatch.status).toBe(401);
		expect(mismatch.headers.get("access-control-allow-origin")).toBeNull();

		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: uiOrigin,
			headers: { Cookie: cookie },
		}, "localhost");
		viewer.close();
		await expectRejectedUpgrade(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: wrongPortOrigin,
			headers: { Cookie: cookie },
		});
	});
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("root-mounted gateway compatibility", () => {
	let running: RunningGateway;
	let originalShell: string;

	beforeAll(async () => {
		running = await bootGateway("");
		originalShell = readFileSync(join(running.staticDir, "index.html"), "utf8");
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("retains root API, shell, manifest, cookie, preview wire shape, and viewer socket behavior", async () => {
		expect((await api(running.baseUrl, "/api/health")).status).toBe(200);
		const shellResponse = await fetch(`${running.origin}/session/root-deep-link`);
		expect(shellResponse.status).toBe(200);
		expect(await shellResponse.text()).toBe(originalShell);

		const manifest = await (await fetch(`${running.origin}/manifest.json`)).json() as any;
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.icons[0].src).toBe("/icons/icon.png");

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: { Origin: running.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		expect(browserHealth.headers.get("set-cookie")).toContain("Path=/;");

		const previewSession = randomUUID();
		const mount = await api(running.baseUrl, `/api/preview/mount?sessionId=${previewSession}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ html: "<body>root preview</body>", workspaceTab: false }),
		});
		expect(mount.status).toBe(200);
		expect((await mount.json() as { url: string }).url).toMatch(new RegExp(`^/preview/${previewSession}/`));

		const viewer = await authenticateSocket(`${running.wsOrigin}/ws/viewer`);
		viewer.close();
	});
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mixed-case loopback gateway auth state", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway("", "LOCALHOST", false);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("uses the same disabled-auth decision for HTTP health and viewer WebSockets", async () => {
		const health = await fetch(`${running.baseUrl}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok", localhost: true });
		const viewer = await authenticateSocket(`${running.wsOrigin}/ws/viewer`, {}, "localhost");
		viewer.close();
	});
});
