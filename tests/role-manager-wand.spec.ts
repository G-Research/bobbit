import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("role-manager-page idleBlob accessory divs", () => {
	test("idleBlob template contains bobbit-blob__wand div", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/role-manager-page.ts"),
			"utf-8"
		);
		expect(
			source.includes("bobbit-blob__wand"),
			"Expected role-manager-page.ts idleBlob template to contain bobbit-blob__wand div for wand accessory rendering"
		).toBe(true);
	});

	test("idleBlob template contains bobbit-blob__wizard-hat div", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/role-manager-page.ts"),
			"utf-8"
		);
		expect(
			source.includes("bobbit-blob__wizard-hat"),
			"Expected role-manager-page.ts idleBlob template to contain bobbit-blob__wizard-hat div for wizard-hat accessory rendering"
		).toBe(true);
	});
});
