import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelOpenPermitStore } from "../src/server/extension-host/channel-open-permits.ts";
import { mintSurfaceToken } from "../src/server/extension-host/surface-binding.ts";
import { mintScopedExtensionChannelOpenPermit } from "../src/server/server.ts";

function makeSurfaceToken(overrides: Partial<{ sessionId: string; packId: string; contributionId: string }> = {}): string {
	return mintSurfaceToken({
		sessionId: "sess-1",
		packId: "terminal",
		contributionId: "panel:terminal",
		...overrides,
	});
}

function makeContributionRegistry() {
	return {
		getPack: (_projectId: string | undefined, packId: string) => (["terminal", "other"].includes(packId) ? { packId } : undefined),
		getPanel: (_projectId: string | undefined, packId: string, id: string) => (packId === id ? { id } : undefined),
		getEntrypoint: () => undefined,
		hasRoute: () => false,
		getChannel: (_projectId: string | undefined, packId: string, name: string) => {
			if (packId === "terminal" && name === "terminal") return { name: "terminal", protocol: "json", module: "terminal.js" };
			if (packId === "other" && name === "other-channel") return { name: "other-channel", protocol: "json", module: "other.js" };
			return undefined;
		},
	};
}

function resolveSession(id: string) {
	return id === "sess-1" ? { allowedTools: [] } : undefined;
}

function mintRoutePermit(opts: Partial<Parameters<typeof mintScopedExtensionChannelOpenPermit>[0]> = {}) {
	return mintScopedExtensionChannelOpenPermit({
		openPermits: new ChannelOpenPermitStore({ now: () => 1_000, randomToken: () => "grant-1" }),
		packContributionRegistry: makeContributionRegistry() as any,
		projectId: "project-1",
		resolver: {} as any,
		headerSessionId: "sess-1",
		rawHeaderSessionId: "sess-1",
		bodySessionId: "sess-1",
		surfaceToken: makeSurfaceToken(),
		name: "terminal",
		init: { singletonKey: "main" },
		resolveSession,
		...opts,
	});
}

describe("REST extension channel open permit policy", () => {
	it("mints a declared panel channel permit from scoped authority alone", async () => {
		const permits = new ChannelOpenPermitStore({ now: () => 1_000, randomToken: () => "grant-1" });
		const result = await mintRoutePermit({ openPermits: permits });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.openGrant, "grant-1");
		assert.equal(result.contributionId, "panel:terminal");
		assert.equal(result.channelName, "terminal");
		const consumed = permits.consume(result.openGrant, {
			sessionId: "sess-1",
			packId: "terminal",
			contributionId: "panel:terminal",
			channelName: "terminal",
			singletonKey: "main",
		});
		assert.equal(consumed.token, "grant-1");
	});

	it("rejects undeclared and cross-session channel permit requests", async () => {
		assert.deepEqual(await mintRoutePermit({ name: "missing" }), {
			ok: false,
			status: 404,
			error: "channel is not declared by this pack",
		});
		assert.deepEqual(await mintRoutePermit({ surfaceToken: makeSurfaceToken({ sessionId: "sess-2" }) }), {
			ok: false,
			status: 403,
			error: "surface token session mismatch",
		});
	});
});
