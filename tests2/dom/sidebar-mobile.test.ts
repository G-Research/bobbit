import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-mobile.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED pure function
// (getMobileSidebarBehavior). There is no exported src counterpart — the mobile
// behaviour is expressed inline at the sidebar render sites — so this port keeps
// a byte-identical replica of the fixture helper and preserves every assertion.
import { describe, expect, it } from "vitest";

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
