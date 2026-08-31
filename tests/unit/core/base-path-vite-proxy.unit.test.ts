import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { computeDistBuildKey, validateDistBuild } from "../../../scripts/testing-v2/ensure-dist.mjs";
import viteConfig from "../../../vite.config.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const MOUNT = "/team/bobbit";
const originalGatewayUrl = process.env.GATEWAY_URL;
let targetServer: http.Server;
let devServer: http.Server;
let targetOrigin: string;
let devOrigin: string;
const targetUpgrades: string[] = [];

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("expected TCP address"));
			resolve(address.port);
		});
	});
}

function close(server: http.Server): Promise<void> {
	server.closeAllConnections?.();
	return new Promise(resolve => server.close(() => resolve()));
}

async function resolvedConfig(mode: "development" | "production"): Promise<any> {
	const definition = viteConfig as any;
	return typeof definition === "function"
		? await definition({ command: mode === "production" ? "build" : "serve", mode, isSsrBuild: false, isPreview: false })
		: definition;
}

function flattenPlugins(value: unknown): any[] {
	if (Array.isArray(value)) return value.flatMap(flattenPlugins);
	return value ? [value] : [];
}

async function configureDynamicProxy(server: http.Server): Promise<(req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void> {
	const config = await resolvedConfig("development");
	const plugins = flattenPlugins(await Promise.all((config.plugins ?? []).map(async (plugin: any) => await plugin)));
	const proxy = plugins.find((plugin: any) => plugin?.name === "dynamic-gateway-proxy");
	assert.ok(proxy?.configureServer, "dynamic-gateway-proxy Vite plugin must be configured");
	let middleware: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | undefined;
	const viteServer = {
		middlewares: { use(handler: typeof middleware) { middleware = handler; } },
		httpServer: server,
	};
	const hook = typeof proxy.configureServer === "function" ? proxy.configureServer : proxy.configureServer.handler;
	await hook(viteServer);
	assert.ok(middleware, "dynamic gateway proxy must install HTTP middleware");
	return middleware;
}

beforeAll(async () => {
	targetServer = http.createServer((req, res) => {
		const requestUrl = req.url ?? "/";
		const relative = requestUrl.startsWith(MOUNT) ? requestUrl.slice(MOUNT.length) || "/" : requestUrl;
		if (relative.startsWith("/api/location")) {
			res.writeHead(302, { Location: `${MOUNT}/preview/${SID}/` });
			res.end();
			return;
		}
		if (relative.startsWith("/api/external")) {
			res.writeHead(302, { Location: "https://elsewhere.example/landing" });
			res.end();
			return;
		}
		if (relative.startsWith("/api/cookie")) {
			res.writeHead(200, { "Set-Cookie": `${COOKIE}=value; Path=${MOUNT}/; HttpOnly`, "Content-Type": "text/plain" });
			res.end("cookie");
			return;
		}
		if (relative.startsWith("/manifest.json")) {
			res.writeHead(200, { "Content-Type": "application/manifest+json" });
			res.end(JSON.stringify({
				start_url: `${MOUNT}/?token=secret`,
				scope: `${MOUNT}/`,
				icons: [{ src: `${MOUNT}/icon.png` }, { src: "relative.png" }],
			}));
			return;
		}
		if (relative.startsWith("/preview/page")) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><head><base data-bobbit-preview-base href="${MOUNT}/preview/${SID}/"><base href="/user-authored/"></head></html>`);
			return;
		}
		if (relative.startsWith("/api/events")) {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(`data: ${JSON.stringify({ url: `/preview/${SID}/index.html` })}\n\n`);
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ requestUrl, url: `/preview/${SID}/index.html` }));
	});
	targetServer.on("upgrade", (req, socket) => {
		targetUpgrades.push(req.url ?? "");
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.end();
	});
	const targetPort = await listen(targetServer);
	targetOrigin = `http://127.0.0.1:${targetPort}`;
	process.env.GATEWAY_URL = `${targetOrigin}${MOUNT}`;

	devServer = http.createServer();
	const middleware = await configureDynamicProxy(devServer);
	devServer.on("request", (req, res) => middleware(req, res, () => {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not proxied");
	}));
	const devPort = await listen(devServer);
	devOrigin = `http://127.0.0.1:${devPort}`;
});

afterAll(async () => {
	if (originalGatewayUrl === undefined) delete process.env.GATEWAY_URL;
	else process.env.GATEWAY_URL = originalGatewayUrl;
	await Promise.all([close(devServer), close(targetServer)]);
});

const COOKIE = "bobbit_session";

describe.sequential("Vite mounted-gateway proxy", () => {
	it("joins the discovered target pathname for HTTP requests and query strings", async () => {
		const response = await fetch(`${devOrigin}/api/echo?value=1`);
		assert.equal(response.status, 200);
		const body = await response.json() as { requestUrl: string; url: string };
		assert.equal(body.requestUrl, `${MOUNT}/api/echo?value=1`);
		assert.equal(body.url, `/preview/${SID}/index.html`, "route-shaped JSON must remain mount-relative");
	});

	it("uses the same join for WebSocket upgrades", async () => {
		const devUrl = new URL(devOrigin);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(Number(devUrl.port), devUrl.hostname);
			let data = "";
			socket.setEncoding("utf8");
			socket.once("connect", () => socket.write([
				"GET /ws/viewer?token=sentinel HTTP/1.1",
				`Host: ${devUrl.host}`,
				"Connection: Upgrade",
				"Upgrade: websocket",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"",
				"",
			].join("\r\n")));
			socket.on("data", chunk => { data += chunk; });
			socket.once("end", () => resolve(data));
			socket.once("error", reject);
		});
		assert.match(response, /^HTTP\/1\.1 101/);
		assert.ok(targetUpgrades.includes(`${MOUNT}/ws/viewer?token=sentinel`));
	});

	it("rebases same-gateway Location and cookie Path while preserving external redirects", async () => {
		const redirect = await fetch(`${devOrigin}/api/location`, { redirect: "manual" });
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.get("location"), `/preview/${SID}/`);

		const external = await fetch(`${devOrigin}/api/external`, { redirect: "manual" });
		assert.equal(external.headers.get("location"), "https://elsewhere.example/landing");

		const cookie = await fetch(`${devOrigin}/api/cookie`);
		assert.match(cookie.headers.get("set-cookie") ?? "", /Path=\/(?:;|$)/);
		assert.doesNotMatch(cookie.headers.get("set-cookie") ?? "", new RegExp(`Path=${MOUNT.replaceAll("/", "\\/")}`));
	});

	it("rebases manifest browser paths to the root-mounted Vite UI", async () => {
		const response = await fetch(`${devOrigin}/manifest.json`);
		const manifest = await response.json() as any;
		assert.equal(manifest.start_url, "/?token=secret");
		assert.equal(manifest.scope, "/");
		assert.deepEqual(manifest.icons, [{ src: "/icon.png" }, { src: "relative.png" }]);
	});

	it("rewrites only the marked injected preview base", async () => {
		const response = await fetch(`${devOrigin}/preview/page`);
		const html = await response.text();
		assert.match(html, new RegExp(`<base data-bobbit-preview-base href="/preview/${SID}/">`));
		assert.match(html, /<base href="\/user-authored\/">/);
	});

	it("does not rewrite route-shaped SSE data", async () => {
		const response = await fetch(`${devOrigin}/api/events`);
		assert.equal(await response.text(), `data: ${JSON.stringify({ url: `/preview/${SID}/index.html` })}\n\n`);
	});

	it("keeps root target request joining as identity", async () => {
		process.env.GATEWAY_URL = targetOrigin;
		try {
			const response = await fetch(`${devOrigin}/api/root-target?value=2`);
			const body = await response.json() as { requestUrl: string };
			assert.equal(body.requestUrl, "/api/root-target?value=2");
		} finally {
			process.env.GATEWAY_URL = `${targetOrigin}${MOUNT}`;
		}
	});
});

describe("production runtime asset URL configuration", () => {
	it("uses the runtime base global for JS-hosted assets but relative CSS URLs", async () => {
		const config = await resolvedConfig("production");
		const renderBuiltUrl = config.experimental?.renderBuiltUrl;
		assert.equal(typeof renderBuiltUrl, "function", "production config must provide experimental.renderBuiltUrl");

		const jsResult = renderBuiltUrl("assets/lazy-route.js", { hostType: "js", type: "asset", hostId: "assets/app.js" });
		assert.equal(typeof jsResult, "object");
		assert.match(jsResult.runtime, /globalThis\.__BOBBIT_BASE_PATH__/);
		assert.match(jsResult.runtime, /assets\/lazy-route\.js/);
		const evaluateRuntime = (basePath: string) => Function("globalThis", `return (${jsResult.runtime});`)({ __BOBBIT_BASE_PATH__: basePath });
		assert.equal(evaluateRuntime(""), "/assets/lazy-route.js");
		assert.equal(evaluateRuntime("/team/bobbit"), "/team/bobbit/assets/lazy-route.js");

		const cssResult = renderBuiltUrl("assets/icon.svg", { hostType: "css", type: "asset", hostId: "assets/app.css" });
		if (typeof cssResult === "string") {
			assert.doesNotMatch(cssResult, /^\//);
			assert.equal(new URL(cssResult, "https://host.example/assets/app.css").pathname, "/assets/icon.svg");
		} else {
			assert.equal(cssResult?.relative, true);
		}

		const development = await resolvedConfig("development");
		assert.equal(development.experimental?.renderBuiltUrl, undefined, "Vite development must remain root-mounted");
	});

	const repoRoot = path.resolve(".");
	const assetsDir = path.resolve("dist/ui/assets");
	const hasFreshProductionBuild = validateDistBuild(repoRoot, computeDistBuildKey(repoRoot));
	it.skipIf(!hasFreshProductionBuild)("emits no Vite root-anchoring asset helper in the current production bundle", () => {
		const files = fs.readdirSync(assetsDir).filter(file => file.endsWith(".js"));
		assert.ok(files.length > 0, "dist/ui/assets must contain production JavaScript");
		const sources = files.map(file => fs.readFileSync(path.join(assetsDir, file), "utf8"));
		assert.ok(sources.some(source => source.includes("__BOBBIT_BASE_PATH__")), "emitted JavaScript must reference the runtime base-path global");
		const offenders = files.filter((_file, index) => /(?:return\s*|=>)\s*["']\/["']\s*\+/.test(sources[index]));
		assert.deepEqual(offenders, [], `Vite emitted a root-anchoring asset helper in: ${offenders.join(", ")}`);
	});
});
