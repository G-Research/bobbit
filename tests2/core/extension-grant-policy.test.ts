import { describe, expect, it } from "vitest";
import { resolveExtensionGrant, type ResolvedHook } from "../../src/server/agent/extension-grant-policy.js";
import type { ExtensionGrant } from "../../src/server/agent/project-config-store.js";

const grantedAt = "2025-02-03T04:05:06.000Z";
const decideHook: ResolvedHook = {
	packId: "pack-a",
	hookId: "decider",
	mode: "decide",
	capabilities: ["store", "session"],
};
const observeHook: ResolvedHook = {
	packId: "pack-a",
	hookId: "observer",
	mode: "observe",
	capabilities: ["store"],
};

function grant(overrides: Partial<ExtensionGrant> = {}): ExtensionGrant {
	return {
		packId: "pack-a",
		hookId: "decider",
		capability: "decide",
		grantedAt,
		grantedBy: "admin",
		...overrides,
	};
}

describe("extension capability grant policy", () => {
	it("fails closed for missing grants, wildcard-looking tuples, and mutate", () => {
		expect(resolveExtensionGrant([decideHook], [], { packId: "pack-a", hookId: "decider" }, "decide"))
		.toEqual({ allowed: false, reason: "grant_required" });
		expect(resolveExtensionGrant([decideHook], [grant({ packId: "*" })], { packId: "pack-a", hookId: "decider" }, "decide"))
		.toEqual({ allowed: false, reason: "grant_required" });
		expect(resolveExtensionGrant([decideHook], [grant({ capability: "mutate" })], { packId: "pack-a", hookId: "decider" }, "mutate"))
		.toEqual({ allowed: false, reason: "invalid_request" });
	});

	it("requires an exact active tuple and capability", () => {
		const grants = [
			grant({ capability: "decide" }),
			grant({ hookId: "observer", capability: "store" }),
			grant({ packId: "pack-b", capability: "decide" }),
		];

		expect(resolveExtensionGrant([decideHook, observeHook], grants, { packId: "pack-a", hookId: "decider" }, "decide"))
			.toMatchObject({ allowed: true, grant: grants[0] });
		expect(resolveExtensionGrant([decideHook, observeHook], grants, { packId: "pack-a", hookId: "decider" }, "store"))
			.toEqual({ allowed: false, reason: "grant_required" });
		expect(resolveExtensionGrant([decideHook, observeHook], grants, { packId: "pack-a", hookId: "observer" }, "store"))
			.toMatchObject({ allowed: true, grant: grants[1] });
		expect(resolveExtensionGrant([decideHook, observeHook], grants, { packId: "pack-b", hookId: "decider" }, "decide"))
			.toEqual({ allowed: false, reason: "inactive_hook" });
	});

	it("denies inactive, unsupported, and malformed requests before considering grants", () => {
		expect(resolveExtensionGrant([observeHook], [grant()], { packId: "pack-a", hookId: "decider" }, "decide"))
			.toEqual({ allowed: false, reason: "inactive_hook" });
		expect(resolveExtensionGrant([observeHook], [grant({ hookId: "observer", capability: "decide" })], { packId: "pack-a", hookId: "observer" }, "decide"))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolveExtensionGrant([decideHook], [grant({ capability: "store" })], { packId: "pack-a", hookId: "decider" }, "agents"))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolveExtensionGrant([decideHook], [grant()], { packId: "../pack", hookId: "decider" } as never, "decide"))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolveExtensionGrant([decideHook], [grant()], { packId: "pack-a", hookId: "decider" }, "unknown" as never))
			.toEqual({ allowed: false, reason: "invalid_request" });
	});

	it("ignores malformed stored rows and returns a defensive grant copy", () => {
		const malformed = { ...grant(), grantedAt: "not-an-iso-instant" } as ExtensionGrant;
		expect(resolveExtensionGrant([decideHook], [malformed], { packId: "pack-a", hookId: "decider" }, "decide"))
			.toEqual({ allowed: false, reason: "grant_required" });

		const stored = grant();
		const decision = resolveExtensionGrant([decideHook], [stored], { packId: "pack-a", hookId: "decider" }, "decide");
		expect(decision.allowed).toBe(true);
		if (decision.allowed) {
			expect(decision.grant).not.toBe(stored);
			decision.grant.grantedBy = "changed-by-caller";
		}
		expect(stored.grantedBy).toBe("admin");
	});
});
