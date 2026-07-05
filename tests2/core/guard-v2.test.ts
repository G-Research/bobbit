// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// guard-v2: the self-covering bucket-membership guard for Test Suite v2.
//
// This is the test-side half of the guard the mass-migration gate checks when
// it says "guard v2 is active and self-covering". Its script-side twin is
// `scripts/testing-v2/parity.mjs --scope core`, which runs in the (heavier)
// verification phase. This vitest test runs inside the v2-core project on every
// `test:v2` and enforces the two invariants that keep tests-map.json honest as
// files are migrated:
//
//   1. NO ORPHANS — every actual test file under tests2/core|dom|integration is
//      claimed either by a legacy entry's `v2Path` or by the curated
//      `v2Native` allowlist. A new tests2 file added without a tests-map entry
//      (or v2Native listing) fails here, immediately, in the fast tier.
//
//   2. NO DANGLING v2Path — every v2-core/dom/integration entry whose
//      `migrated`/`v2Path` is set points at a file that actually exists. A
//      renamed/deleted migrated file fails here.
//
// The guard must never manage itself: this file lives in `v2Native`, so it is
// exempt from the orphan check but still validated for existence like any other
// v2-native entry.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests2/core
const ROOT = join(HERE, "..", ".."); // repo root
const MAP_PATH = join(ROOT, "tests2", "tests-map.json");

// Support directories that hold fixtures/harness code, not managed test files.
const SUPPORT_DIRS = new Set(["_quarantine", "_setup", "_e2e", "helpers"]);
// Buckets that materialize into tests2/{core,dom,integration}.
const MANAGED_ROOTS = [
	["v2-core", "tests2/core"],
	["v2-dom", "tests2/dom"],
	["v2-integration", "tests2/integration"],
] as const;

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

/** Recursively list *.test.ts / *.spec.ts under a tests2 subtree (repo-relative, posix). */
function listActual(rootRel: string): string[] {
	const abs = join(ROOT, rootRel);
	const out: string[] = [];
	const walk = (dir: string): void => {
		let ents: ReturnType<typeof readdirSync>;
		try {
			ents = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // subtree may not exist yet during early migration
		}
		for (const e of ents) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SUPPORT_DIRS.has(e.name)) continue;
				walk(full);
			} else if (/\.(test|spec)\.ts$/.test(e.name)) {
				out.push(toPosix(full.slice(ROOT.length + 1)));
			}
		}
	};
	walk(abs);
	return out.sort();
}

interface Entry {
	file: string;
	bucket: string;
	method: string;
	migrated?: boolean;
	v2Path?: string;
}
interface V2Native {
	path: string;
	reason: string;
}
interface TestsMap {
	entries: Entry[];
	v2Native?: V2Native[];
}

const map: TestsMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));

describe("guard-v2: tests-map.json bucket membership", () => {
	const claimed = new Set(
		map.entries.filter((e) => typeof e.v2Path === "string" && e.v2Path).map((e) => e.v2Path as string),
	);
	const nativePaths = new Set((map.v2Native ?? []).map((n) => n.path));

	it("has a v2Native allowlist (guard self-coverage)", () => {
		expect(Array.isArray(map.v2Native)).toBe(true);
		// The guard itself must be on the allowlist so it never becomes an orphan.
		expect(nativePaths.has("tests2/core/guard-v2.test.ts")).toBe(true);
	});

	it("claims every actual tests2/{core,dom,integration} file (no orphans)", () => {
		const actual = MANAGED_ROOTS.flatMap(([, rel]) => listActual(rel));
		const orphans = actual.filter((f) => !claimed.has(f) && !nativePaths.has(f));
		expect(
			orphans,
			`Orphan tests2 files (present on disk, not claimed by a tests-map v2Path and not in v2Native):\n` +
				orphans.map((f) => `  - ${f}`).join("\n") +
				`\nEither migrate a legacy entry to it (set v2Path) or add it to tests-map.json "v2Native".`,
		).toEqual([]);
	});

	it("resolves every migrated v2Path to an existing file (no dangling references)", () => {
		const managedBuckets = new Set(MANAGED_ROOTS.map(([b]) => b));
		const dangling = map.entries
			.filter((e) => managedBuckets.has(e.bucket) && typeof e.v2Path === "string" && e.v2Path)
			.filter((e) => !existsSync(join(ROOT, e.v2Path as string)))
			.map((e) => `${e.file} -> ${e.v2Path}`);
		expect(
			dangling,
			`tests-map entries whose v2Path points at a missing file:\n` + dangling.map((d) => `  - ${d}`).join("\n"),
		).toEqual([]);
	});

	it("resolves every v2Native path to an existing file", () => {
		const missing = (map.v2Native ?? [])
			.filter((n) => !existsSync(join(ROOT, n.path)))
			.map((n) => n.path);
		expect(
			missing,
			`v2Native entries whose path is missing on disk:\n` + missing.map((m) => `  - ${m}`).join("\n"),
		).toEqual([]);
	});

	it("keeps migrated flag and v2Path consistent", () => {
		const inconsistent = map.entries
			.filter((e) => Boolean(e.migrated) !== Boolean(e.v2Path))
			.map((e) => `${e.file} (migrated=${e.migrated}, v2Path=${e.v2Path ?? "<unset>"})`);
		expect(
			inconsistent,
			`Entries where "migrated" and "v2Path" disagree (both must be set together):\n` +
				inconsistent.map((i) => `  - ${i}`).join("\n"),
		).toEqual([]);
	});
});
