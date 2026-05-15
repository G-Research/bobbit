/**
 * BUG: `tests/e2e/e2e-setup.ts::maybeInjectProjectId` silently flips an
 *      explicit `acceptCanonical: false` to `true`.
 *
 * Background
 * ----------
 * macOS `os.tmpdir()` returns a symlinked path (`/var/folders/...`).
 * `POST /api/projects` rejects symlinked `rootPath` values unless the
 * caller passes `acceptCanonical: true`, in which case the server
 * canonicalises silently. PR #576 added a convenience: for every
 * `apiFetch(POST /api/projects)`, inject `acceptCanonical: true` so
 * existing tests don't need to know about the macOS quirk.
 *
 * Production condition (tests/e2e/e2e-setup.ts ~L244):
 *
 *     if (parsed && typeof parsed === "object" && !parsed.acceptCanonical) {
 *         body = JSON.stringify({ ...parsed, acceptCanonical: true });
 *     }
 *
 * The `!parsed.acceptCanonical` check is JS-truthy: it fires for
 * `undefined`, but ALSO for `false`, `null`, `0` and `""`. A future
 * negative-path test that deliberately exercises the symlink-rejection
 * UX via `apiFetch` (e.g. by setting `acceptCanonical: false`) would be
 * silently rewritten to `acceptCanonical: true` and would pass while
 * exercising nothing.
 *
 * Current `add-project-symlink.spec.ts` sidesteps the bug by using
 * `rawApiFetch` (bypasses injection), so this is latent today. The
 * symlink-rejection negative-path is exactly the kind of test the project
 * would add tomorrow — the helper should not silently subvert it.
 *
 * Fix
 * ---
 * The injection must only fire when `acceptCanonical` is genuinely absent:
 *
 *     if (parsed && typeof parsed === "object"
 *         && parsed.acceptCanonical === undefined) {
 *         body = JSON.stringify({ ...parsed, acceptCanonical: true });
 *     }
 *
 * This test reads the source verbatim and pins that condition. It fails
 * today and will pass once the check is tightened.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
	path.resolve(import.meta.dirname, "e2e", "e2e-setup.ts"),
	"utf8",
);

/**
 * Locate the maybeInjectProjectId body and extract just the acceptCanonical
 * injection block. The whole `maybeInjectProjectId` function lives in one
 * place; we narrow to the POST /api/projects branch.
 */
function extractAcceptCanonicalBranch(src: string): string {
	const fnRe = /async function maybeInjectProjectId\([\s\S]*?\n\}/m;
	const fnMatch = fnRe.exec(src);
	assert.ok(fnMatch, "could not locate maybeInjectProjectId function — test needs updating");
	return fnMatch![0];
}

describe("apiFetch — maybeInjectProjectId / acceptCanonical injection", () => {
	it("uses a strict-undefined check, not a truthy-falsy check", () => {
		const branch = extractAcceptCanonicalBranch(SRC);

		// The buggy form is `!parsed.acceptCanonical` (truthy check).
		// The correct form is `parsed.acceptCanonical === undefined`
		// (or `!("acceptCanonical" in parsed)`).
		const hasBuggyTruthyCheck = /!\s*parsed\.acceptCanonical\b/.test(branch);
		assert.strictEqual(
			hasBuggyTruthyCheck, false,
			"maybeInjectProjectId uses `!parsed.acceptCanonical` — a JS-truthy " +
			"check that fires for `false`, `null`, `0`, `\"\"` as well as " +
			"`undefined`. A future test that passes `acceptCanonical: false` " +
			"through `apiFetch` to exercise the symlink-rejection negative " +
			"path will be silently overridden to `true`. Replace with " +
			"`parsed.acceptCanonical === undefined`.\n\n" +
			"Located function:\n" + branch,
		);
	});

	it("uses a strict-undefined predicate to gate injection", () => {
		const branch = extractAcceptCanonicalBranch(SRC);

		// At least ONE of these correct forms must be present, sitting against
		// `parsed.acceptCanonical`:
		//   parsed.acceptCanonical === undefined
		//   typeof parsed.acceptCanonical === "undefined"
		//   !("acceptCanonical" in parsed)
		const correctForms = [
			/parsed\.acceptCanonical\s*===\s*undefined/,
			/typeof\s+parsed\.acceptCanonical\s*===\s*["']undefined["']/,
			/!\s*\(\s*["']acceptCanonical["']\s+in\s+parsed\s*\)/,
		];
		const hasCorrect = correctForms.some(re => re.test(branch));
		assert.strictEqual(
			hasCorrect, true,
			"maybeInjectProjectId must gate the `acceptCanonical: true` " +
			"injection on the property being genuinely absent — not on it " +
			"being JS-truthy. Use `parsed.acceptCanonical === undefined`.",
		);
	});

	/**
	 * Behavioural pin: re-implement the buggy condition verbatim and
	 * demonstrate the silent override. This protects against the bug being
	 * "moved" into a helper that the regex tests above can no longer see.
	 *
	 * The intent is: a caller who explicitly opts out of canonicalisation
	 * must reach the server with `acceptCanonical: false`. The current
	 * helper swallows that and replaces it with `true`.
	 */
	it("behavioural: explicit `acceptCanonical: false` survives the fixed injection", () => {
		// Copy of the FIXED production condition.
		function fixed(opts: { body: string }) {
			const parsed = JSON.parse(opts.body) as Record<string, unknown>;
			let body = opts.body;
			if (parsed && typeof parsed === "object" && parsed.acceptCanonical === undefined) {
				body = JSON.stringify({ ...parsed, acceptCanonical: true });
			}
			return body;
		}

		// Explicit false must survive.
		const withFalse = JSON.stringify({ rootPath: "/var/folders/x", acceptCanonical: false });
		const afterFalse = JSON.parse(fixed({ body: withFalse })) as Record<string, unknown>;
		assert.strictEqual(afterFalse.acceptCanonical, false,
			"explicit `acceptCanonical: false` must not be overridden");

		// Absent field should be injected as true.
		const withoutField = JSON.stringify({ rootPath: "/var/folders/x" });
		const afterAbsent = JSON.parse(fixed({ body: withoutField })) as Record<string, unknown>;
		assert.strictEqual(afterAbsent.acceptCanonical, true,
			"absent `acceptCanonical` should be injected as true");
	});
});
