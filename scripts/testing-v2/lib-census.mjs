/**
 * Shared census + classification helpers for the Test Suite v2 inventory tooling.
 *
 * Consumed by BOTH:
 *   - scripts/testing-v2/gen-inventory.mjs   — generates tests2/tests-map.json
 *   - scripts/testing-v2/check-inventory.mjs — validates tests2/tests-map.json
 *
 * The census enumerates every test/spec file under tests/ the exact same way as
 * the phase-invariant guard (tests/test-phase-invariant.test.ts): a recursive
 * walk of the tests/ directory collecting .test.ts / .spec.ts files, skipping
 * node_modules. Keeping this in one place means the generator and validator can
 * never drift from each other or from the legacy phase census.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const TESTS_DIR = join(REPO_ROOT, "tests");

/** POSIX-normalise a path for stable, cross-platform comparison/output. */
export const toPosix = (p) => p.replace(/\\/g, "/");

/** Recursively collect every .test.ts / .spec.ts file under `dir`. */
export function collectTestFiles(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (name === "node_modules") continue;
			collectTestFiles(full, out);
		} else if (st.isFile() && /\.(test|spec)\.ts$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

/** The census: repo-root-relative POSIX paths, sorted, of every legacy test. */
export function census() {
	return collectTestFiles(TESTS_DIR)
		.map((abs) => toPosix(relative(REPO_ROOT, abs)))
		.sort();
}

export const BUCKETS = ["v2-core", "v2-dom", "v2-integration", "v2-browser", "daily"];
export const METHODS = ["codemod", "adapter", "rewrite", "retire-with-mapping", "relocate", "vitest-e2e"];

/**
 * Geometry / interaction-API criteria. A browser-fixture (.spec.ts) or e2e/ui
 * spec that references any of these needs a real layout engine (Chromium) and
 * therefore stays in Playwright (bucket v2-browser). Everything else can render
 * under happy-dom (v2-dom) or, for e2e/ui, be consolidated into smoke journeys.
 */
export const GEOMETRY_REGEX =
	/getBoundingClientRect|scroll(Top|Left|Into|Height|Width|Y|X|By|To)?|ResizeObserver|IntersectionObserver|visualViewport|mouse\.wheel|getAnimations|requestAnimationFrame|canvas|getContext|matchMedia|IME|compositionstart|dragstart|drag(over|end|enter)/;

/**
 * Real-fidelity domain signal (path or content). A test touching these domains
 * is a *candidate* for the tier-3 daily lane — but only when it ALSO genuinely
 * executes real subprocesses (see REAL_EXEC_REGEX). A pure logic test that
 * merely mentions "docker" or classifies canned `git worktree` porcelain stays
 * in tier-1.
 */
export const DAILY_DOMAIN_REGEX =
	/realpush|worktree-pool|worktree-sweeper|worktree-inventory|sandbox|docker|manual-integration|continue-archived|real.?mcp|mcp-integration|marketplace-mcp|port-auto-increment|spawn/i;

/**
 * Real-execution signal. Distinguishes tests that actually spawn git/docker/
 * child processes (nondeterministic, slow, real-fidelity -> daily) from pure
 * unit tests that inject fakes or feed canned command output (-> tier-1).
 */
export const REAL_EXEC_REGEX =
	/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b|from ["']node:child_process["']|\bspawnTracked\b|git\s+init\b|new\s+Docker\b|dockerode/;

/** Read a file's UTF-8 contents relative to the repo root (empty on error). */
export function readRepoFile(repoRelPath) {
	try {
		return readFileSync(join(REPO_ROOT, repoRelPath), "utf8");
	} catch {
		return "";
	}
}
