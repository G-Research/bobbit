/**
 * Pinning test for the "Consistent Error Modals" goal.
 *
 * Every `showConnectionError(...)` call site listed below originates from
 * either a `fetch` Response or a caught `Error`. To match the rest of the
 * app, each one MUST forward `{ code, stack }` to the modal so the
 * `<error-details>` component can render the structured payload.
 *
 * Before the fix:
 *   - The listed call sites pass only `(title, message)` — no opts.
 *     This test fails with a clear message naming the offending file + title.
 * After the fix:
 *   - Each call site passes `(title, message, { code, stack })` (typically
 *     via `errorDetails(err)` or `errorFromResponse(res, ...)`).
 *
 * Source of truth: docs/design — "Consistent Error Modals" goal analysis.
 * If you add a new modal call site, add it here too. If you legitimately
 * cannot supply `code`/`stack` (e.g. a guard-style "no project selected"
 * call), keep the title distinct from the entries below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

interface Site {
	file: string;
	title: string;
	/** How many occurrences of this (file, title) pair are expected. Default 1. */
	count?: number;
}

const REQUIRED_CALL_SITES: Site[] = [
	{ file: "src/app/role-manager-page.ts", title: "Failed to create role assistant" },
	{ file: "src/app/tool-manager-page.ts", title: "Failed to create tool assistant" },
	{ file: "src/app/dialogs.ts", title: "Failed to create goal assistant" },
	{ file: "src/app/dialogs.ts", title: "Failed to create project assistant" },
	// 4 = 2 legacy `showProjectDialog` + 2 V2 `showProjectDialogV2`
	// (each dialog handles both the !res.ok branch and the catch branch).
	{ file: "src/app/dialogs.ts", title: "Failed to archive .bobbit/", count: 4 },
	// 2 = 1 legacy + 1 V2 (symlink-confirm retry path in each).
	{ file: "src/app/dialogs.ts", title: "Failed to register project", count: 2 },
	{ file: "src/app/proposal-panels.ts", title: "Failed to create goal", count: 2 },
	{ file: "src/app/session-manager.ts", title: "Connection Failed" },
];

/**
 * Extract the argument list of a `showConnectionError(` call starting at
 * `startIdx` (the index of the opening `(`). Returns the raw text BETWEEN
 * the parens (excluding them), respecting nested parens and string
 * literals (single, double, backtick — with backslash escapes).
 */
function extractArgs(src: string, openParenIdx: number): string {
	let depth = 1;
	let i = openParenIdx + 1;
	let inStr: string | null = null;
	let escape = false;
	while (i < src.length && depth > 0) {
		const c = src[i];
		if (inStr) {
			if (escape) escape = false;
			else if (c === "\\") escape = true;
			else if (c === inStr) inStr = null;
		} else {
			if (c === '"' || c === "'" || c === "`") inStr = c;
			else if (c === "(") depth++;
			else if (c === ")") depth--;
		}
		i++;
	}
	// i is one past the matching `)`. Strip the trailing `)`.
	return src.slice(openParenIdx + 1, i - 1);
}

/** Find every `showConnectionError(` call in `src` whose first arg is a
 *  string literal equal to `title`, and return the raw arg list per call. */
function findCallsForTitle(src: string, title: string): string[] {
	const needle = "showConnectionError(";
	const out: string[] = [];
	let from = 0;
	while (true) {
		const idx = src.indexOf(needle, from);
		if (idx < 0) break;
		const openParen = idx + needle.length - 1;
		const args = extractArgs(src, openParen);
		from = openParen + args.length + 2; // advance past `)`

		// Match the title literally as a "..." or '...' or `...` first arg.
		// Allow leading whitespace.
		const lit = args.trimStart();
		const quoted =
			lit.startsWith(`"${title}"`) ||
			lit.startsWith(`'${title}'`) ||
			lit.startsWith(`\`${title}\``);
		if (quoted) out.push(args);
	}
	return out;
}

function hasCodeAndStack(args: string): boolean {
	// Require both identifiers to appear (e.g. `{ code, stack }`,
	// `{ code: ..., stack: ... }`, or spread of `errorDetails(...)` result
	// which expands to `{ message, code, stack }`).
	return /\bcode\b/.test(args) && /\bstack\b/.test(args);
}

describe("Consistent error modals — call-site pinning", () => {
	for (const site of REQUIRED_CALL_SITES) {
		const expectedCount = site.count ?? 1;
		const label = `${site.file} :: "${site.title}" forwards { code, stack }`;
		it(label, () => {
			const abs = path.resolve(site.file);
			assert.ok(fs.existsSync(abs), `source file missing: ${site.file}`);
			const src = fs.readFileSync(abs, "utf8");

			const calls = findCallsForTitle(src, site.title);
			assert.equal(
				calls.length,
				expectedCount,
				`expected ${expectedCount} showConnectionError(${JSON.stringify(site.title)}, ...) ` +
					`call(s) in ${site.file}, found ${calls.length}. ` +
					`If you moved the call, update REQUIRED_CALL_SITES.`,
			);

			for (const args of calls) {
				assert.ok(
					hasCodeAndStack(args),
					`showConnectionError(${JSON.stringify(site.title)}, ...) in ${site.file} ` +
						`must forward { code, stack } opts so <error-details> can render the ` +
						`server stack. Current call:\n    showConnectionError(${args})`,
				);
			}
		});
	}
});
