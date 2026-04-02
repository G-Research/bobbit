import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("wand accessory chat blob integration", () => {
	test("StreamingMessageContainer.ts contains bobbit-blob__wand div", () => {
		const source = fs.readFileSync(
			path.resolve("src/ui/components/StreamingMessageContainer.ts"),
			"utf-8"
		);
		// All other accessories have their div: magnifier, palette, pencil, shield, set-square, flask, wizard-hat
		// The wand must also have its div
		expect(
			source.includes("bobbit-blob__wand"),
			"Expected StreamingMessageContainer.ts to contain bobbit-blob__wand div for wand accessory"
		).toBe(true);
	});

	test("session-manager.ts derives accClasses from ACCESSORY_IDS for cleanup", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/session-manager.ts"),
			"utf-8"
		);
		// accClasses are now derived dynamically from ACCESSORY_IDS via .map(),
		// so verify that ACCESSORY_IDS is imported and used for class cleanup.
		expect(
			source.includes("ACCESSORY_IDS"),
			"Expected session-manager.ts to use ACCESSORY_IDS for accessory class cleanup"
		).toBe(true);
	});

	test("app.css contains .bobbit-blob__wand CSS rules", () => {
		const source = fs.readFileSync(
			path.resolve("src/ui/app.css"),
			"utf-8"
		);
		expect(
			source.includes(".bobbit-blob__wand"),
			"Expected app.css to contain .bobbit-blob__wand CSS rules for wand accessory rendering"
		).toBe(true);
	});

	test("role-manager.css contains inline blob wand override rule", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/role-manager.css"),
			"utf-8"
		);
		expect(
			source.includes(".bobbit-blob--inline.bobbit-wand"),
			"Expected role-manager.css to contain .bobbit-blob--inline.bobbit-wand rule for role picker tiles"
		).toBe(true);
	});
});
