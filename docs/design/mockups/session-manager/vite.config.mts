import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: here,
	base: "./",
	plugins: [tailwindcss()],
	define: { "globalThis.__BOBBIT_DEV__": "false" },
	build: {
		outDir: path.resolve(here, "../../../../.bobbit-qa/session-manager-dist"),
		emptyOutDir: true,
		target: "esnext",
		modulePreload: { polyfill: false },
	},
});
