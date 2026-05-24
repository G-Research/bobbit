import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/proposal-review-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "proposal-review-fixture-bundle.js");

const APP_RENDER_SRC = path.resolve("src/app/render.ts");
const APP_STATE_SRC = path.resolve("src/app/state.ts");
const PROPOSAL_REGISTRY_SRC = path.resolve("src/app/proposal-registry.ts");
const PROPOSAL_HELPERS_SRC = path.resolve("src/app/proposal-helpers.ts");
const REVIEW_PANE_SRC = path.resolve("src/ui/components/review/ReviewPane.ts");
const REVIEW_DOCUMENT_SRC = path.resolve("src/ui/components/review/ReviewDocument.ts");
const ANNOTATION_STORE_SRC = path.resolve("src/ui/components/review/AnnotationStore.ts");
const MAIN_SRC = path.resolve("src/app/main.ts");
const WORKFLOW_CSS = path.resolve("src/app/workflow-page.css");
const ROLE_CSS = path.resolve("src/app/role-manager.css");
const TOOL_CSS = path.resolve("src/app/tool-manager.css");

type ProposalType = "goal" | "project" | "role" | "tool" | "staff";

type ProposalExpectation = {
	type: ProposalType;
	label: string;
	panel: string;
	editedFieldKey: string;
	editedFieldValueAfter: string;
	preservedFieldKey: string;
};

const PROPOSAL_EXPECTATIONS: ProposalExpectation[] = [
	{ type: "goal", label: "Goal", panel: "goal-proposal", editedFieldKey: "title", editedFieldValueAfter: "Parity Goal A — edited", preservedFieldKey: "cwd" },
	{ type: "project", label: "Project", panel: "project-proposal", editedFieldKey: "build_command", editedFieldValueAfter: "echo parity-edited", preservedFieldKey: "components" },
	{ type: "role", label: "Role", panel: "role-proposal", editedFieldKey: "label", editedFieldValueAfter: "parity-role-edited", preservedFieldKey: "name" },
	{ type: "tool", label: "Tool", panel: "tool-proposal", editedFieldKey: "content", editedFieldValueAfter: "parity-tool-edited content", preservedFieldKey: "tool" },
	{ type: "staff", label: "Staff", panel: "staff-proposal", editedFieldKey: "description", editedFieldValueAfter: "parity-staff-edited", preservedFieldKey: "name" },
];

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			APP_RENDER_SRC,
			APP_STATE_SRC,
			PROPOSAL_REGISTRY_SRC,
			PROPOSAL_HELPERS_SRC,
			REVIEW_PANE_SRC,
			REVIEW_DOCUMENT_SRC,
			ANNOTATION_STORE_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__proposalReviewReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetProposalReviewFixture());
	await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
}

async function reloadAndRehydrateFixture(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__proposalReviewReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__rehydrateProposalReviewFixture());
	await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
}

async function fixtures(page: Page): Promise<Array<{ type: ProposalType; initial: Record<string, unknown>; partial: Record<string, unknown> }>> {
	return page.evaluate(() => (window as any).__proposalReviewFixtures);
}

async function readSlot(page: Page, type: ProposalType): Promise<Record<string, unknown> | null> {
	return page.evaluate((t) => (window as any).__readProposalSlot(t), type);
}

function proposalTab(page: Page, label: string) {
	return page.locator(`button.goal-tab-pill[title="${label}"]`).first();
}

function proposalPanel(page: Page, expected: ProposalExpectation) {
	if (expected.type === "goal") {
		return page.locator(".goal-preview-panel", { has: page.locator('input[placeholder="Goal title"]') }).first();
	}
	return page.locator(`[data-panel="${expected.panel}"]`).first();
}

function reviewPanelTab(page: Page, title: string) {
	return page.locator(`.goal-preview-panel button.goal-tab-pill[data-panel-tab-kind='review'][data-panel-tab-title="Review: ${title}"]`);
}

test.describe("Proposal/review lightweight fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("proposal registry merge, typed dismissal, and proposal-open are type-generic", async ({ page }) => {
		const allFixtures = await fixtures(page);
		for (const expected of PROPOSAL_EXPECTATIONS) {
			const fixture = allFixtures.find((f) => f.type === expected.type)!;
			await page.evaluate(() => (window as any).__resetProposalReviewFixture());

			await page.evaluate(({ type, fields }) => (window as any).__emitProposalFixture(type, fields), {
				type: fixture.type,
				fields: fixture.initial,
			});
			let slot = await readSlot(page, expected.type);
			expect(slot, `${expected.type} slot should populate on first emit`).not.toBeNull();
			expect(await page.evaluate(() => (window as any).bobbitState.assistantHasProposal)).toBe(true);

			await page.evaluate(({ type, fields }) => (window as any).__emitProposalFixture(type, fields), {
				type: fixture.type,
				fields: fixture.partial,
			});
			slot = await readSlot(page, expected.type);
			expect(slot?.[expected.editedFieldKey], `${expected.type} edited field`).toBe(expected.editedFieldValueAfter);
			expect(slot?.[expected.preservedFieldKey], `${expected.type} preserved field`).toBeDefined();

			await page.evaluate((type) => (window as any).__markProposalDismissed(type), expected.type);
			expect(await readSlot(page, expected.type), `${expected.type} dismissed slot`).toBeNull();
			expect(await page.evaluate((type) => (window as any).__proposalDismissalExists(type), expected.type)).toBe(true);

			await page.evaluate(({ type, fields }) => (window as any).__dispatchProposalOpen(type, fields), {
				type: fixture.type,
				fields: fixture.initial,
			});
			slot = await readSlot(page, expected.type);
			expect(slot, `${expected.type} proposal-open restores slot`).not.toBeNull();
			expect(await page.evaluate((type) => (window as any).__proposalDismissalExists(type), expected.type)).toBe(false);
		}
	});

	for (const expected of PROPOSAL_EXPECTATIONS) {
		test(`[${expected.type}] dismissal sticks across page reload`, async ({ page }) => {
			const fixture = (await fixtures(page)).find((f) => f.type === expected.type)!;
			await page.evaluate(({ type, fields }) => (window as any).__emitProposalFixture(type, fields), {
				type: fixture.type,
				fields: fixture.initial,
			});
			expect(await readSlot(page, expected.type), `${expected.type} slot should populate before dismiss`).not.toBeNull();

			await page.evaluate((type) => (window as any).__markProposalDismissed(type), expected.type);
			expect(await readSlot(page, expected.type), `${expected.type} slot should clear on dismiss`).toBeNull();
			expect(await page.evaluate((type) => (window as any).__proposalDismissalExists(type), expected.type)).toBe(true);

			await reloadAndRehydrateFixture(page);
			expect(await readSlot(page, expected.type), `${expected.type} dismissed slot should not rehydrate`).toBeNull();
			expect(await page.evaluate((type) => (window as any).__proposalDismissalExists(type), expected.type)).toBe(true);
			expect(await page.evaluate(() => (window as any).bobbitState.assistantHasProposal)).toBe(false);
		});

		test(`[${expected.type}] restart survival rehydrates active proposal slot after page reload`, async ({ page }) => {
			const fixture = (await fixtures(page)).find((f) => f.type === expected.type)!;
			await page.evaluate(({ type, fields }) => (window as any).__emitProposalFixture(type, fields), {
				type: fixture.type,
				fields: fixture.initial,
			});
			await page.evaluate(({ type, fields }) => (window as any).__emitProposalFixture(type, fields), {
				type: fixture.type,
				fields: fixture.partial,
			});
			const before = await readSlot(page, expected.type);
			expect(before?.[expected.editedFieldKey], `${expected.type} edited field before reload`).toBe(expected.editedFieldValueAfter);
			expect(before?.[expected.preservedFieldKey], `${expected.type} preserved field before reload`).toBeDefined();

			await reloadAndRehydrateFixture(page);
			const after = await readSlot(page, expected.type);
			expect(after, `${expected.type} slot should rehydrate after reload`).not.toBeNull();
			expect(after?.[expected.editedFieldKey], `${expected.type} edited field after reload`).toBe(expected.editedFieldValueAfter);
			expect(after?.[expected.preservedFieldKey], `${expected.type} preserved field after reload`).toBeDefined();
			expect(await page.evaluate(() => (window as any).bobbitState.assistantHasProposal)).toBe(true);

			await expect(proposalTab(page, expected.label), `${expected.label} proposal tab after reload`).toBeVisible({ timeout: 10_000 });
			await proposalTab(page, expected.label).click();
			await expect(proposalPanel(page, expected), `${expected.label} panel after reload`).toBeVisible({ timeout: 10_000 });
		});
	}

	test("proposal tabs and panes render every active proposal type; dismissing one preserves the rest", async ({ page }) => {
		await page.evaluate(() => (window as any).__setAllProposalFixtures());

		for (const expected of PROPOSAL_EXPECTATIONS) {
			const tab = proposalTab(page, expected.label);
			await expect(tab, `${expected.label} proposal tab`).toBeVisible({ timeout: 10_000 });
			await expect(tab.locator(".goal-tab-dot"), `${expected.label} proposal dot`).toBeVisible();
			await tab.click();
			await expect(proposalPanel(page, expected), `${expected.label} panel`).toBeVisible({ timeout: 10_000 });
		}

		await proposalTab(page, "Tool").click();
		await page.locator('[data-panel="tool-proposal"]').getByRole("button", { name: "Dismiss" }).click();
		await expect(proposalTab(page, "Tool")).toHaveCount(0, { timeout: 5_000 });
		await expect(proposalTab(page, "Goal")).toBeVisible();
		await expect(proposalTab(page, "Staff")).toBeVisible();

		await page.setViewportSize({ width: 390, height: 800 });
		await page.evaluate(() => (window as any).__setAllProposalFixtures());
		await expect(page.locator('button.goal-tab-pill[title="Chat"]').first()).toBeVisible({ timeout: 10_000 });
		await proposalTab(page, "Staff").click();
		await expect(page.locator('[data-panel="staff-proposal"]').first()).toBeVisible({ timeout: 10_000 });
		await page.locator('button.goal-tab-pill[title="Chat"]').first().click();
		await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
	});

	test("review panel tabs render, switch, close, and keep submit disabled without annotations", async ({ page }) => {
		await page.evaluate(() => (window as any).__setReviewFixture([
			{ title: "Document A", markdown: "# Document A\n\nFirst document content." },
			{ title: "Document B", markdown: "# Document B\n\nSecond document content." },
			{ title: "Document C", markdown: "# Document C\n\nThird document content." },
		]));

		await expect(page.locator(".goal-preview-panel button.goal-tab-pill[data-panel-tab-kind='review']")).toHaveCount(3, { timeout: 10_000 });
		await reviewPanelTab(page, "Document B").click();
		await expect(page.locator("review-pane .review-tab")).toHaveCount(3, { timeout: 10_000 });
		await expect(page.locator("review-document").getByText("Second document content").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("button.review-submit-btn")).toBeDisabled();

		await page.locator('review-pane button.review-tab[title="Document A"]').click();
		await expect(page.locator("review-document").getByText("First document content").first()).toBeVisible({ timeout: 10_000 });

		await page.locator('review-pane button.review-tab[title="Document B"] .review-tab-close').click();
		await expect(reviewPanelTab(page, "Document B")).toHaveCount(0, { timeout: 5_000 });
		await expect.poll(async () => page.evaluate(() => (window as any).__getReviewState().titles)).toEqual(["Document A", "Document C"]);
	});

	test("proposal pane styles stay eagerly imported and apply their discriminating rules", async ({ page }) => {
		const mainSource = fs.readFileSync(MAIN_SRC, "utf8");
		expect(mainSource).toContain('import "./workflow-page.css";');
		expect(mainSource).toContain('import "./role-manager.css";');
		expect(mainSource).toContain('import "./tool-manager.css";');

		await page.addStyleTag({ content: ":root{--border:#d0d0d0;--background:#fff;--secondary:#f4f4f5;--foreground:#111;--muted-foreground:#666;--primary:#2563eb;}" });
		await page.addStyleTag({ path: WORKFLOW_CSS });
		await page.addStyleTag({ path: ROLE_CSS });
		await page.addStyleTag({ path: TOOL_CSS });

		const styles = await page.evaluate(() => {
			const probe = (className: string) => {
				const el = document.createElement("div");
				el.className = className;
				document.body.appendChild(el);
				try {
					const cs = window.getComputedStyle(el);
					return { display: cs.display, borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle, borderRadius: cs.borderTopLeftRadius };
				} finally {
					el.remove();
				}
			};
			return {
				wfGate: probe("wf-gate-card"),
				roleRow: probe("role-row"),
				toolRow: probe("tool-row"),
			};
		});

		expect(styles.wfGate.borderRadius).toBe("8px");
		expect(styles.wfGate.borderTopWidth).toBe("1px");
		expect(styles.wfGate.borderTopStyle).toBe("solid");
		expect(styles.roleRow.display).toBe("flex");
		expect(styles.toolRow.display).toBe("flex");
	});
});
