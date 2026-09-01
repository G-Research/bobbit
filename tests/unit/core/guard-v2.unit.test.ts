import { describe, expect, it } from "vitest";
import { discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";

const GUARD_PATH = "tests/unit/core/guard-v2.unit.test.ts";

describe("guard-v2: canonical convention inventory", () => {
	it("discovers every active test exactly once and covers itself", () => {
		const discovery = discoverTests();
		const assigned = [
			discovery.core,
			discovery.dom,
			discovery.integration,
			discovery.isolated,
			discovery.e2eGroups.D,
			discovery.browser,
			discovery.e2eGroups.C,
			discovery.e2eGroups.A,
			discovery.e2eGroups.B,
			discovery.manual,
		].flat().sort();

		expect(discovery.core).toContain(GUARD_PATH);
		expect(assigned).toEqual(discovery.all);
		expect(discovery.canonical).toBe(discovery.all);
		expect(new Set(assigned).size).toBe(assigned.length);
		expect("transitional" in discovery).toBe(false);
	});
});
