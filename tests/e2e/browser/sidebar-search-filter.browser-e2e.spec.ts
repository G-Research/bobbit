/**
 * Sidebar search/filter matrix coverage moved to the deterministic fixture:
 * tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts.
 * The retained full-stack filter/search smoke lives in sidebar-filters.spec.ts.
 */
import { test } from "../gateway-harness.js";

test.describe("Sidebar search/filter matrix", () => {
	// Intentionally empty: covered by the lightweight fixture plus one retained full-stack smoke.
});
