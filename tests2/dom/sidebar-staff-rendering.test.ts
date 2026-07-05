import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-staff-rendering.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED pure function
// (getStaffRowInfo). There is no exported src counterpart — the staff-row logic
// is expressed inline at the sidebar render site — so this port keeps a
// byte-identical replica of the fixture helper and preserves every assertion.
import { describe, expect, it } from "vitest";

function getStaffRowInfo(
	staffMember: { name: string; retired?: boolean },
	activeSession: { status?: string } | null,
): {
	name: string;
	hasActiveSession: boolean;
	isRetired: boolean;
	showWakeButton: boolean;
	statusIndicator: string;
	dimmed: boolean;
} {
	return {
		name: staffMember.name,
		hasActiveSession: !!activeSession,
		isRetired: !!staffMember.retired,
		showWakeButton: !activeSession && !staffMember.retired,
		statusIndicator: activeSession
			? (activeSession.status === "streaming" || activeSession.status === "busy" ? "active" : "idle")
			: "none",
		dimmed: !!staffMember.retired,
	};
}

describe("SB-31: Staff row rendering", () => {
	it("staff with active streaming session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "streaming" });
		expect(r.hasActiveSession).toBe(true);
		expect(r.statusIndicator).toBe("active");
		expect(r.showWakeButton).toBe(false);
	});

	it("staff with active busy session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "busy" });
		expect(r.statusIndicator).toBe("active");
	});

	it("staff with idle session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "idle" });
		expect(r.statusIndicator).toBe("idle");
		expect(r.showWakeButton).toBe(false);
	});

	it("staff with no session shows wake button", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, null);
		expect(r.showWakeButton).toBe(true);
		expect(r.statusIndicator).toBe("none");
		expect(r.hasActiveSession).toBe(false);
	});

	it("retired staff is dimmed and has no wake button", () => {
		const r = getStaffRowInfo({ name: "old-greeter", retired: true }, null);
		expect(r.dimmed).toBe(true);
		expect(r.showWakeButton).toBe(false);
		expect(r.isRetired).toBe(true);
	});

	it("staff name is preserved", () => {
		const r = getStaffRowInfo({ name: "my-staff-member", retired: false }, null);
		expect(r.name).toBe("my-staff-member");
	});
});
