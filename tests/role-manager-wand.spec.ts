import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("role-manager-page idleBlob accessory divs", () => {
	// idleBlob delegates to renderIdleBlobCanvas in bobbit-render.ts
	const renderSource = () => fs.readFileSync(
		path.resolve("src/ui/bobbit-render.ts"),
		"utf-8"
	);

	test("renderIdleBlobCanvas template contains bobbit-blob__wand div", () => {
		expect(
			renderSource().includes("bobbit-blob__wand"),
			"Expected bobbit-render.ts renderIdleBlobCanvas template to contain bobbit-blob__wand div for wand accessory rendering"
		).toBe(true);
	});

	test("renderIdleBlobCanvas template contains bobbit-blob__wizard-hat div", () => {
		expect(
			renderSource().includes("bobbit-blob__wizard-hat"),
			"Expected bobbit-render.ts renderIdleBlobCanvas template to contain bobbit-blob__wizard-hat div for wizard-hat accessory rendering"
		).toBe(true);
	});
});
