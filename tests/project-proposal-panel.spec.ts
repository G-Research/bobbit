/**
 * Unit tests for the project-proposal panel's diff rendering logic.
 *
 * Uses a file:// fixture that mirrors the classification logic of
 * projectProposalPanel() in src/app/render.ts. Guards the core invariants:
 * - provisional mode renders without "Changed" pills or collapse group
 * - registered mode partitions fields into changed vs unchanged
 * - changed fields get a Changed badge; unchanged go into a <details> group
 * - root_path is read-only
 * - unknown keys flow through
 * - accept-button label switches between "Accept Project" and "Apply Changes (N)"
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/project-proposal-panel.html")}`;

test.beforeEach(async ({ page }) => {
	await page.goto(TEST_PAGE);
	await page.waitForFunction(() => (window as any).__ready === true);
});

test("provisional mode: no changed badges, no collapse group, Accept Project label", async ({ page }) => {
	const res = await page.evaluate(() => (window as any).renderProposal({
		sessionId: "s1",
		mode: "provisional",
		fields: { name: "My Project", root_path: "/tmp/x", build_command: "npm run build" },
	}));
	expect(res.changed.length).toBeGreaterThan(0);
	expect(res.unchanged.length).toBe(0);
	expect(await page.locator('[data-testid="changed-badge"]').count()).toBe(0);
	expect(await page.locator('[data-testid="unchanged-group"]').count()).toBe(0);
	expect(await page.locator('[data-testid="accept-label"]').innerText()).toBe("Accept Project");
	expect(await page.locator('[data-field="root_path"][data-readonly="true"]').count()).toBe(1);
});

test("registered mode: diff partitions into changed + unchanged groups with badges", async ({ page }) => {
	const res = await page.evaluate(() => (window as any).renderProposal({
		sessionId: "s1",
		mode: "registered",
		fields: {
			name: "New Name",
			root_path: "/tmp/x",
			build_command: "npm run build",       // unchanged
			test_command: "npm run test:new",     // changed
			typecheck_command: "",                // unchanged (both empty)
		},
		currentConfig: {
			name: "Old Name",
			rootPath: "/tmp/x",
			config: {
				build_command: "npm run build",
				test_command: "npm run test:old",
			},
		},
	}));
	// name + test_command are changed
	expect(res.changed).toContain("name");
	expect(res.changed).toContain("test_command");
	// build_command unchanged
	expect(res.unchanged).toContain("build_command");
	// Changed badges render
	const badges = await page.locator('[data-testid="changed-badge"]').count();
	expect(badges).toBeGreaterThanOrEqual(2); // name + test_command at minimum
	// Unchanged group renders
	expect(await page.locator('[data-testid="unchanged-group"]').count()).toBe(1);
	// Apply-changes label includes count
	const label = await page.locator('[data-testid="accept-label"]').innerText();
	expect(label).toMatch(/^Apply Changes \(\d+\)$/);
});

test("registered mode: unknown keys pass through and are classified", async ({ page }) => {
	const res = await page.evaluate(() => (window as any).renderProposal({
		sessionId: "s1",
		mode: "registered",
		fields: {
			name: "P",
			root_path: "/tmp/x",
			custom_weird_key: "proposed-value",
		},
		currentConfig: { name: "P", rootPath: "/tmp/x", config: {} },
	}));
	// Unknown key with no prior current value is "changed" (proposed non-empty vs "")
	expect(res.changed).toContain("custom_weird_key");
	expect(await page.locator('[data-field="custom_weird_key"]').count()).toBe(1);
});

test("registered mode with no diff: Apply Changes (no count)", async ({ page }) => {
	await page.evaluate(() => (window as any).renderProposal({
		sessionId: "s1",
		mode: "registered",
		fields: { name: "Same", root_path: "/tmp/x", build_command: "npm run build" },
		currentConfig: {
			name: "Same",
			rootPath: "/tmp/x",
			config: { build_command: "npm run build" },
		},
	}));
	const label = await page.locator('[data-testid="accept-label"]').innerText();
	expect(label).toBe("Apply Changes");
});

test("root_path is read-only — no editable input", async ({ page }) => {
	await page.evaluate(() => (window as any).renderProposal({
		sessionId: "s1",
		mode: "registered",
		fields: { name: "P", root_path: "/tmp/xyz" },
		currentConfig: { name: "P", rootPath: "/tmp/xyz", config: {} },
	}));
	// There is no <input> inside the root_path field row
	const inputInRootRow = await page.locator('[data-field="root_path"] input').count();
	expect(inputInRootRow).toBe(0);
});
