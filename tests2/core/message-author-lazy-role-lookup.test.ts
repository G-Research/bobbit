import { describe, expect, it } from "vitest";
import { agentAuthorForSession } from "../../src/server/agent/message-author.ts";

function roleLookup(role: { name?: string; label?: string } | undefined) {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			getRole(name: string) {
				calls.push(name);
				return role as any;
			},
		},
	};
}

describe("agentAuthorForSession lazy role lookup", () => {
	it("uses staff and title labels without resolving the session role", () => {
		const titleLookup = roleLookup({ name: "reviewer", label: "Reviewer" });
		expect(agentAuthorForSession({ id: "title", title: "Session title", role: " reviewer " }, titleLookup.deps).label)
			.toBe("Session title");
		expect(titleLookup.calls).toEqual([]);

		const staffLookup = roleLookup({ name: "reviewer", label: "Reviewer" });
		expect(agentAuthorForSession(
			{ id: "staff", staffId: "staff-1", role: "reviewer" },
			{ ...staffLookup.deps, getStaff: () => ({ name: "Ada" } as any) },
		).label).toBe("Ada");
		expect(staffLookup.calls).toEqual([]);
	});

	it.each([
		["role label", { name: "reviewer", label: "Reviewer" }, "Reviewer"],
		["role name", { name: "Reviewer name" }, "Reviewer name"],
		["bare role name", undefined, "reviewer"],
	] as const)("uses the %s fallback after one role lookup", (_fallback, role, label) => {
		const lookup = roleLookup(role);
		expect(agentAuthorForSession({ id: "role", role: " reviewer " }, lookup.deps).label).toBe(label);
		expect(lookup.calls).toEqual(["reviewer"]);
	});

	it("uses Agent without resolving a missing session role", () => {
		const lookup = roleLookup({ name: "reviewer", label: "Reviewer" });
		expect(agentAuthorForSession({ id: "agent", title: " " }, lookup.deps).label).toBe("Agent");
		expect(lookup.calls).toEqual([]);
	});
});
