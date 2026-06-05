import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	analysisBundleToParsedDiff,
	PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND,
	PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION,
} from "../src/server/pr-walkthrough/walkthrough-analysis-bundle.ts";
import type { PrWalkthroughAnalysisBundle } from "../src/server/pr-walkthrough/walkthrough-analysis-bundle.ts";

// Reproducing test for the PR walkthrough `hunkSignature` TypeError (Defect 2 —
// the data/contract defect). `PrWalkthroughHunk.header` is declared a required
// `string`, but the bundle-reconstruction path (`diffBlockFromBundleFile`, reached
// via `analysisBundleToParsedDiff`) copies `header: hunk.header` verbatim with no
// coercion. A bundle whose hunk omits `header` therefore reconstructs a hunk with
// `header === undefined`, which violates the contract and crashes the panel in the
// browser at `hunkSignature(header).match(...)`.
//
// This test MUST FAIL on current (unfixed) code: the reconstructed hunk header is
// `undefined`, so `typeof header === "string"` is false. After the producer fix it
// passes because the header is coerced to a string.

function bundleWithHeaderlessHunk(): PrWalkthroughAnalysisBundle {
	return {
		schema_version: PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION,
		kind: PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND,
		generated_at: "2026-06-01T00:00:00.000Z",
		job_id: "job-headerless",
		target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: 1, url: "https://github.com/SuuBro/bobbit/pull/1" },
		changeset: { base_sha: "base1234", head_sha: "head5678", title: "Header-less bundle", body: "", files_changed: 1, additions: 1, deletions: 0 },
		warnings: [],
		// The hunk intentionally OMITS `header`, mirroring a persisted bundle written
		// by a code revision that did not guarantee the field. Cast through `any`
		// because the bundle type declares `header: string` — the whole point is that
		// the runtime value can violate that declaration.
		files: [
			{
				path: "src/example.ts",
				is_binary: false,
				is_generated: false,
				is_truncated: false,
				hunks: [
					{
						id: "hunk-1",
						lines: [
							{ kind: "context", side: "context", old_line: 1, new_line: 1, text: "const unchanged = true;" },
							{ kind: "add", side: "new", new_line: 2, text: "const added = 1;" },
						],
					} as any,
				],
			},
		],
	} as PrWalkthroughAnalysisBundle;
}

function reconstructedHunks(bundle: PrWalkthroughAnalysisBundle): Array<{ id: string; header: unknown }> {
	const parsed = analysisBundleToParsedDiff(bundle) as any;
	const files: any[] = Array.isArray(parsed.files) ? parsed.files : [];
	return files.flatMap((file) => {
		const blocks: any[] = Array.isArray(file.diffBlocks) ? file.diffBlocks : [];
		return blocks.flatMap((block) => (Array.isArray(block.hunks) ? block.hunks : []));
	});
}

describe("PR walkthrough analysis-bundle hunk header contract", () => {
	it("reconstructs every hunk with a string header even when the persisted bundle omits it", () => {
		const hunks = reconstructedHunks(bundleWithHeaderlessHunk());
		assert.ok(hunks.length > 0, "expected analysisBundleToParsedDiff to reconstruct at least one hunk");
		for (const hunk of hunks) {
			assert.equal(
				typeof hunk.header,
				"string",
				`reconstructed hunk ${hunk.id} must carry a string header (PrWalkthroughHunk.header: string contract), but got ${typeof hunk.header} (${String(hunk.header)})`,
			);
		}
	});

	it("preserves a real hunk header unchanged while still guaranteeing a string", () => {
		const bundle = bundleWithHeaderlessHunk();
		(bundle.files[0].hunks[0] as any).header = "@@ -1,2 +1,3 @@ function example()";
		const hunks = reconstructedHunks(bundle);
		assert.equal(hunks.length, 1, "expected exactly one reconstructed hunk");
		assert.equal(typeof hunks[0].header, "string", "a present header must remain a string");
		assert.equal(hunks[0].header, "@@ -1,2 +1,3 @@ function example()", "a present header must be preserved verbatim");
	});
});
