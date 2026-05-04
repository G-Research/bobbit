/**
 * §G — Pre-first-paint chunk-size budget.
 *
 * The bootstrap (`src/app/main.ts`) must execute before the browser can
 * fire `init:first-paint` and hide the static skeleton. Every byte of JS
 * that is statically reachable from the entry chunk lands in the network
 * fetch + parse + execute window between `pageshow` and `init:first-paint`
 * — the exact window §G is shrinking.
 *
 * This test reads `dist/ui/.vite/manifest.json`, walks the entry chunk's
 * static-import closure (via the `imports[]` arrays — `dynamicImports[]`
 * are deferred and don't block first paint), and asserts the total
 * gzipped size is below the budget.
 *
 * Budget rationale: 50 kB gzipped. The §G refactor lifted main.ts from
 * 353 kB → ~12 kB by deferring session-manager / render / api / dialogs /
 * goal-entry / ChatPanel from the static-import set. The skeleton in
 * index.html paints from HTTP cache without JS, and `init:first-paint`
 * is now stamped right after `installResumeHooks` + a few cheap state
 * setters. 50 kB leaves headroom (4x current) before someone has to
 * actively undo the split.
 *
 * If you blow this budget: don't bump it. Find what newly landed in the
 * entry chunk (most often a barrel re-export from `src/ui/index.js`) and
 * either lazy-import it or import directly from the leaf module. See
 * `scripts/measure-pre-fp-chunk.mjs` for a per-chunk breakdown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST_DIR = new URL("../dist/ui", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MANIFEST_PATH = join(DIST_DIR, ".vite", "manifest.json");
const ASSETS_DIR = join(DIST_DIR, "assets");

const BUDGET_BYTES = 50 * 1024; // 50 kB gzipped

interface Entry {
	file: string;
	isEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
}

function fmt(b: number): string {
	return `${(b / 1024).toFixed(2)} KB`;
}

test(
	"pre-first-paint chunk closure stays under §G budget",
	{ skip: !existsSync(MANIFEST_PATH) ? "vite manifest missing — run `npm run build:ui` first" : false },
	() => {
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, Entry>;

		const entries = Object.entries(manifest).filter(([, e]) => e.isEntry);
		assert.equal(entries.length, 1, `expected exactly one entry in manifest, found ${entries.length}`);
		const [entryKey] = entries[0];

		// Walk static imports only; dynamicImports are deferred and don't
		// block first paint.
		const visited = new Set<string>();
		const queue: string[] = [entryKey];
		while (queue.length) {
			const k = queue.shift()!;
			if (visited.has(k)) continue;
			visited.add(k);
			const e = manifest[k];
			if (!e) continue;
			for (const i of e.imports ?? []) queue.push(i);
		}

		const breakdown: Array<{ key: string; file: string; gz: number }> = [];
		let total = 0;
		for (const k of visited) {
			const e = manifest[k];
			if (!e?.file) continue;
			const file = join(DIST_DIR, e.file);
			if (!existsSync(file)) continue;
			const gz = gzipSync(readFileSync(file)).length;
			total += gz;
			breakdown.push({ key: k, file: e.file, gz });
		}
		breakdown.sort((a, b) => b.gz - a.gz);

		assert.ok(
			total <= BUDGET_BYTES,
			`pre-first-paint chunk closure is ${fmt(total)} gzipped, exceeds ${fmt(BUDGET_BYTES)} budget.\n` +
			`Breakdown:\n` +
			breakdown
				.map((r) => `  ${fmt(r.gz).padStart(10)}  ${r.file}  (${r.key})`)
				.join("\n") +
			`\nTo investigate: node scripts/measure-pre-fp-chunk.mjs`,
		);

		// Also assert the closure is small enough that we haven't accidentally
		// lifted only ./assets — a sanity check guarding against an empty
		// closure that would silently pass.
		assert.ok(visited.size > 0, "expected at least one chunk in entry static-import closure");
	},
);

// Sibling assertion: the assets directory contains the entry's static
// closure files. Catches the case where a previous build was deleted but
// the manifest pointed at stale chunks.
test(
	"pre-first-paint chunk files exist on disk",
	{ skip: !existsSync(MANIFEST_PATH) ? "vite manifest missing — run `npm run build:ui` first" : false },
	() => {
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, Entry>;
		const entries = Object.entries(manifest).filter(([, e]) => e.isEntry);
		assert.equal(entries.length, 1);
		const [entryKey] = entries[0];
		const entry = manifest[entryKey];
		assert.ok(existsSync(join(DIST_DIR, entry.file)), `entry chunk missing: ${entry.file}`);
		assert.ok(existsSync(ASSETS_DIR), `assets dir missing: ${ASSETS_DIR}`);
	},
);
