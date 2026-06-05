/**
 * Bundle-size regression guard for the UI build.
 *
 * Asserts that:
 *   - the main `index-*.js` chunk is ≤ 250 KB gzipped
 *   - no non-worker `.js`/`.mjs` chunk exceeds 200 KB gzipped, except
 *     the unavoidable `pdf.worker.min-*.mjs` chunk
 *   - no non-worker `.js`/`.mjs` chunk exceeds 600 KB raw (pins Vite's
 *     `chunkSizeWarningLimit: 600`).
 *
 * Reads chunks from `dist/ui/assets/` and gzips each via `node:zlib`.
 * **Does not run a build itself** — that would double CI time. The test
 * is auto-discovered by `npm run test:unit` (via the `tests/*.test.ts`
 * pattern); run `npm run test:bundle` to build then assert in one shot.
 *
 * If `dist/ui/assets/` is missing the test is skipped with a message
 * pointing at the build command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST_DIR = new URL("../dist/ui", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ASSETS_DIR = join(DIST_DIR, "assets");
const MANIFEST_PATH = join(DIST_DIR, ".vite", "manifest.json");

// Budgets tightened after the bundle-shrink goal (Tasks A–F):
// entry chunk dropped from 360 KB gz → 153 KB gz, so a 250 KB gz
// budget leaves ~100 KB headroom for future small additions while
// catching any major regression. Per-chunk budget set at 200 KB gz
// to allow already-lazy provider chunks (`mistral` ~80 KB gz,
// `vendor-mini-lit` ~110 KB gz) but flag anything bigger.
// Raise these only after a measured wins-vs-costs trade-off.
const MAIN_BUDGET_BYTES = 250 * 1024;          // 250 KB gzipped
const PER_CHUNK_BUDGET_BYTES = 200 * 1024;     // 200 KB gzipped
const RAW_CHUNK_BUDGET_BYTES = 600 * 1024;     // 600 KB raw — pins the Vite `chunkSizeWarningLimit`
const CHUNK_RE = /\.(js|mjs)$/;
const WORKER_RE = /^pdf\.worker\.min-[^/]+\.mjs$/;

/**
 * Resolve the hashed filename of the main entry chunk via the Vite
 * manifest. Naive matching against `index-*.js` would be ambiguous —
 * dependencies (e.g. an `index.ts` re-export) can also produce
 * `index-<hash>.js` chunks.
 */
function resolveMainChunkFile(): string {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`vite manifest missing at ${MANIFEST_PATH} — ensure build.manifest is enabled`);
	}
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, { file: string; isEntry?: boolean }>;
	const entries = Object.values(manifest).filter((e) => e.isEntry);
	if (entries.length !== 1) {
		throw new Error(`expected exactly one entry in vite manifest, found ${entries.length}`);
	}
	return entries[0].file.replace(/^assets\//, "");
}

function gzippedSize(file: string): number {
	return gzipSync(readFileSync(file)).length;
}

function fmt(bytes: number): string {
	return `${(bytes / 1024).toFixed(2)} KB`;
}

test("UI bundle size — main chunk + per-chunk budgets", { skip: !existsSync(ASSETS_DIR) ? "dist/ui/assets/ missing — run `npm run build:ui` first" : false }, () => {
	const entries = readdirSync(ASSETS_DIR)
		.filter((name) => CHUNK_RE.test(name))
		.filter((name) => statSync(join(ASSETS_DIR, name)).isFile());

	assert.ok(entries.length > 0, `no .js/.mjs chunks found under ${ASSETS_DIR}`);

	// 1) Main entry chunk must be ≤ 600 KB gzipped.
	const mainFile = resolveMainChunkFile();
	assert.ok(entries.includes(mainFile), `manifest entry ${mainFile} not found in ${ASSETS_DIR}`);
	const mainSize = gzippedSize(join(ASSETS_DIR, mainFile));
	assert.ok(
		mainSize <= MAIN_BUDGET_BYTES,
		`main chunk ${mainFile} is ${fmt(mainSize)} gzipped, exceeds ${fmt(MAIN_BUDGET_BYTES)} budget`,
	);

	// 2) No non-worker chunk may exceed 200 KB gzipped.
	const offenders: string[] = [];
	for (const name of entries) {
		if (WORKER_RE.test(name)) continue; // pdf.worker is unavoidable
		const size = gzippedSize(join(ASSETS_DIR, name));
		if (size > PER_CHUNK_BUDGET_BYTES) {
			offenders.push(`${name} = ${fmt(size)}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`chunks exceeding per-chunk gzipped budget of ${fmt(PER_CHUNK_BUDGET_BYTES)}:\n  ${offenders.join("\n  ")}`,
	);

	// 3) No non-worker chunk may exceed 600 KB RAW. This pins Vite's
	//    `chunkSizeWarningLimit: 600` so a regression cannot silently
	//    re-introduce the warning without the test catching it.
	const rawOffenders: string[] = [];
	for (const name of entries) {
		if (WORKER_RE.test(name)) continue;
		const rawSize = statSync(join(ASSETS_DIR, name)).size;
		if (rawSize > RAW_CHUNK_BUDGET_BYTES) {
			rawOffenders.push(`${name} = ${fmt(rawSize)}`);
		}
	}
	assert.deepEqual(
		rawOffenders,
		[],
		`chunks exceeding per-chunk RAW budget of ${fmt(RAW_CHUNK_BUDGET_BYTES)} (would trip Vite's chunkSizeWarningLimit):\n  ${rawOffenders.join("\n  ")}`,
	);
});
