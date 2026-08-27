import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Plugin, UserConfig } from "vite";

import viteConfig, {
	configuredPublicViteHosts,
	isLocalVitePeer,
	packDevHotReload,
} from "../../vite.config.ts";

async function configFor(command: "serve" | "build", mode = "development"): Promise<UserConfig> {
	const raw = typeof viteConfig === "function"
		? viteConfig({ command, mode, isSsrBuild: false, isPreview: false })
		: viteConfig;
	return await Promise.resolve(raw) as UserConfig;
}

interface BridgeResponse {
	status: number;
	body: string;
	next: boolean;
	send: ReturnType<typeof vi.fn>;
	headers?: Record<string, string>;
}

async function invokePackBridge(options: {
	method?: string;
	url?: string;
	body?: string;
	remoteAddress?: string;
	headers?: Record<string, string>;
}): Promise<BridgeResponse> {
	const plugin = packDevHotReload();
	let middleware: ((req: any, res: any, next: () => void) => void) | undefined;
	const send = vi.fn();
	const server = {
		middlewares: { use(handler: typeof middleware) { middleware = handler; } },
		ws: { send },
	};
	const hook = plugin.configureServer;
	if (!hook) throw new Error("pack reload plugin must configure the Vite server");
	const configure = typeof hook === "function" ? hook : hook.handler;
	await configure.call({} as never, server as never);
	if (!middleware) throw new Error("pack reload plugin must install middleware");

	const body = options.body ?? "";
	const request = Readable.from(body ? [Buffer.from(body)] : []) as any;
	request.method = options.method ?? "POST";
	request.url = options.url ?? "/__bobbit_dev/pack-rebuilt";
	request.headers = options.headers ?? {};
	request.socket = { remoteAddress: options.remoteAddress ?? "127.0.0.1" };

	return await new Promise<BridgeResponse>((resolve) => {
		let status = 200;
		let responseBody = "";
		let responseHeaders: Record<string, string> | undefined;
		const response = {
			writeHead(code: number, headers?: Record<string, string>) {
				status = code;
				responseHeaders = headers;
			},
			end(chunk?: string) {
				responseBody += chunk ?? "";
				resolve({ status, body: responseBody, next: false, send, headers: responseHeaders });
			},
		};
		middleware!(request, response, () => resolve({ status, body: responseBody, next: true, send }));
	});
}

function pluginNamed(config: UserConfig, name: string): Plugin | undefined {
	return (config.plugins?.flat() ?? []).find(
		(plugin): plugin is Plugin => Boolean(plugin && "name" in plugin && plugin.name === name),
	);
}

describe("Vite pack authoring reload bridge", () => {
	it("is registered as a serve-only plugin", async () => {
		const development = await configFor("serve");
		const production = await configFor("build", "production");

		expect(pluginNamed(development, "bobbit-pack-dev-hot-reload")?.apply).toBe("serve");
		expect(pluginNamed(production, "bobbit-pack-dev-hot-reload")?.apply).toBe("serve");
	});

	it("accepts one bounded tokenized local POST and emits exactly one custom event", async () => {
		const result = await invokePackBridge({
			body: JSON.stringify({ pack: "file-explorer", reloadToken: 7 }),
		});

		expect(result.status).toBe(204);
		expect(result.body).toBe("");
		expect(result.send).toHaveBeenCalledTimes(1);
		expect(result.send).toHaveBeenCalledWith({
			type: "custom",
			event: "bobbit:pack-rebuilt",
			data: { pack: "file-explorer", reloadToken: 7 },
		});
	});

	it("passes unrelated paths through without mutating the HMR channel", async () => {
		const result = await invokePackBridge({
			url: "/__bobbit_dev/not-pack-rebuilt",
			body: JSON.stringify({ pack: "file-explorer", reloadToken: 1 }),
		});

		expect(result.next).toBe(true);
		expect(result.send).not.toHaveBeenCalled();
	});

	it("accepts loopback and assigned-interface peers only", async () => {
		const interfaces = {
			ethernet: [{ address: "192.0.2.20", netmask: "255.255.255.0", family: "IPv4" as const, mac: "", internal: false, cidr: "192.0.2.20/24" }],
		};
		expect(isLocalVitePeer("::ffff:127.0.0.1", interfaces)).toBe(true);
		expect(isLocalVitePeer("192.0.2.20", interfaces)).toBe(true);
		expect(isLocalVitePeer("192.0.2.21", interfaces)).toBe(false);

		const result = await invokePackBridge({
			remoteAddress: "203.0.113.50",
			body: JSON.stringify({ pack: "file-explorer", reloadToken: 1 }),
		});
		expect(result.status).toBe(403);
		expect(result.send).not.toHaveBeenCalled();
	});

	it.each([
		["wrong method", { method: "GET", body: "" }, 405],
		["malformed JSON", { body: "{" }, 400],
		["traversal pack", { body: JSON.stringify({ pack: "../file-explorer", reloadToken: 1 }) }, 400],
		["zero token", { body: JSON.stringify({ pack: "file-explorer", reloadToken: 0 }) }, 400],
		["fractional token", { body: JSON.stringify({ pack: "file-explorer", reloadToken: 1.5 }) }, 400],
		["extra fields", { body: JSON.stringify({ pack: "file-explorer", reloadToken: 1, extra: true }) }, 400],
		["oversize body", { body: JSON.stringify({ pack: `file-${"x".repeat(8192)}`, reloadToken: 1 }) }, 413],
	] as const)("rejects %s without mutating the HMR channel", async (_label, options, status) => {
		const result = await invokePackBridge(options);
		expect(result.status).toBe(status);
		expect(result.next).toBe(false);
		expect(result.send).not.toHaveBeenCalled();
	});
});

describe("Vite bundled development mode", () => {
	it("bundles the browser graph during serve to avoid the native-ESM request waterfall", async () => {
		const config = await configFor("serve");
		const plugins = config.plugins?.flat() ?? [];

		expect(config.experimental?.bundledDev).toBe(true);
		expect(config.experimental?.renderBuiltUrl).toBeUndefined();
		expect(plugins.map((plugin) => plugin && "name" in plugin ? plugin.name : ""))
			.not.toContain("batch-client-full-reloads");
	});

	it("allows the owned source-runtime smoke to inspect the native module graph", async () => {
		const previous = process.env.BOBBIT_VITE_SOURCE_GRAPH;
		process.env.BOBBIT_VITE_SOURCE_GRAPH = "1";
		try {
			const config = await configFor("serve");
			expect(config.experimental?.bundledDev).toBeUndefined();
			expect(config.experimental?.renderBuiltUrl).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_VITE_SOURCE_GRAPH;
			else process.env.BOBBIT_VITE_SOURCE_GRAPH = previous;
		}
	});

	it("allows the configured public hostname on the HMR WebSocket", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "bobbit-vite-host-"));
		try {
			writeFileSync(join(stateDir, "desec.json"), JSON.stringify({
				domain: "Mobile.Example.test.",
				token: "must-not-leak",
			}));
			expect(configuredPublicViteHosts(stateDir)).toEqual(["mobile.example.test"]);
			expect(JSON.stringify(configuredPublicViteHosts(stateDir))).not.toContain("must-not-leak");

			writeFileSync(join(stateDir, "desec.json"), JSON.stringify({ domain: "bad/host" }));
			expect(configuredPublicViteHosts(stateDir)).toEqual([]);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps Tailwind source detection out of non-UI agent edit paths", () => {
		const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8");

		expect(css).toContain('@import "tailwindcss" source(none)');
		expect(css).toContain('@source "../"');
		expect(css).toContain('@source "../../index.html"');
		expect(css).toContain('@source "../../node_modules/@mariozechner/mini-lit/dist"');
		expect(css).not.toMatch(/@source\s+["'][^"']*(?:tests|docs|\.bobbit)/);
	});

	it("guards Tailwind's unreleased bundled-dev hot-update fix", async () => {
		const config = await configFor("serve");
		const plugin = config.plugins?.flat().find(
			(candidate) => candidate && "name" in candidate && candidate.name === "@tailwindcss/vite:generate:serve",
		);
		expect(plugin).toBeDefined();
		const hotUpdate = plugin && "hotUpdate" in plugin ? plugin.hotUpdate : undefined;
		expect(hotUpdate).toEqual(expect.any(Function));

		// Vite bundled dev currently omits server/timestamp/read. Tailwind 4.3.3
		// dereferences server unless guarded (fixed upstream after that release).
		const invokeHotUpdate = hotUpdate as unknown as (this: object, options: object) => unknown;
		await expect(Promise.resolve(invokeHotUpdate.call({}, {
			type: "update",
			file: "src/app/main.ts",
			modules: [{ type: "asset" }],
		}))).resolves.toBeUndefined();
	});

	it("keeps production mount-aware URL rewriting separate from bundled dev", async () => {
		const config = await configFor("build", "production");

		expect(config.experimental?.bundledDev).toBeUndefined();
		expect(config.experimental?.renderBuiltUrl).toEqual(expect.any(Function));
	});
});
