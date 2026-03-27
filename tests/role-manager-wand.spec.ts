import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("role-manager-page idleBlob canvas accessory rendering", () => {
	test("idleBlob uses canvas rendering from bobbit-canvas", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/role-manager-page.ts"),
			"utf-8"
		);
		expect(
			source.includes("bobbit-canvas") || source.includes("renderBobbitCanvas"),
			"Expected role-manager-page.ts to import from bobbit-canvas for canvas-based accessory rendering"
		).toBe(true);
	});

	test("ACCESSORIES registry contains wand entry", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/session-colors.ts"),
			"utf-8"
		);
		expect(
			source.includes('"wand"') || source.includes("'wand'"),
			"Expected session-colors.ts ACCESSORIES registry to contain wand entry"
		).toBe(true);
	});

	test("ACCESSORIES registry contains wizard-hat entry", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/session-colors.ts"),
			"utf-8"
		);
		expect(
			source.includes('"wizard-hat"') || source.includes("'wizard-hat'"),
			"Expected session-colors.ts ACCESSORIES registry to contain wizard-hat entry"
		).toBe(true);
	});
});
