import { defineConfig } from "@playwright/test";
import { createUnitBrowserPhaseSelection } from "../scripts/test-phase-config.mjs";

export default defineConfig({
	...createUnitBrowserPhaseSelection(),
	// Unit browser-fixture project: top-level `tests/*.spec.ts` only. Subtrees
	// that run in other phases are excluded: `e2e/**` (e2e gate) and
	// `manual-integration/**` (real-LLM/Docker, gate-exempt). This exclusion
	// set is mirrored by the phase-invariant guard in test-phase-invariant.e2e.test.ts.
	timeout: 15_000,
	fullyParallel: true,
	workers: process.env.CI ? 2 : "50%",
});
