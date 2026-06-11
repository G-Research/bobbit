/**
 * Guard test (host.agents reviewer migration, design Decision F Phase 3 / acceptance:
 * "No `BOBBIT_WALKTHROUGH_SUBMIT_PROOF` / proof header remains in the tree"): the
 * legacy PR-walkthrough submit-proof secret is GONE. The reviewer is now an isolated
 * read-only `host.agents` child; submit authorization is the `pr-reviewer`-only tool
 * grant + the pack-store binding keyed by the verified caller session id. No env var,
 * no proof header, no proof hashing helpers survive anywhere in the SHIPPED surface
 * (`src/` + `defaults/`).
 *
 * FRAGMENT TRICK: this test lives inside `tests/`, but it scans only `src/` + `defaults/`
 * so it never scans itself. As a belt-and-braces measure the forbidden needles are still
 * ASSEMBLED FROM CONCATENATED FRAGMENTS so no complete forbidden token appears literally
 * in this source either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Assemble a needle from fragments so the complete token never appears literally. */
const frag = (...parts: string[]): string => parts.join("");

// The submit-proof tokens that must NOT survive anywhere in the shipped surface.
const FORBIDDEN = [
	frag("BOBBIT_WALKTHROUGH_", "SUBMIT_", "PROOF"),
	frag("x-bobbit-walkthrough-", "submit-", "proof"),
	frag("submission", "Proof"),
	frag("create", "Submission", "Proof"),
	frag("hash", "Submission", "Proof"),
	frag("verify", "Submission", "Proof"),
	frag("rotate", "Submission", "Proof"),
	frag("walkthrough", "TargetEnvForJob"),
];

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function collectFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			out.push(...collectFiles(abs));
		} else if (e.isFile() && TEXT_EXT.has(path.extname(e.name))) {
			out.push(abs);
		}
	}
	return out;
}

const ROOTS = ["src", "defaults"].map((r) => path.join(REPO_ROOT, r));

describe("PR walkthrough submit-proof secret removal (no residual tokens)", () => {
	it("contains no submit-proof env var, header, or hashing helpers in src/ + defaults/", () => {
		const files = ROOTS.flatMap(collectFiles);
		assert.ok(files.length > 0, "expected to scan source files under src/ + defaults/");
		const hits: string[] = [];
		for (const abs of files) {
			let text: string;
			try { text = fs.readFileSync(abs, "utf8"); }
			catch { continue; }
			const lower = text.toLowerCase();
			for (const needle of FORBIDDEN) {
				if (lower.includes(needle.toLowerCase())) {
					hits.push(`${path.relative(REPO_ROOT, abs)} :: ${needle}`);
				}
			}
		}
		assert.deepEqual(hits, [], `submit-proof tokens must not survive the host.agents migration:\n${hits.join("\n")}`);
	});
});
