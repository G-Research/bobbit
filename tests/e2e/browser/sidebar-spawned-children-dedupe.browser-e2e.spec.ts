/**
 * Spawned-children sidebar matrix moved to deterministic fixture coverage in
 * tests/ui-fixtures/sidebar-navigation-fixture.spec.ts. No spawned-gateway smoke is
 * retained here because same-title/dedupe/stable-sort is pure sidebar rendering.
 */
import { test } from "../gateway-harness.js";

test.describe("sidebar spawned-children — migrated to fixture", () => {
	test.skip("same-title, duplicate-id, and stable-sort coverage runs in sidebar-navigation fixture", async () => {});
});
