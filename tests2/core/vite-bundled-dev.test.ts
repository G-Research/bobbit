import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";

import viteConfig from "../../vite.config.ts";

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
