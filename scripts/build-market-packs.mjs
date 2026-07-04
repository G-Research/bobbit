#!/usr/bin/env node
/**
 * Market-pack bundler — the command behind `npm run build:packs` (wired into
 * `npm run build`, so CI/E2E always get fresh bundles).
 *
 * CONVENTION (Extension Host Phase 2, Slice D1 parity hardening): a pack's CLIENT
 * contributions (renderers, panels) may now `import` npm deps in their SOURCE
 * (`market-packs/<pack>/src/*`). esbuild bundles each entry into a single,
 * self-contained ESM written to the pack's SERVED location. Each entry declares
 * its `out` path RELATIVE TO THE PACK ROOT (V1 schema), so tool renderers may
 * stay tool-local (`tools/<group>/<entry>.js`) while panels and other shared
 * bundles emit to the pack's `lib/` dir (`lib/<entry>.js`) — the new home for
 * shared implementation modules. The marketplace ships the BUILT assets as-is.
 * The built bundles are committed.
 *
 * Two hard rules make a bundle loadable by the Phase-1/2 client loader, which
 * imports the module via a Blob URL and hands it the host toolkit as a FACTORY
 * parameter (see src/app/pack-renderers.ts / pack-panels.ts):
 *   1. NEVER bundle `lit` — it is injected (`{ html, nothing, renderHeader }`).
 *      `lit`/`lit/*` are marked EXTERNAL; pack source must not import them.
 *   2. SINGLE self-contained file per entry — NO code splitting / dynamic chunks.
 *      A Blob-URL module has no resolvable base for `import("./chunk.js")`, so
 *      every dep (highlight.js, pdfjs-dist, docx-preview) is inlined eagerly.
 *
 * pdfjs WORKER: pdfjs needs a worker but a Blob-URL module cannot resolve a
 * sibling worker file and there is no pack-asset endpoint. We pre-bundle the
 * worker SOURCE to a string and expose it as the `virtual:pdf-worker` module; the
 * pack creates a Blob-URL `workerSrc` from it at runtime (see binary-render.ts).
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve a dep entry from the repo's node_modules (so the worker bundle below
 *  uses the SAME pdfjs the panel bundle does). */
function resolveDep(spec) {
	return require.resolve(spec, { paths: [projectRoot] });
}

// ── Pre-bundle the pdf.worker source to a string for `virtual:pdf-worker`. ──
async function bundlePdfWorker() {
	const workerEntry = resolveDep("pdfjs-dist/build/pdf.worker.min.mjs");
	// ESM (not IIFE) so BOTH worker-load paths resolve from the Blob URL: pdfjs's
	// `new Worker(workerSrc, { type: "module" })` AND its fake-worker fallback
	// `import(workerSrc)`. The worker is fully self-contained (no internal chunks).
	const result = await build({
		entryPoints: [workerEntry],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		minify: true,
		legalComments: "none",
		write: false,
	});
	return result.outputFiles[0].text;
}

/** esbuild plugin exposing the inlined pdf.worker source as `virtual:pdf-worker`. */
function pdfWorkerPlugin(workerSource) {
	return {
		name: "virtual-pdf-worker",
		setup(b) {
			b.onResolve({ filter: /^virtual:pdf-worker$/ }, () => ({
				path: "virtual:pdf-worker",
				namespace: "pdf-worker",
			}));
			b.onLoad({ filter: /.*/, namespace: "pdf-worker" }, () => ({
				contents: `export default ${JSON.stringify(workerSource)};`,
				loader: "js",
			}));
		},
	};
}

/**
 * Pack manifest: each entry's SOURCE (`market-packs/<pack>/src/<in>`) is bundled
 * to its SERVED path `market-packs/<pack>/<out>`, where `out` is RELATIVE TO THE
 * PACK ROOT. Tool renderers stay tool-local (`tools/<group>/<entry>.js`); panels
 * and other shared client bundles emit to `lib/`. Extend this when a pack adds a
 * bundled contribution.
 *
 * NOTE: a pack's hand-authored `.mjs` server modules (e.g. pr-walkthrough's
 * `lib/routes.mjs`) are NOT bundled — they are committed source served as-is and
 * are simply relocated to `lib/`; only CLIENT contributions go through esbuild.
 */
const PACKS = [
	{
		pack: "artifacts",
		entries: [
			// renderer stays tool-local (served as a PACK renderer by the tool endpoint).
			{ in: "ArtifactRenderer.ts", out: "tools/artifact_demo/ArtifactRenderer.js" },
			// panel bundle emits to the shared lib/ dir (auto-discovered panel entry).
			{ in: "ArtifactViewerPanel.ts", out: "lib/ArtifactViewerPanel.js" },
		],
	},
	{
		pack: "pr-walkthrough",
		entries: [
			// no-tools pack: the viewer panel bundle emits to lib/ (auto-discovered
			// from panels/pr-walkthrough-panel.yaml). routes.mjs is hand-authored and
			// relocated to lib/ — NOT bundled here.
			{ in: "panel.js", out: "lib/panel.js" },
			// SERVER-side synthesis bundle: the pure shared YAML→cards mapper (with its
			// `yaml` dep inlined), imported by the hand-authored routes.mjs `publish`
			// route in the confined NODE worker. platform:"node" so Buffer + node:* stay
			// node globals/builtins and are NOT browser-polyfilled. Emits `.mjs`.
			{ in: "yaml-to-cards.js", out: "lib/yaml-to-cards.mjs", platform: "node" },
		],
	},
	{
		pack: "experiment-runner",
		entries: [
			// CLIENT panel bundle: the four-view state-machine panel (mode-select →
			// define → confirm → dashboard). Emits to lib/ (auto-discovered from
			// panels/experiment-runner-panel.yaml). The hand-authored lib/routes.mjs +
			// other server lib modules are relocated as-is — NOT bundled here.
			{ in: "panel.js", out: "lib/panel.js" },
			// SERVER reporting bundle: the SINGLE SOURCE reporting library
			// (src/shared/experiment-report) bundled to lib/experiment-report.mjs.
			// The hand-authored adapters (aggregate/autoresearch/widgets/routes.mjs)
			// import from THIS generated file, so report logic never forks. `inFromRoot`
			// resolves from the repo root (not the pack src dir). platform:"node"
			// because routes run in the confined Node worker; the module is pure (no
			// node:* imports) so it also loads fine in the browser dashboard path.
			{ inFromRoot: "src/shared/experiment-report/index.ts", out: "lib/experiment-report.mjs", platform: "node" },
		],
	},
	{
		pack: "hindsight",
		entries: [
			// SERVER-side modules for the confined NODE worker (provider hooks + pack
			// routes), each authored in TS and bundled to lib/*.mjs with the REST client
			// inlined (provider.ts / routes.ts dynamic-import ./hindsight-client.js, which
			// esbuild inlines into each single self-contained file). platform:"node" so
			// Buffer + node:* stay node globals/builtins.
			{ in: "hindsight-client.ts", out: "lib/hindsight-client.mjs", platform: "node" },
			{ in: "provider.ts", out: "lib/provider.mjs", platform: "node" },
			{ in: "routes.ts", out: "lib/routes.mjs", platform: "node" },
			// CLIENT panel (browser): the native config/status surface (P4). `lit` stays
			// external (host-injected); the bundle is a single self-contained ESM emitted
			// to the shared lib/ dir, auto-discovered via panels/hindsight-memory.yaml.
			// Retained as a NON-entry compatibility panel — the session-menu/route entries
			// now target the embedded dashboard below.
			{ in: "panel.js", out: "lib/HindsightPanel.js" },
			// CLIENT panel (browser): the EMBEDDED DASHBOARD use surface. Opened by the
			// session-menu entry + #/ext/hindsight; renders the configured human `uiUrl`
			// in a sandboxed iframe. Auto-discovered via panels/hindsight-dashboard.yaml.
			{ in: "dashboard-panel.js", out: "lib/HindsightDashboardPanel.js" },
		],
	},
	{
		pack: "terminal",
		entries: [
			{ in: "terminal-panel.ts", out: "lib/terminal-panel.js" },
			{ in: "terminal-channel.ts", out: "lib/terminal-channel.mjs", platform: "node" },
		],
	},
];

async function main() {
	const workerSource = await bundlePdfWorker();
	const plugin = pdfWorkerPlugin(workerSource);

	for (const { pack, entries } of PACKS) {
		const packRoot = path.join(projectRoot, "market-packs", pack);
		const srcDir = path.join(packRoot, "src");
		for (const entry of entries) {
			// `inFromRoot` resolves from the repo root (for shared libs bundled into a
			// pack, e.g. src/shared/*); otherwise `in` resolves from the pack's src dir.
			const inFile = entry.inFromRoot ? path.join(projectRoot, entry.inFromRoot) : path.join(srcDir, entry.in);
			const outFile = path.join(packRoot, entry.out);
			await build({
				entryPoints: [inFile],
				outfile: outFile,
				bundle: true,
				format: "esm",
				// Most entries are CLIENT panels (browser); a server-side bundle (e.g.
				// pr-walkthrough's yaml-to-cards, run in the confined Node worker) opts
				// into platform:"node" so Buffer/node:* stay node globals/builtins.
				platform: entry.platform ?? "browser",
				target: "es2022",
				minify: true,
				legalComments: "none",
				// RULE 1 — lit is host-injected, never bundled.
				external: ["lit", "lit/*"],
				// RULE 2 — single self-contained file (no splitting).
				splitting: false,
				define: { "process.env.NODE_ENV": '"production"' },
				// platform:"node" ESM bundles need a real `require` so a bundled CJS dep
				// (e.g. `yaml`) that lazily `require("process")` resolves — ESM has no
				// implicit `require`, so esbuild's dynamic-require shim throws without this.
				...(entry.platform === "node"
					? { banner: { js: "import { createRequire as __bbCreateRequire } from 'node:module';\nconst require = __bbCreateRequire(import.meta.url);" } }
					: {}),
				plugins: [plugin],
				logLevel: "info",
			});
			// eslint-disable-next-line no-console
			console.log(`[build:packs] ${entry.inFromRoot ?? `${pack}/src/${entry.in}`} → ${pack}/${entry.out}`);
		}
	}
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error("[build:packs] failed:", err);
	process.exit(1);
});
