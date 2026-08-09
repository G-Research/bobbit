import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-mobile.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED pure function
// (getMobileSidebarBehavior). There is no exported src counterpart — the mobile
// behaviour is expressed inline at the sidebar render sites — so this port keeps
// a byte-identical replica of the fixture helper and preserves every assertion.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const renderHelpersSource = readFileSync(resolve(process.cwd(), "src/app/render-helpers.ts"), "utf8");
const appCssSource = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
	expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

function getMobileSidebarBehavior(isDesktop: boolean): {
	buttonsAlwaysVisible: boolean;
	rowPadding: string;
	showHamburgerMenu: boolean;
	autoCloseOnSelect: boolean;
} {
	return {
		buttonsAlwaysVisible: !isDesktop,
		rowPadding: "py-0.5",
		showHamburgerMenu: !isDesktop,
		autoCloseOnSelect: !isDesktop,
	};
}

describe("SB-33: Mobile sidebar behavior", () => {
	it("desktop: buttons hidden (hover-reveal), py-0.5 padding", () => {
		const r = getMobileSidebarBehavior(true);
		expect(r.buttonsAlwaysVisible).toBe(false);
		expect(r.rowPadding).toBe("py-0.5");
		expect(r.showHamburgerMenu).toBe(false);
		expect(r.autoCloseOnSelect).toBe(false);
	});

	it("mobile: buttons always visible, compact py-0.5 padding", () => {
		const r = getMobileSidebarBehavior(false);
		expect(r.buttonsAlwaysVisible).toBe(true);
		expect(r.rowPadding).toBe("py-0.5");
	});

	it("mobile: auto-close on session select", () => {
		expect(getMobileSidebarBehavior(false).autoCloseOnSelect).toBe(true);
	});

	it("mobile: hamburger menu shown", () => {
		expect(getMobileSidebarBehavior(false).showHamburgerMenu).toBe(true);
	});
});

describe("Mobile sidebar row layout regression", () => {
	it("gives the team-lead title the same flexible slot as ordinary session titles", () => {
		const teamLeadSource = sourceBetween(
			renderHelpersSource,
			"function renderTeamLeadRow(",
			"// ============================================================================\n// UNIFIED GOAL GROUP",
		);
		expect(teamLeadSource).toContain('class="flex-1 min-w-0 truncate" data-testid="sidebar-session-title-text"');
		expect(teamLeadSource).toContain("${renderSessionTime(session)}");
	});

	it("groups mobile actions with one extra row-gap before the first button", () => {
		const clusterCss = sourceBetween(appCssSource, ".sidebar-mobile-action-cluster {", "@media (max-width: 767px)");
		expect(clusterCss).toContain("gap: 0.25rem;");
		expect(clusterCss).toContain("margin-left: 0.25rem;");
		expect(renderHelpersSource).toContain('html`<span class="sidebar-mobile-action-cluster">${buttons}</span>`');
	});

	it("does not shift the mobile active spinner toward the first action", () => {
		const mobileCss = sourceBetween(appCssSource, "/* Mobile rows keep status metadata", ".sidebar-active-dot::after");
		expect(mobileCss).toContain("left: 0 !important;");
		expect(mobileCss).toContain("align-self: center;");
		expect(mobileCss).not.toContain("left: 2px");
	});
});
