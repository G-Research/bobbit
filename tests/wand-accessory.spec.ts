import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("wand accessory chat blob integration", () => {
	test("StreamingMessageContainer.ts uses canvas-based rendering from bobbit-canvas", () => {
		const source = fs.readFileSync(
			path.resolve("src/ui/components/StreamingMessageContainer.ts"),
			"utf-8"
		);
		expect(
			source.includes("bobbit-canvas") || source.includes("renderBobbitCanvas"),
			"Expected StreamingMessageContainer.ts to import from bobbit-canvas for canvas-based accessory rendering"
		).toBe(true);
	});

	test("session-manager.ts includes bobbit-wand in accClasses arrays", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/session-manager.ts"),
			"utf-8"
		);
		// Both accClasses arrays must include "bobbit-wand" for proper class cleanup
		const accClassesMatches = source.match(/accClasses\s*=\s*\[([^\]]+)\]/g);
		expect(
			accClassesMatches && accClassesMatches.length >= 2,
			"Expected session-manager.ts to have at least 2 accClasses arrays"
		).toBe(true);
		for (const match of accClassesMatches!) {
			expect(
				match.includes("bobbit-wand"),
				"Expected session-manager.ts accClasses to include bobbit-wand for class cleanup"
			).toBe(true);
		}
	});

	test("ACCESSORIES registry in session-colors.ts contains wand entry", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/session-colors.ts"),
			"utf-8"
		);
		expect(
			source.includes('"wand"') || source.includes("'wand'"),
			"Expected session-colors.ts ACCESSORIES registry to contain wand entry for canvas rendering"
		).toBe(true);
	});

	test("role-manager-page.ts uses canvas rendering for accessories", () => {
		const source = fs.readFileSync(
			path.resolve("src/app/role-manager-page.ts"),
			"utf-8"
		);
		expect(
			source.includes("bobbit-canvas") || source.includes("renderBobbitCanvas"),
			"Expected role-manager-page.ts to use canvas-based rendering for accessories"
		).toBe(true);
	});
});
