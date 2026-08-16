import { describe, expect, it } from "vitest";
import {
	createExtensionCapabilityGrantResolver,
	resolveExtensionGrant,
	type ResolvedHook,
} from "../../src/server/agent/extension-grant-policy.js";
import {
	type ExtensionGrant,
	type ExtensionHookGrant,
	type ExtensionPackGrant,
} from "../../src/server/agent/project-config-store.js";

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
const packOnlyCapabilities = [
	"service.manage",
	"memory.read",
	"memory.write",
	"memory.reflect",
	"memory.invalidate",
	"memory.read.all",
] as const;

function grant(overrides: Partial<ExtensionHookGrant> = {}): ExtensionHookGrant {
	return {
		packId: "pack-a",
		hookId: "decider",
		capability: "decide",
		grantedAt,
		grantedBy: "admin",
		...overrides,
	};
}

function packGrant(capability: typeof packOnlyCapabilities[number], packId = "pack-a"): ExtensionPackGrant {
	return {
		packId,
		principal: "pack",
		capability,
		grantedAt,
		grantedBy: "admin",
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

describe("live project capability grant resolver", () => {
	function liveResolver(initialGrants: ExtensionGrant[] = []) {
		let grants = initialGrants;
		const store = { getExtensionGrants: () => grants };
		const resolver = createExtensionCapabilityGrantResolver({
			contextForProject: projectId => projectId === "project-a" ? { projectConfigStore: store } : undefined,
			contributions: {
				getPack: (projectId, packId) => projectId === "project-a" && packId === "pack-a"
					? {
						packId: "pack-a",
						hooks: [{ id: "decider", mode: "decide", capabilities: ["store"], events: ["afterTurn"] }],
					} as never
					: undefined,
			},
		});
		return { resolver, replaceGrants: (next: ExtensionGrant[]) => { grants = next; } };
	}

	it("allows only active exact pack rows for every platform-owned pack capability", () => {
		for (const capability of packOnlyCapabilities) {
			const stored = packGrant(capability);
			const { resolver } = liveResolver([stored]);
			const decision = resolver("project-a", { kind: "pack", packId: "pack-a" }, capability);
			expect(decision).toMatchObject({ allowed: true, grant: { packId: "pack-a", principal: "pack", capability } });
			if (decision.allowed) {
				expect(decision.grant).not.toBe(stored);
				decision.grant.grantedBy = "caller-mutated";
			}
			expect(stored.grantedBy).toBe("admin");
			expect(resolver("project-a", { kind: "pack", packId: "pack-b" }, capability))
				.toEqual({ allowed: false, reason: "inactive_principal" });
		}
	});

	it("shares one live resolver across lifecycle, panel-route, and tool callers so revocation wins stale work", () => {
		const { resolver, replaceGrants } = liveResolver([
			packGrant("service.manage"), packGrant("memory.read"), packGrant("memory.write"),
		]);
		const lifecycle = () => resolver("project-a", { kind: "pack", packId: "pack-a" }, "service.manage");
		const panelRoute = () => resolver("project-a", { kind: "pack", packId: "pack-a" }, "memory.read");
		const agentTool = () => resolver("project-a", { kind: "pack", packId: "pack-a" }, "memory.write");

		expect(lifecycle().allowed).toBe(true);
		expect(panelRoute().allowed).toBe(true);
		expect(agentTool().allowed).toBe(true);
		replaceGrants([]);
		expect(lifecycle()).toEqual({ allowed: false, reason: "grant_required" });
		expect(panelRoute()).toEqual({ allowed: false, reason: "grant_required" });
		expect(agentTool()).toEqual({ allowed: false, reason: "grant_required" });
	});

	it("fails closed before stored grants for unavailable, inactive, malformed, unknown, and unsupported requests", () => {
		const { resolver } = liveResolver([packGrant("memory.read")]);
		expect(resolver("missing-project", { kind: "pack", packId: "pack-a" }, "memory.read"))
			.toEqual({ allowed: false, reason: "project_unavailable" });
		expect(resolver("project-a", { kind: "pack", packId: "not-installed" }, "memory.read"))
			.toEqual({ allowed: false, reason: "inactive_principal" });
		expect(resolver("project-a", { kind: "pack", packId: "../pack" } as never, "memory.read"))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolver("project-a", { kind: "service" as never, packId: "pack-a" } as never, "memory.read"))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolver("project-a", { kind: "pack", packId: "pack-a" }, "unknown" as never))
			.toEqual({ allowed: false, reason: "invalid_request" });
		expect(resolver("project-a", { kind: "pack", packId: "pack-a" }, "decide"))
			.toEqual({ allowed: false, reason: "unsupported_capability" });
		expect(resolver("project-a", { kind: "hook", packId: "pack-a", hookId: "decider" }, "memory.read"))
			.toEqual({ allowed: false, reason: "unsupported_capability" });
	});
});
