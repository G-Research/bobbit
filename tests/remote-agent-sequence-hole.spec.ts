import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "fixtures/remote-agent-sequence-hole.html");

/**
 * Reproduces the RemoteAgent sequence-hole bug where `tool_permission_needed`
 * consumes EventBuffer seq via pushFrame(), but the client sequencer only
 * advances on `{type:"event"}` frames. The following normal agent event is then
 * buffered forever as a gap, making the UI appear to stop receiving stream
 * events.
 */
test("RemoteAgent event sequencer handles top-level permission frames", async ({ page }) => {
	await page.goto(`file://${fixturePath}`);
	const results = await page.evaluate(() => (window as any).__TEST_RESULTS);
	for (const r of results) {
		console.log(`  ${r.passed ? "PASS" : "FAIL"}: ${r.name}${r.error ? " — " + r.error : ""}`);
	}
	const failures = results.filter((r: any) => !r.passed);
	expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
});
