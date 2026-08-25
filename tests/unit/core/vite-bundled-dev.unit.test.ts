import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";

import viteConfig, { configuredPublicViteHosts } from "../../../vite.config.ts";

async function configFor(command: "serve" | "build", mode = "development"): Promise<UserConfig> {
	const raw = typeof viteConfig === "function"
		? viteConfig({ command, mode, isSsrBuild: false, isPreview: false })
		: viteConfig;
	return await Promise.resolve(raw) as UserConfig;
}

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
		const css = readFileSync(new URL("../../../src/ui/app.css", import.meta.url), "utf8");

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
