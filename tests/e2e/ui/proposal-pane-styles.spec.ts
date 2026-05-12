/**
 * Proposal preview pane stylesheets — pinning test.
 *
 * Regression guard for a bug where the project-proposal preview pane
 * ([data-panel="project-proposal"]) reuses CSS classes (.wf-gate-card,
 * .wf-list, .wf-vstep-card, .wf-phase-group, …) whose stylesheet lives
 * in `src/app/workflow-page.css`. That file was previously only imported
 * by `src/app/workflow-page.ts`, a lazy-loaded module pulled in via a
 * dynamic `import()` when the user navigates to Settings → Workflows.
 *
 * If a user opened a project-assistant / project-proposal session in a
 * fresh tab without ever visiting that settings page, the preview pane
 * rendered with only the small overrides in `app.css` and none of the
 * base styling — gate cards had no border, no border-radius, no padding.
 *
 * The fix decouples the CSS from the lazy JS chunk: `main.ts` now imports
 * `workflow-page.css` (and the sibling role/tool stylesheets) eagerly so
 * the proposal panes are always styled, regardless of whether the user
 * has visited the corresponding settings page.
 *
 * This test asserts two things on a FRESH page load, with NO prior
 * navigation to /workflows, /roles, /tools, or /settings:
 *
 *   1. The CSS rules for `.wf-gate-card`, `.role-row`, and `.tool-row`
 *      are present in `document.styleSheets`. Before the fix, these
 *      rules would NOT be loaded (their stylesheets were chunked with
 *      the lazy JS modules and never imported by main.ts).
 *
 *   2. A synthetic `.wf-gate-card` element mounted in the document body
 *      has the discriminating computed style `border-radius: 8px` and
 *      `border-top-width: 1px`. Before the fix, both resolve to user-
 *      agent defaults (`0px` / `0px`).
 *
 * The synthetic-element approach side-steps any need to drive a project
 * assistant or mid-session proposal flow into a state where .wf-gate-card
 * is rendered in the DOM — what matters for the bug is whether the CSS
 * is loaded, not whether the panel happens to contain the class right
 * now. (See tests/e2e/ui/mid-session-project-proposal.spec.ts and
 * tests/e2e/ui/project-assistant.spec.ts for the end-to-end proposal
 * flows.)
 *
 * Pins fix for: "Fix proposal pane CSS".
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

/** Returns true if any same-origin stylesheet in the document has a rule
 *  whose cssText contains the given selector substring. */
function hasRuleFor(selector: string): boolean {
	return Array.from(document.styleSheets).some(sheet => {
		try {
			return Array.from(sheet.cssRules ?? []).some(rule =>
				(rule as CSSRule).cssText?.includes(selector),
			);
		} catch {
			// Cross-origin sheets throw on cssRules access — skip.
			return false;
		}
	});
}

test.describe("Proposal preview pane stylesheets are loaded eagerly", () => {
	test("workflow-page / role-manager / tool-manager CSS is loaded on a fresh tab without visiting Settings", async ({ page }) => {
		// Fresh page load — do NOT navigate to /workflows, /roles, /tools,
		// or /settings first. The bug only manifests when none of the lazy
		// settings page modules have been imported.
		await openApp(page);

		// 1. CSS rules from each lazy page's stylesheet must be present in
		//    document.styleSheets, proving the CSS was loaded eagerly even
		//    though no settings page JS has been imported.
		const ruleProbes = await page.evaluate((fnSource: string) => {
			// eslint-disable-next-line no-new-func
			const has = new Function("selector", `${fnSource}; return hasRuleFor(selector);`) as (s: string) => boolean;
			return {
				wfGateCard: has(".wf-gate-card"),
				roleRow: has(".role-row"),
				toolRow: has(".tool-row"),
			};
		}, hasRuleFor.toString());

		expect(ruleProbes.wfGateCard, "workflow-page.css must be loaded eagerly so the project-proposal pane renders styled").toBe(true);
		expect(ruleProbes.roleRow, "role-manager.css must be loaded eagerly so the role-proposal pane renders styled").toBe(true);
		expect(ruleProbes.toolRow, "tool-manager.css must be loaded eagerly so the tool-proposal pane renders styled").toBe(true);

		// 2. Mount a synthetic .wf-gate-card and assert it picks up the
		//    discriminating computed styles defined in workflow-page.css.
		//    Before the fix these resolved to user-agent defaults.
		const wfGateStyles = await page.evaluate(() => {
			const el = document.createElement("div");
			el.className = "wf-gate-card";
			document.body.appendChild(el);
			try {
				const cs = window.getComputedStyle(el);
				return {
					borderRadius: cs.borderTopLeftRadius,
					borderTopWidth: cs.borderTopWidth,
					borderTopStyle: cs.borderTopStyle,
				};
			} finally {
				el.remove();
			}
		});
		// .wf-gate-card { border: 1px solid var(--border); border-radius: 8px; }
		expect(wfGateStyles.borderRadius).toBe("8px");
		expect(wfGateStyles.borderTopWidth).toBe("1px");
		expect(wfGateStyles.borderTopStyle).toBe("solid");

		// Same probe for .role-row — a discriminating selector from
		// role-manager.css. (.role-row sets padding + border.)
		const roleRowStyles = await page.evaluate(() => {
			const el = document.createElement("div");
			el.className = "role-row";
			document.body.appendChild(el);
			try {
				const cs = window.getComputedStyle(el);
				return { display: cs.display, borderTopWidth: cs.borderTopWidth };
			} finally {
				el.remove();
			}
		});
		// .role-row uses flex layout — display defaults to "block" without the stylesheet.
		expect(roleRowStyles.display).toBe("flex");

		// Same probe for .tool-row — a discriminating selector from tool-manager.css.
		const toolRowStyles = await page.evaluate(() => {
			const el = document.createElement("div");
			el.className = "tool-row";
			document.body.appendChild(el);
			try {
				const cs = window.getComputedStyle(el);
				return { display: cs.display };
			} finally {
				el.remove();
			}
		});
		expect(toolRowStyles.display).toBe("flex");
	});
});
