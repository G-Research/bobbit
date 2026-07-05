/**
 * Guard: generated `tests/fixtures/*-bundle.{js,css}` esbuild artifacts must
 * never be git-tracked.
 *
 * These are rebuilt on demand by tests/fixtures/build-bundle.ts (see the
 * .gitignore comment above `tests/fixtures/*-bundle.js` /
 * `tests/fixtures/*-bundle.css`) and are NOT read by any spec or fixture
 * HTML — esbuild just happens to emit a `.css` sidecar next to the `.js`
 * bundle whenever a bundled module transitively imports CSS. build-bundle.ts
 * deletes that sidecar after every build unless it already existed on disk
 * (`keepCss`/`cssSidecarExisted` in cleanupCssSidecar), so the *only* way one
 * of these files stays around is if it got git-committed by mistake — at
 * which point `git checkout` re-materializes it on every fresh worktree, the
 * next `test:unit` run silently overwrites it with fresh esbuild output, and
 * `git status` shows a permanent, unreviewable diff.
 *
 * Repro (pre-fix): tests/fixtures/children-tool-renderers-bundle.css and
 * tests/fixtures/git-status-widget-states-bundle.css were both force-added
 * against the .gitignore pattern above. Every `npm run test:unit` run that
 * touched either fixture regenerated the CSS and left the worktree dirty —
 * confirmed non-machine-specific (byte-identical across independent
 * rebuilds, no absolute paths) pure content drift, not churn. See PR that
 * added this test for the full classification.
 *
 * This test would have caught the mistaken `git add -f` at commit time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("generated fixture bundles are not git-tracked", () => {
	it("no tests/fixtures/*-bundle.{js,css} file is tracked in git", () => {
		const out = execFileSync("git", ["ls-files", "tests/fixtures"], {
			cwd: projectRoot,
			encoding: "utf-8",
		});
		const tracked = out.split("\n").filter(Boolean);
		const offenders = tracked.filter((f) => /-bundle\.(js|css)$/.test(f));
		assert.deepEqual(
			offenders,
			[],
			`generated bundle artifact(s) are git-tracked, which will go dirty on every rebuild: ${offenders.join(", ")}. ` +
				"Run `git rm --cached <file>` — .gitignore already excludes tests/fixtures/*-bundle.{js,css}.",
		);
	});
});
