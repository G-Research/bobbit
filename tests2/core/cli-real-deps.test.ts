import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("CLI gateway deps bridge", () => {
	it("does not import v2 harness fences or hard-code fake deps", () => {
		const source = fs.readFileSync("src/server/cli.ts", "utf-8");
		expect(source).not.toContain("tests2/harness");
		expect(source).not.toContain("createFencedCommandRunner");
		expect(source).not.toContain("createFencedFetch");
		expect(source).not.toMatch(/createGateway\([\s\S]*?(fake|mock|fenced)/i);
	});
});
