/**
 * Global teardown for v2 browser runs (playwright-v2.config.ts).
 *
 * FIRST publishes this run's Playwright transform cache as the shared
 * `latest` snapshot (so the next run warm-starts instead of re-transforming
 * ~566 files), THEN delegates to the legacy e2e teardown, which — unchanged —
 * deletes the per-run cache dir and cleans up ephemeral state/Docker.
 *
 * The publish is fail-open and env-gated (BOBBIT_E2E_PWTEST_CACHE_OWNED=1,
 * v2 namespace only); BOBBIT_KEEP_PWTEST_CACHE=1 keeps its existing
 * "don't delete the per-run dir" semantics in the delegated teardown.
 * tests/e2e/e2e-teardown.ts itself is NOT modified so legacy e2e runs are
 * unaffected.
 */
import legacyTeardown from "../tests/e2e/e2e-teardown.js";
import { publishTransformCacheFromEnv } from "../scripts/testing-v2/pwtest-cache.js";

export default async function globalTeardown(): Promise<void> {
	try {
		publishTransformCacheFromEnv();
	} catch (err) {
		// Fail-open: publishing is an optimization only.
		console.log(`[v2-browser-teardown] transform-cache publish failed (ignored): ${(err as Error)?.message ?? err}`);
	}
	await legacyTeardown();
}
