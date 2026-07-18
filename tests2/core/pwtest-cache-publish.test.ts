/**
 * Pins the persistent Playwright transform-cache seed/publish helpers
 * (scripts/testing-v2/pwtest-cache.ts) used by playwright-v2.config.ts and
 * tests2/browser-global-teardown.ts:
 *   - seed copies the `latest` snapshot into a run dir without clobbering
 *     existing run-dir files, tolerates a missing `latest`, and fails open;
 *   - publish atomically replaces `latest` from a non-empty run dir, skips
 *     empty/missing run dirs, and a concurrent-publish loser cleans its tmp;
 *   - the env-gated wrapper honours OWNED gating, the v2 namespace guard,
 *     and KEEP=1 not suppressing publish (KEEP only affects deletion).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installScopedMemFs } from "./helpers/scoped-memfs.js";

type CacheModule = typeof import("../../scripts/testing-v2/pwtest-cache.js");

const ROOT = resolve("/memfs/pwtest-cache-publish");
let fixtureSequence = 0;
let restoreFs: () => void;
let LATEST_SEGMENT: CacheModule["LATEST_SEGMENT"];
let V2_TRANSFORM_CACHE_SEGMENT: CacheModule["V2_TRANSFORM_CACHE_SEGMENT"];
let latestTransformCacheDir: CacheModule["latestTransformCacheDir"];
let publishTransformCache: CacheModule["publishTransformCache"];
let publishTransformCacheFromEnv: CacheModule["publishTransformCacheFromEnv"];
let seedTransformCache: CacheModule["seedTransformCache"];
let seedTransformCacheForRunDir: CacheModule["seedTransformCacheForRunDir"];

beforeAll(async () => {
	const scoped = installScopedMemFs([
		"cpSync", "existsSync", "mkdirSync", "readFileSync", "readdirSync", "renameSync", "rmSync", "writeFileSync",
	]);
	restoreFs = scoped.restore;
	scoped.fs.mkdirSync(ROOT, { recursive: true });
	({
		LATEST_SEGMENT,
		V2_TRANSFORM_CACHE_SEGMENT,
		latestTransformCacheDir,
		publishTransformCache,
		publishTransformCacheFromEnv,
		seedTransformCache,
		seedTransformCacheForRunDir,
	} = await import("../../scripts/testing-v2/pwtest-cache.js"));
});

afterAll(() => restoreFs());

function makeRoot(label: string): string {
	const root = join(ROOT, `${label}-${fixtureSequence++}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function makeBase(): { base: string; latest: string; run: string } {
	const base = join(makeRoot("case"), V2_TRANSFORM_CACHE_SEGMENT);
	const latest = join(base, LATEST_SEGMENT);
	const run = join(base, "run-1");
	mkdirSync(run, { recursive: true });
	return { base, latest, run };
}

describe("latestTransformCacheDir", () => {
	it("is the `latest` sibling of the run dir", () => {
		const { base, latest, run } = makeBase();
		expect(latestTransformCacheDir(run)).toBe(latest);
		expect(latestTransformCacheDir(join(base, "other-run"))).toBe(latest);
	});
});

describe("seedTransformCache", () => {
	it("copies latest contents (including subdirs) into the run dir", () => {
		const { latest, run } = makeBase();
		mkdirSync(join(latest, "sub"), { recursive: true });
		writeFileSync(join(latest, "a.js"), "A");
		writeFileSync(join(latest, "sub", "b.js"), "B");

		expect(seedTransformCache(latest, run)).toBe(true);
		expect(readFileSync(join(run, "a.js"), "utf8")).toBe("A");
		expect(readFileSync(join(run, "sub", "b.js"), "utf8")).toBe("B");
	});

	it("never clobbers files already present in the run dir", () => {
		const { latest, run } = makeBase();
		mkdirSync(latest, { recursive: true });
		writeFileSync(join(latest, "a.js"), "stale");
		writeFileSync(join(run, "a.js"), "fresh");

		seedTransformCache(latest, run);
		expect(readFileSync(join(run, "a.js"), "utf8")).toBe("fresh");
	});

	it("tolerates a missing latest snapshot (cold start)", () => {
		const { latest, run } = makeBase();
		expect(existsSync(latest)).toBe(false);
		expect(seedTransformCache(latest, run)).toBe(false);
		expect(readdirSync(run)).toEqual([]);
	});

	it("refuses degenerate inputs (same dir, empty paths)", () => {
		const { run } = makeBase();
		expect(seedTransformCache(run, run)).toBe(false);
		expect(seedTransformCache("", run)).toBe(false);
		expect(seedTransformCache(run, "")).toBe(false);
	});

	it("seedTransformCacheForRunDir only seeds inside the v2 namespace and never `latest` itself", () => {
		const { latest, run } = makeBase();
		mkdirSync(latest, { recursive: true });
		writeFileSync(join(latest, "a.js"), "A");

		expect(seedTransformCacheForRunDir(run)).toBe(true);
		expect(readFileSync(join(run, "a.js"), "utf8")).toBe("A");

		// Outside the v2 namespace: no seed.
		const outsideRoot = makeRoot("outside");
		const outsideRun = join(outsideRoot, "some-cache", "run-1");
		mkdirSync(outsideRun, { recursive: true });
		expect(seedTransformCacheForRunDir(outsideRun)).toBe(false);

		// Never seed `latest` from itself.
		expect(seedTransformCacheForRunDir(latest)).toBe(false);
	});
});

describe("publishTransformCache", () => {
	it("creates latest from a non-empty run dir when latest is missing", () => {
		const { latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");

		expect(publishTransformCache(run, latest)).toBe(true);
		expect(readFileSync(join(latest, "a.js"), "utf8")).toBe("A");
		// Run dir is left intact (deletion belongs to the legacy teardown).
		expect(readFileSync(join(run, "a.js"), "utf8")).toBe("A");
	});

	it("replaces an existing latest atomically (no stale entries survive)", () => {
		const { latest, run } = makeBase();
		mkdirSync(latest, { recursive: true });
		writeFileSync(join(latest, "old.js"), "OLD");
		writeFileSync(join(run, "new.js"), "NEW");

		expect(publishTransformCache(run, latest)).toBe(true);
		expect(readdirSync(latest)).toEqual(["new.js"]);
		expect(readFileSync(join(latest, "new.js"), "utf8")).toBe("NEW");
	});

	it("skips a missing run dir and an empty run dir", () => {
		const { base, latest, run } = makeBase();
		expect(publishTransformCache(join(base, "does-not-exist"), latest)).toBe(false);
		expect(publishTransformCache(run, latest)).toBe(false); // exists but empty
		expect(existsSync(latest)).toBe(false);
	});

	it("leaves no tmp dirs behind on success", () => {
		const { base, latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		publishTransformCache(run, latest, "tag1");
		const leftovers = readdirSync(base).filter((e) => e.includes("-tmp"));
		expect(leftovers).toEqual([]);
	});

	it("concurrent-publish loser cleans up its tmp dir and keeps the winner's latest", () => {
		const { base, latest, run } = makeBase();
		writeFileSync(join(run, "loser.js"), "L");
		const tag = "loser";
		const tmpDir = `${latest}-${tag}-tmp`;

		// Simulate a concurrent winner: between the loser's rmSync(latest) and
		// its renameSync, the winner publishes `latest`, making the loser's
		// rename fail. Throw explicitly because memfs replaces an existing
		// non-empty destination whereas Windows and POSIX reject this rename.
		const raceyRename: typeof renameSync = () => {
			mkdirSync(latest, { recursive: true });
			writeFileSync(join(latest, "winner.js"), "W");
			const error = new Error("concurrent publisher won") as NodeJS.ErrnoException;
			error.code = "ENOTEMPTY";
			throw error;
		};

		expect(publishTransformCache(run, latest, tag, { renameSync: raceyRename })).toBe(false);
		// Loser cleaned its tmp dir; no `-tmp` leftovers anywhere in the base.
		expect(existsSync(tmpDir)).toBe(false);
		expect(readdirSync(base).filter((e) => e.includes("-tmp"))).toEqual([]);
		// Winner's snapshot untouched.
		expect(readFileSync(join(latest, "winner.js"), "utf8")).toBe("W");
	});

	it("refuses degenerate inputs (same dir, empty paths)", () => {
		const { run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		expect(publishTransformCache(run, run)).toBe(false);
		expect(publishTransformCache("", run)).toBe(false);
		expect(publishTransformCache(run, "")).toBe(false);
	});
});

describe("publishTransformCacheFromEnv", () => {
	it("publishes when OWNED=1 and the run dir is in the v2 namespace", () => {
		const { latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		const ok = publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
			BOBBIT_V2_PWTEST_RUN_CACHE_ROOT: run,
		} as NodeJS.ProcessEnv);
		expect(ok).toBe(true);
		expect(readFileSync(join(latest, "a.js"), "utf8")).toBe("A");
	});

	it("does nothing when OWNED is unset or not '1'", () => {
		const { latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		for (const owned of [undefined, "", "0", "true"]) {
			const ok = publishTransformCacheFromEnv({
				BOBBIT_E2E_PWTEST_CACHE_OWNED: owned,
				BOBBIT_V2_PWTEST_RUN_CACHE_ROOT: run,
			} as NodeJS.ProcessEnv);
			expect(ok).toBe(false);
		}
		expect(existsSync(latest)).toBe(false);
	});

	it("KEEP=1 does not suppress publishing (KEEP only affects run-dir deletion)", () => {
		const { latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		const ok = publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
			BOBBIT_KEEP_PWTEST_CACHE: "1",
			BOBBIT_V2_PWTEST_RUN_CACHE_ROOT: run,
		} as NodeJS.ProcessEnv);
		expect(ok).toBe(true);
		expect(readFileSync(join(latest, "a.js"), "utf8")).toBe("A");
		// Run dir untouched by publish, honouring KEEP's inspection use case.
		expect(readFileSync(join(run, "a.js"), "utf8")).toBe("A");
	});

	it("ignores run dirs outside the v2 namespace (legacy dirs untouched)", () => {
		const root = makeRoot("legacy");
		const legacyRun = join(root, "pwtest-transform-cache", "run-1");
		mkdirSync(legacyRun, { recursive: true });
		writeFileSync(join(legacyRun, "a.js"), "A");
		const ok = publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
			BOBBIT_V2_PWTEST_RUN_CACHE_ROOT: legacyRun,
		} as NodeJS.ProcessEnv);
		expect(ok).toBe(false);
		expect(existsSync(join(root, "pwtest-transform-cache", "latest"))).toBe(false);
	});

	it("never publishes the `latest` dir onto itself and tolerates missing env", () => {
		const { latest } = makeBase();
		mkdirSync(latest, { recursive: true });
		writeFileSync(join(latest, "a.js"), "A");
		expect(publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
			BOBBIT_V2_PWTEST_RUN_CACHE_ROOT: latest,
		} as NodeJS.ProcessEnv)).toBe(false);
		expect(publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
		} as NodeJS.ProcessEnv)).toBe(false);
	});

	it("falls back to BOBBIT_E2E_PWTEST_CACHE_DIR when the v2 run-root var is absent", () => {
		const { latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		const ok = publishTransformCacheFromEnv({
			BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
			BOBBIT_E2E_PWTEST_CACHE_DIR: run,
		} as NodeJS.ProcessEnv);
		expect(ok).toBe(true);
		expect(readFileSync(join(latest, "a.js"), "utf8")).toBe("A");
	});

	it("round-trip: publish then seed warms a fresh run dir", () => {
		const { base, latest, run } = makeBase();
		writeFileSync(join(run, "a.js"), "A");
		expect(publishTransformCache(run, latest)).toBe(true);

		const nextRun = join(base, "run-2");
		mkdirSync(nextRun, { recursive: true });
		expect(seedTransformCacheForRunDir(nextRun)).toBe(true);
		expect(readFileSync(join(nextRun, "a.js"), "utf8")).toBe("A");
	});
});
