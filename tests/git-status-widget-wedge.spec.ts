/**
 * Regression tests for GitStatusWidget "wedge" bug.
 *
 * Reproduces the disconnect-mid-close race documented on the goal branch:
 * the widget couples `expanded`, `_closing`, and `_dropdownEl`, and the ONLY
 * code path that resets the boolean state is the `animationend` listener
 * attached to the portal node. If the portal is removed (host disconnect,
 * external removal, or the animation is cancelled) `animationend` never
 * fires, the widget gets stuck in one of two wedge states, and `_toggle`
 * silently no-ops on every subsequent click.
 *
 * All three tests MUST FAIL on the current goal branch HEAD. The fix
 * (reset transient state in `disconnectedCallback`, self-heal `_toggle`
 * when the portal is missing, add an `animationcancel` listener) will
 * make them pass.
 *
 * Pattern mirrors `tests/git-status-widget-states.spec.ts` (same fixture,
 * same bundle, same `buildBundle` bootstrap) so we exercise the real Lit
 * widget — the JS-replica fixture used by `git-status-interactions.spec.ts`
 * does not run `disconnectedCallback`.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/git-status-widget-states.html");
const BUNDLE = path.resolve("tests/fixtures/git-status-widget-states-bundle.js");
const ENTRY = path.resolve("tests/fixtures/git-status-widget-states-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GitStatusWidget.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, WIDGET_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.waitForFunction(
		() => !!customElements.get("git-status-widget"),
		null,
		{ timeout: 10_000 },
	);
}

/**
 * Mount a widget with branch data so `_toggle` is interactive (skeleton
 * state guards out `loading && !branch`).
 */
async function mountReady(page: any): Promise<void> {
	await page.evaluate(() => {
		const host = document.getElementById("container")!;
		host.innerHTML = "";
		const w = document.createElement("git-status-widget") as any;
		w.loading = false;
		w.branch = "feature/wedge";
		w.primaryBranch = "master";
		w.primaryRef = "origin/master";
		w.isOnPrimary = false;
		w.clean = true;
		w.statusFiles = [];
		host.appendChild(w);
	});
	await page.waitForSelector('git-status-widget button[data-state="ready"]');
}

test.describe("GitStatusWidget wedge — disconnect-mid-close race", () => {
	test("regression: host disconnect during close animation, then reconnect — next click must reopen", async ({
		page,
	}) => {
		await gotoAndWait(page);
		await mountReady(page);

		// Step 1: click to open. Dropdown portal should be in body.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);

		// Step 2: click again to start the close animation. The widget sets
		// `_closing = true` synchronously and adds the closing CSS class, but
		// the `animationend` listener has not yet fired (200ms animation).
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(
			page.locator("#git-status-dropdown.git-dropdown-closing"),
		).toHaveCount(1);

		// Step 3: BEFORE the animation completes, disconnect the host from the
		// DOM and reconnect it. This mirrors AgentInterface re-render churn
		// briefly flipping `bgProcesses.length > 0 || gitRepoKnown !== 'no'`
		// false then true again, which yanks the widget out of and back into
		// its slot.
		await page.evaluate(() => {
			const w = document.querySelector("git-status-widget")!;
			const host = w.parentElement!;
			host.removeChild(w);
			// Reconnect — same instance.
			host.appendChild(w);
		});

		// Re-acquire the button (Lit re-rendered after reconnection).
		await page.waitForSelector('git-status-widget button[data-state="ready"]');

		// Step 4: click. The widget should reopen the dropdown.
		//
		// BUG: `disconnectedCallback` removed the portal without resetting
		// `expanded`/`_closing`, so the instance is now in Wedge A
		// (`expanded=true, _closing=true, _dropdownEl=null`). `_toggle`
		// matches neither branch, the click is a silent no-op, and no
		// dropdown is ever portaled back into the body.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);

		// Sanity: re-opened portal must not carry the stale closing class.
		await expect(
			page.locator("#git-status-dropdown.git-dropdown-closing"),
		).toHaveCount(0);
	});

	test("self-heal: external removal of #git-status-dropdown portal — next click must reopen", async ({
		page,
	}) => {
		await gotoAndWait(page);
		await mountReady(page);

		// Open the dropdown.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);

		// Externally yank the portal out of the body. This simulates a
		// well-meaning sibling script (or a third-party DOM mutation) wiping
		// document.body. The widget instance still believes `expanded === true`
		// and `_dropdownEl` still references the now-detached node.
		await page.evaluate(() => {
			document.getElementById("git-status-dropdown")!.remove();
		});
		await expect(page.locator("#git-status-dropdown")).toHaveCount(0);

		// Click. Source of truth is portal presence, not the boolean flag —
		// a self-healing `_toggle` should treat "no portal in document" as
		// "open me", not "close me".
		//
		// BUG: `_toggle` enters the close branch (`expanded && !_closing`),
		// `_closeDropdown` proceeds because `_dropdownEl` is still truthy
		// (detached but non-null), sets `_closing=true`, adds the closing
		// class to the detached node, and attaches `animationend` to a node
		// that will never animate. State is now Wedge A on the next click.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);
	});

	test("animationcancel: state must reset and next click must reopen", async ({
		page,
	}) => {
		await gotoAndWait(page);
		await mountReady(page);

		// Open.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);

		// Start the close animation.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(
			page.locator("#git-status-dropdown.git-dropdown-closing"),
		).toHaveCount(1);

		// Dispatch `animationcancel` instead of `animationend`. Per the CSS
		// Animations spec, this is what fires when an animating element is
		// removed from the document, when its animation property is changed
		// out from under it, or when `prefers-reduced-motion` cancels it.
		// The widget's only state-reset path is the `animationend` listener,
		// so this should leave it wedged.
		await page.evaluate(() => {
			const portal = document.getElementById("git-status-dropdown")!;
			portal.dispatchEvent(
				new AnimationEvent("animationcancel", {
					bubbles: true,
					cancelable: false,
				}),
			);
		});

		// Internal state must reflect "closed" — no closing animation in
		// flight, dropdown not expanded. Read straight off the Lit instance.
		const stateAfterCancel = await page.evaluate(() => {
			const w = document.querySelector("git-status-widget") as any;
			return { expanded: w.expanded, closing: w._closing };
		});
		expect(stateAfterCancel.closing).toBe(false);
		expect(stateAfterCancel.expanded).toBe(false);

		// Click. With state reset, `_toggle` enters the open branch and
		// portals a fresh dropdown.
		//
		// BUG: state never reset → click hits Wedge A and is a no-op.
		await page.locator('git-status-widget button[data-state="ready"]').click();
		await expect(page.locator("#git-status-dropdown")).toHaveCount(1);
		await expect(
			page.locator("#git-status-dropdown.git-dropdown-closing"),
		).toHaveCount(0);
	});
});
