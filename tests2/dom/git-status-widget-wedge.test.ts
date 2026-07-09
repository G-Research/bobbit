import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/git-status-widget-wedge.spec.ts (v2-dom tier).
// Regression tests for the GitStatusWidget "wedge" bug (disconnect-mid-close
// race). Mounts the REAL Lit widget under happy-dom so disconnectedCallback and
// the portal lifecycle run for real — the JS-replica fixture never exercised
// those. Close animations that the browser fires (animationend/animationcancel)
// are dispatched manually since happy-dom does not run CSS animations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "../../src/ui/components/GitStatusWidget.js";

// Under vitest forks (isolate:false) the module — and its @customElement define
// side-effect — runs once, but happy-dom recreates `customElements` per file.
// Re-register so createElement upgrades the widget regardless of load order.
if (!customElements.get("git-status-widget")) customElements.define("git-status-widget", GitStatusWidget);

const dd = () => document.getElementById("git-status-dropdown");
const pill = (el: HTMLElement) => el.querySelector('button[data-state="ready"]') as HTMLButtonElement;

async function mountReady() {
	document.body.innerHTML = "";
	dd()?.remove();
	const el = document.createElement("git-status-widget") as any;
	Object.assign(el, {
		loading: false, branch: "feature/wedge", primaryBranch: "master", primaryRef: "origin/master",
		isOnPrimary: false, clean: true, statusFiles: [],
	});
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement & { updateComplete: Promise<unknown> };
}

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; dd()?.remove(); });

describe("GitStatusWidget wedge — disconnect-mid-close race", () => {
	it("regression: host disconnect during close animation, then reconnect — next click must reopen", async () => {
		const el = await mountReady();

		// Open.
		pill(el).click();
		await el.updateComplete;
		expect(dd()).toBeTruthy();

		// Start close (adds the closing class), then disconnect + reconnect the
		// host synchronously before the CSS animation could naturally finish.
		pill(el).click();
		const sawClosingClass = dd()!.classList.contains("git-dropdown-closing");
		const host = el.parentElement!;
		host.removeChild(el);
		host.appendChild(el);
		expect(sawClosingClass).toBe(true);
		await (el as any).updateComplete;

		// Next click must reopen a fresh dropdown, not silently no-op.
		pill(el).click();
		await (el as any).updateComplete;
		expect(dd()).toBeTruthy();
		expect(dd()!.classList.contains("git-dropdown-closing")).toBe(false);
	});

	it("self-heal: external removal of #git-status-dropdown portal — next click must reopen", async () => {
		const el = await mountReady();

		pill(el).click();
		await el.updateComplete;
		expect(dd()).toBeTruthy();

		// Externally yank the portal out of the document.
		dd()!.remove();
		expect(dd()).toBeNull();

		// Source of truth is portal presence — a self-healing toggle reopens.
		pill(el).click();
		await el.updateComplete;
		expect(dd()).toBeTruthy();
	});

	it("animationcancel: state must reset and next click must reopen", async () => {
		const el = await mountReady() as any;

		pill(el).click();
		await el.updateComplete;
		expect(dd()).toBeTruthy();

		// Start close then fire animationcancel synchronously.
		pill(el).click();
		const sawClosingClass = dd()!.classList.contains("git-dropdown-closing");
		dd()!.dispatchEvent(new Event("animationcancel", { bubbles: true }));
		expect(sawClosingClass).toBe(true);

		// Internal state must reflect "closed".
		expect(el._closing).toBe(false);
		expect(el.expanded).toBe(false);
		await el.updateComplete;

		// Click reopens a fresh dropdown with no stale closing class.
		pill(el).click();
		await el.updateComplete;
		expect(dd()).toBeTruthy();
		expect(dd()!.classList.contains("git-dropdown-closing")).toBe(false);
	});
});
