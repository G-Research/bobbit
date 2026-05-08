/**
 * Inline theme-token snapshot for preview HTML served at `/preview/<sid>/...`.
 *
 * Why: the runtime `PREVIEW_THEME_BRIDGE` reads CSS custom properties from
 * `parent.document.documentElement`. In a standalone tab `parent === window`,
 * so the bridge silently no-ops and the preview document has no theme vars
 * defined — `var(--background)` etc. resolve to empty.
 *
 * Fix: snapshot the canonical `:root` and `.dark` `--*` declarations from
 * `src/ui/app.css` once at startup and inject them as an inline `<style>`
 * block into every served HTML preview document. The runtime bridge still
 * runs in embedded iframes (where `parent !== window`) so live theme toggles
 * continue to flow into already-mounted previews; in standalone tabs the
 * inline snapshot governs.
 *
 * Approach: forgiving line-by-line scan over `app.css`. We track block depth
 * with a brace counter and capture every `--name: value;` declaration inside
 * any top-level `:root { ... }` or `.dark { ... }` block. Multiple `:root`
 * blocks (the file has several — palette overrides, notification colours,
 * etc.) all merge into a single emitted `:root { ... }` and similarly for
 * `.dark`. Comments are stripped. No HTML-parser, no CSS-parser dependency.
 *
 * On parse failure we return an empty string and `console.warn` — the
 * preview route stays functional, just without a theme snapshot.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;

/**
 * Walk up from `start` looking for `package.json` to find the repo root.
 * Works equally for `src/server/preview/` (ts-node / dev) and
 * `dist/server/preview/` (built). Stops at filesystem root.
 */
function findRepoRoot(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 16; i++) {
		const pkg = path.join(dir, "package.json");
		if (fs.existsSync(pkg)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Strip C-style block comments and `//` line comments. CSS doesn't actually
 * support `//` but we tolerate it. Block comments span lines.
 */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Parse `:root` and `.dark` blocks at depth 1 (i.e. top-level), collecting
 * `--name: value;` declarations from each. Nested at-rules are skipped.
 *
 * Returns `{ root, dark }` — each a record of token name → declared value.
 * Later declarations override earlier ones (last-wins, matching CSS).
 */
export function parseThemeBlocks(css: string): { root: Record<string, string>; dark: Record<string, string> } {
	const cleaned = stripComments(css);
	const root: Record<string, string> = {};
	const dark: Record<string, string> = {};

	// Match selector + body of every top-level rule. We use a hand-rolled
	// scanner to track brace depth, since regex alone can't balance braces.
	let i = 0;
	const N = cleaned.length;
	while (i < N) {
		// Find the next selector start: skip whitespace and at-rules.
		// Skip whitespace.
		while (i < N && /\s/.test(cleaned[i]!)) i++;
		if (i >= N) break;

		// At-rules like `@media`, `@import`, `@source`, `@keyframes` may be
		// terminated by `;` (no body) or contain a brace block. We need to
		// skip them entirely without recursing into their body.
		if (cleaned[i] === "@") {
			// Find first `{` or `;`. If `;` first → simple at-rule, skip past.
			// If `{` first → block at-rule, skip the matching `}`.
			let j = i + 1;
			while (j < N && cleaned[j] !== "{" && cleaned[j] !== ";") j++;
			if (j >= N) break;
			if (cleaned[j] === ";") {
				i = j + 1;
				continue;
			}
			// Block — find matching `}`.
			let depth = 1;
			j++;
			while (j < N && depth > 0) {
				if (cleaned[j] === "{") depth++;
				else if (cleaned[j] === "}") depth--;
				j++;
			}
			i = j;
			continue;
		}

		// Capture selector until `{` (or end).
		const selStart = i;
		while (i < N && cleaned[i] !== "{" && cleaned[i] !== ";") i++;
		if (i >= N || cleaned[i] === ";") {
			// Stray `;` at top level — skip.
			if (i < N) i++;
			continue;
		}
		const selector = cleaned.slice(selStart, i).trim();
		// Skip past `{`, capture body until matching `}`.
		i++;
		const bodyStart = i;
		let depth = 1;
		while (i < N && depth > 0) {
			if (cleaned[i] === "{") depth++;
			else if (cleaned[i] === "}") depth--;
			if (depth > 0) i++;
		}
		const body = cleaned.slice(bodyStart, i);
		// Past the closing `}`.
		if (i < N) i++;

		// Selector list may be e.g. `:root, [data-foo]`. Match if any segment
		// is exactly `:root` or `.dark`.
		const segments = selector.split(",").map(s => s.trim());
		const isRoot = segments.some(s => s === ":root");
		const isDark = segments.some(s => s === ".dark");
		if (!isRoot && !isDark) continue;

		// Extract `--name: value;` pairs from body. Tolerate values that
		// contain `:` (e.g. `url(...)`) — we split on the FIRST colon.
		// Skip nested rules inside the body (shouldn't appear but be safe).
		const decls = body.replace(/\{[^{}]*\}/g, "");
		// Split on `;` at depth 0 (parens balanced) to keep e.g.
		// `oklch(0.21 0.008 145)` intact.
		const parts: string[] = [];
		let buf = "";
		let parenDepth = 0;
		for (let k = 0; k < decls.length; k++) {
			const ch = decls[k]!;
			if (ch === "(") parenDepth++;
			else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
			if (ch === ";" && parenDepth === 0) {
				parts.push(buf);
				buf = "";
			} else {
				buf += ch;
			}
		}
		if (buf.trim().length > 0) parts.push(buf);

		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed.startsWith("--")) continue;
			const colon = trimmed.indexOf(":");
			if (colon < 0) continue;
			const name = trimmed.slice(0, colon).trim();
			const value = trimmed.slice(colon + 1).trim();
			if (!/^--[a-zA-Z0-9_-]+$/.test(name)) continue;
			if (!value) continue;
			if (isRoot) root[name] = value;
			if (isDark) dark[name] = value;
		}
	}

	return { root, dark };
}

/**
 * Build the inline `<style>` block string. Returns "" on parse failure.
 */
function buildSnapshot(): string {
	const repoRoot = findRepoRoot(__dirname);
	if (!repoRoot) {
		console.warn("[preview/theme-snapshot] could not locate repo root from", __dirname);
		return "";
	}
	const cssPath = path.join(repoRoot, "src", "ui", "app.css");
	let css: string;
	try {
		css = fs.readFileSync(cssPath, "utf-8");
	} catch (e) {
		console.warn(`[preview/theme-snapshot] failed to read ${cssPath}:`, e);
		return "";
	}

	let parsed: { root: Record<string, string>; dark: Record<string, string> };
	try {
		parsed = parseThemeBlocks(css);
	} catch (e) {
		console.warn("[preview/theme-snapshot] parse failed:", e);
		return "";
	}

	const rootEntries = Object.entries(parsed.root);
	const darkEntries = Object.entries(parsed.dark);
	if (rootEntries.length === 0 && darkEntries.length === 0) {
		console.warn("[preview/theme-snapshot] no --* declarations found in :root or .dark");
		return "";
	}

	const fmt = (entries: Array<[string, string]>) =>
		entries.map(([k, v]) => `\t${k}: ${v};`).join("\n");

	const blocks: string[] = [];
	if (rootEntries.length > 0) blocks.push(`:root {\n${fmt(rootEntries)}\n}`);
	if (darkEntries.length > 0) blocks.push(`.dark {\n${fmt(darkEntries)}\n}`);

	return `<style data-bobbit-preview-theme="snapshot">\n${blocks.join("\n")}\n</style>`;
}

/**
 * Cached accessor — parses on first call, returns the cached string thereafter.
 */
export function getPreviewThemeSnapshot(): string {
	if (cached !== null) return cached;
	cached = buildSnapshot();
	return cached;
}

/** Reset the cache. Test-only. */
export function _resetPreviewThemeSnapshotCache(): void {
	cached = null;
}
