import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "fixtures/remote-agent-seq-dedup.html");

test("RemoteAgent seq-dedup / ordering / resume", async ({ page }) => {
	await page.goto(`file://${fixturePath}`);
	const results = await page.evaluate(() => (window as any).__TEST_RESULTS);
	for (const r of results) {
		console.log(`  ${r.passed ? "PASS" : "FAIL"}: ${r.name}${r.error ? " — " + r.error : ""}`);
	}
	const failures = results.filter((r: any) => !r.passed);
	expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
});
