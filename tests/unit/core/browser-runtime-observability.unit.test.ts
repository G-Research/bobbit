// Pins the browser-v2 worker-resolution diagnostic without importing the
// Playwright config (which allocates a run root and ledger reservation at module
// evaluation time). The timing-summary behavior is covered by
// per-spec-budget.unit.test.ts through its exported pure helper.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configSource = readFileSync("playwright-v2.config.ts", "utf8");

describe("browser runtime observability", () => {
	it("reports every worker resolution source while retaining ledger ownership", () => {
		expect(configSource).toContain('source: "explicit override"');
		expect(configSource).toContain('reservation.managedByParent ? "inherited ledger grant" : "fresh ledger reservation"');
		expect(configSource).toContain('source: "fallback"');
		expect(configSource).toContain('const reservation = reserveWorkerSlots("playwright")');
		expect(configSource).toContain('process.once("exit", reservation.release)');
		expect(configSource).toContain("Playwright workers=${playwrightWorkerResolution.workers} source=${playwrightWorkerResolution.source}");
	});

	it("keeps the explicit override narrow and leaves invalid values on the ledger path", () => {
		const overrideGuard = "Number.isFinite(override) && override >= 1";
		const overrideIndex = configSource.indexOf(overrideGuard);
		const reservationIndex = configSource.indexOf('reserveWorkerSlots("playwright")');
		expect(overrideIndex).toBeGreaterThan(-1);
		expect(reservationIndex).toBeGreaterThan(overrideIndex);
		expect(configSource).toContain("workers: Math.floor(override)");
	});
});
