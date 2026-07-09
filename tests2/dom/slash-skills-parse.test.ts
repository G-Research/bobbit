import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/slash-skills-parse.spec.ts (v2-dom tier).
// The legacy file:// fixture INLINED a copy of applySubstitutions and precomputed
// a testResults object. This port imports the REAL applySubstitutions from
// src/server/skills/slash-skills.ts (higher fidelity) and asserts the identical
// substitution facts the fixture computed.
import { describe, expect, it } from "vitest";
import { applySubstitutions } from "../../src/server/skills/slash-skills.js";

describe("slash-skills argument substitution", () => {
	it("replaces $ARGUMENTS with full argument string", () => {
		expect(applySubstitutions("Fix issue $ARGUMENTS", "123")).toBe("Fix issue 123");
	});

	it("replaces $ARGUMENTS[N] with indexed arguments", () => {
		expect(
			applySubstitutions("Migrate $ARGUMENTS[0] from $ARGUMENTS[1] to $ARGUMENTS[2]", "SearchBar React Vue"),
		).toBe("Migrate SearchBar from React to Vue");
	});

	it("replaces $N shorthand with indexed arguments", () => {
		expect(applySubstitutions("Migrate $0 from $1 to $2", "SearchBar React Vue")).toBe(
			"Migrate SearchBar from React to Vue",
		);
	});

	it("leaves content unchanged with empty args", () => {
		expect(applySubstitutions("Do something", "")).toBe("Do something");
	});

	it("handles mixed $ARGUMENTS and $N", () => {
		expect(applySubstitutions("$ARGUMENTS and also $0", "hello world")).toBe("hello world and also hello");
	});
});
