import { describe, expect, it } from "vitest";
import { snapshotStaffImprovementSignals } from "../../src/server/agent/staff-improvement-signals.ts";

describe("staff improvement signal boundary", () => {
	it("accepts only bounded fixed labels and counts", () => {
		const signals = snapshotStaffImprovementSignals({
			windowTurns: 3,
			patterns: [{ kind: "repeated-user-correction", count: 2 }],
		});
		expect(signals).toEqual({ windowTurns: 3, patterns: [{ kind: "repeated-user-correction", count: 2 }] });
		expect(Object.isFrozen(signals)).toBe(true);
		expect(Object.isFrozen(signals!.patterns)).toBe(true);
	});

	it("fails closed for text, identifiers, unknown labels, and invalid bounds", () => {
		for (const value of [
			undefined,
			{ windowTurns: 21, patterns: [] },
			{ windowTurns: 1, patterns: [{ kind: "raw transcript", count: 1 }] },
			{ windowTurns: 1, patterns: [{ kind: "repeated-tool-failure", count: 1, text: "secret" }] },
			{ windowTurns: 1, patterns: [{ kind: "repeated-tool-failure", count: 0 }] },
		]) expect(snapshotStaffImprovementSignals(value)).toBeUndefined();
	});
});
