import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "fixtures/remote-agent-status.html");

/**
 * Drives a faithful copy of `RemoteAgent`'s status logic through 8 scripted WS
 * scenarios. Each test asserts the divergence-impossibility invariant:
 *
 *   stopButtonVisible (`agent.isStreaming`) ≡ spriteBusy (`status === "streaming"`)
 *
 * Acceptance criterion #1 (no two-flag divergence) and #2 (heartbeat-driven
 * recovery) are demonstrated here. See docs/design/unify-session-status.md §6.1.
 */
test("RemoteAgent canonical-status / version / heartbeat / gap-resync", async ({ page }) => {
	await page.goto(`file://${fixturePath}`);
	const results = await page.evaluate(() => (window as any).__TEST_RESULTS);
	for (const r of results) {
		console.log(`  ${r.passed ? "PASS" : "FAIL"}: ${r.name}${r.error ? " — " + r.error : ""}`);
	}
	const failures = results.filter((r: any) => !r.passed);
	expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
	expect(results.length).toBeGreaterThanOrEqual(8);
});
