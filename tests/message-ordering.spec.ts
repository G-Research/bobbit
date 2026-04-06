import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
	__dirname,
	"fixtures/message-ordering.html",
);

test("deferred assistant message is cleared on wholesale messages refresh", async ({
	page,
}) => {
	await page.goto(`file://${fixturePath}`);

	const results = await page.evaluate(() => (window as any).__TEST_RESULTS);

	for (const result of results) {
		console.log(`  ${result.passed ? "PASS" : "FAIL"}: ${result.name}`);
	}

	const failures = results.filter((r: any) => !r.passed);
	if (failures.length > 0) {
		console.log("\nFailed tests:");
		for (const f of failures) {
			console.log(`  - ${f.name}: ${f.error || ""}`);
		}
	}

	expect(results.length).toBeGreaterThan(0);
	expect(results.every((r: any) => r.passed)).toBe(true);
});
