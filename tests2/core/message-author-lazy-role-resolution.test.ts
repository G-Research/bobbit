import { describe, expect, it } from "vitest";
import {
	agentAuthorForSession,
	type AgentSessionIdentity,
} from "../../src/server/agent/message-author.ts";
import type { Role } from "../../src/server/agent/role-store.ts";

function role(overrides: Partial<Role> = {}): Role {
	return {
		name: "reviewer",
		label: "Reviewer",
		promptTemplate: "",
		accessory: "none",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function countedRoleLookup(result: Role | undefined) {
	const calls: string[] = [];
	return {
		calls,
		getRole: (name: string) => {
			calls.push(name);
			return result;
		},
	};
}

describe("agent author lazy role resolution", () => {
	it("does not resolve a role when the session title determines the label", () => {
		const lookup = countedRoleLookup(role());

		const author = agentAuthorForSession(
			{ id: "session", title: "Session title", role: "reviewer" },
			{ getRole: lookup.getRole },
		);

		expect(author.label).toBe("Session title");
		expect(lookup.calls).toEqual([]);
	});

	it("does not resolve a role when the staff name determines the label", () => {
		const lookup = countedRoleLookup(role());

		const author = agentAuthorForSession(
			{ id: "session", staffId: "staff", role: "reviewer" },
			{
				getStaff: () => ({ name: "Staff name" } as any),
				getRole: lookup.getRole,
			},
		);

		expect(author.label).toBe("Staff name");
		expect(lookup.calls).toEqual([]);
	});

	it("resolves the role exactly once when no staff name or title is available", () => {
		const lookup = countedRoleLookup(role({ label: "Role label" }));

		const author = agentAuthorForSession(
			{ id: "session", title: " ", role: "reviewer" },
			{ getRole: lookup.getRole },
		);

		expect(author.label).toBe("Role label");
		expect(lookup.calls).toEqual(["reviewer"]);
	});

	it("does not resolve a role when the session has no role", () => {
		const lookup = countedRoleLookup(role());

		const author = agentAuthorForSession(
			{ id: "session", title: " " },
			{ getRole: lookup.getRole },
		);

		expect(author.label).toBe("Agent");
		expect(lookup.calls).toEqual([]);
	});

	it.each<{
		name: string;
		session: AgentSessionIdentity;
		staffName?: string;
		role?: Role;
		expected: string;
	}>([
		{
			name: "staff name before title and role",
			session: { id: "session", staffId: "staff", title: "Session title", role: "reviewer" },
			staffName: "Staff name",
			role: role({ label: "Role label" }),
			expected: "Staff name",
		},
		{
			name: "title before role",
			session: { id: "session", title: "Session title", role: "reviewer" },
			role: role({ label: "Role label" }),
			expected: "Session title",
		},
		{
			name: "role label before role name",
			session: { id: "session", role: "reviewer" },
			role: role({ name: "Role name", label: "Role label" }),
			expected: "Role label",
		},
		{
			name: "role name before the bare role name",
			session: { id: "session", role: "reviewer" },
			role: role({ name: "Role name", label: " " }),
			expected: "Role name",
		},
		{
			name: "bare normalized role name before Agent",
			session: { id: "session", role: "  reviewer  " },
			role: undefined,
			expected: "reviewer",
		},
		{
			name: "Agent with no role",
			session: { id: "session" },
			expected: "Agent",
		},
	])("preserves label precedence: $name", ({ session, staffName, role: resolvedRole, expected }) => {
		const lookup = countedRoleLookup(resolvedRole);

		const author = agentAuthorForSession(session, {
			getStaff: staffName ? () => ({ name: staffName } as any) : undefined,
			getRole: lookup.getRole,
		});

		expect(author.label).toBe(expected);
	});
});
