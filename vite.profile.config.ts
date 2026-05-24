/**
 * Vite config for bundle profiling.
 *
 * Extends the normal build config with `rollup-plugin-visualizer` so we
 * can see exactly what is sitting in each chunk after every regression.
 *
 * Usage:
 *
 *     npx vite build -c vite.profile.config.ts
 *     # then open bundle-stats.html (and bundle-stats.json if you want
 *     # to grep the tree from the CLI).
 *
 * See `docs/perf/bundle-profile.md` for the full workflow and how to
 * read the output. Keep this file checked in — it is the canonical
 * profiling entry point referenced by the design doc and tests.
 */
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from "vite";
import baseConfigFactory from "./vite.config";

const profileConfig: UserConfig = {
	build: {
		rollupOptions: {
			plugins: [
				visualizer({
					filename: "bundle-stats.html",
					template: "treemap",
					gzipSize: true,
					brotliSize: false,
					sourcemap: false,
					emitFile: false,
				}),
				visualizer({
					filename: "bundle-stats.json",
					template: "raw-data",
					gzipSize: true,
					brotliSize: false,
					sourcemap: false,
					emitFile: false,
				}),
			],
		},
	},
};

// `vite.config.ts` exports a function form (`defineConfig(({mode}) => ({...}))`)
// so its `define` block can read the build mode. Vite's `mergeConfig` rejects
// function configs with "Cannot merge config in form of callback", so we
// resolve the base config against the current env first, then merge.
export default defineConfig((env: ConfigEnv): UserConfig => {
	const factory = baseConfigFactory as unknown as ((env: ConfigEnv) => UserConfig) | UserConfig;
	const base: UserConfig = typeof factory === "function" ? factory(env) : factory;
	return mergeConfig(base, profileConfig);
});
