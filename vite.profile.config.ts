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
import { mergeConfig, type UserConfig } from "vite";
import baseConfig from "./vite.config";

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

// `defineConfig` callable form preserves base plugins from vite.config.ts.
export default mergeConfig(baseConfig as UserConfig, profileConfig);
