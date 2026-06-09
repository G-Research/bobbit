/**
 * Unit tests for Slice A — server-resolved pack identity
 * (src/server/extension-host/pack-identity.ts), design
 * docs/design/extension-host-phase2.md §2.
 *
 * Pinned invariants (the cross-pack-denial precondition for B1/B3):
 *   - `packId` = the directory name AFTER the `market-packs` segment in baseDir.
 *   - A non-pack baseDir (no `market-packs` segment) → packId "" + isPack false.
 *   - `contributionId` = `${groupDir}/${tool}`.
 *   - Identity is derived PURELY from the host-resolved location + tool name —
 *     no caller-supplied field (args/body) can override or forge it.
 *   - `resolvePackIdentityForTool` delegates to the resolver's winning location.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolvePackIdentity,
	resolvePackIdentityForTool,
} from "../src/server/extension-host/pack-identity.ts";
import type { ActionToolLocationResolver } from "../src/server/extension-host/action-dispatcher.ts";

describe("resolvePackIdentity — packId derivation", () => {
	it("derives packId from a market-pack baseDir (segment after market-packs)", () => {
		const ident = resolvePackIdentity(
			{ baseDir: "/home/u/.bobbit/config/market-packs/retry-demo/tools", groupDir: "retry" },
			"retry",
		);
		assert.equal(ident.packId, "retry-demo");
		assert.equal(ident.isPack, true);
		assert.equal(ident.contributionId, "retry/retry");
	});

	it("handles Windows-style backslash separators", () => {
		const ident = resolvePackIdentity(
			{ baseDir: "C:\\Users\\u\\.bobbit\\config\\market-packs\\artifacts\\tools", groupDir: "viewer" },
			"open_artifact",
		);
		assert.equal(ident.packId, "artifacts");
		assert.equal(ident.isPack, true);
		assert.equal(ident.contributionId, "viewer/open_artifact");
	});

	it("a non-pack baseDir → packId '' and isPack false", () => {
		const ident = resolvePackIdentity(
			{ baseDir: "/app/defaults/tools", groupDir: "agent" },
			"extension",
		);
		assert.equal(ident.packId, "");
		assert.equal(ident.isPack, false);
		assert.equal(ident.contributionId, "agent/extension");
	});

	it("a directory merely NAMED like market-packs does NOT match (structural, not substring)", () => {
		const ident = resolvePackIdentity(
			{ baseDir: "/home/u/my-market-packs-notes/tools", groupDir: "g" },
			"t",
		);
		assert.equal(ident.packId, "");
		assert.equal(ident.isPack, false);
	});

	it("undefined location → empty packId, isPack false, contributionId '/tool'", () => {
		const ident = resolvePackIdentity(undefined, "some_tool");
		assert.equal(ident.packId, "");
		assert.equal(ident.isPack, false);
		assert.equal(ident.contributionId, "/some_tool");
	});

	it("market-packs as the trailing segment (no pack-name) → empty packId", () => {
		const ident = resolvePackIdentity(
			{ baseDir: "/home/u/.bobbit/config/market-packs", groupDir: "g" },
			"t",
		);
		assert.equal(ident.packId, "");
		// baseDir still contains a market-packs segment, so it counts as a pack root
		// per isMarketPackBaseDir — but no derivable name follows.
		assert.equal(ident.isPack, true);
	});
});

describe("resolvePackIdentity — un-forgeable (server-derived only)", () => {
	it("ignores everything but loc + tool (no caller field can override identity)", () => {
		// A malicious caller might try to smuggle a packId via args/body. The
		// function signature accepts ONLY (loc, tool) — there is no channel for a
		// caller-supplied packId to reach it. Identity is purely a function of the
		// host-resolved location.
		const loc = { baseDir: "/x/market-packs/honest-pack/tools", groupDir: "g" };
		const a = resolvePackIdentity(loc, "t");
		const b = resolvePackIdentity(loc, "t");
		assert.deepEqual(a, b);
		assert.equal(a.packId, "honest-pack");
		// Same location resolves to the same identity regardless of any out-of-band
		// data — there is no second argument that could spoof packId.
	});
});

describe("resolvePackIdentityForTool — delegates to the resolver's winning location", () => {
	const makeResolver = (
		loc: { baseDir: string; groupDir: string; actionsModule?: string } | undefined,
	): ActionToolLocationResolver => ({
		resolveToolLocation: () => loc,
	});

	it("resolves identity from the winning {baseDir,groupDir}", () => {
		const resolver = makeResolver({
			baseDir: "/srv/.bobbit/config/market-packs/pr-walkthrough/tools",
			groupDir: "walkthrough",
		});
		const ident = resolvePackIdentityForTool(resolver, "pr_walkthrough");
		assert.equal(ident.packId, "pr-walkthrough");
		assert.equal(ident.isPack, true);
		assert.equal(ident.contributionId, "walkthrough/pr_walkthrough");
	});

	it("an unresolved tool → empty identity, isPack false", () => {
		const resolver = makeResolver(undefined);
		const ident = resolvePackIdentityForTool(resolver, "ghost");
		assert.equal(ident.packId, "");
		assert.equal(ident.isPack, false);
		assert.equal(ident.contributionId, "/ghost");
	});

	it("a builtin (non-pack) winner → empty packId", () => {
		const resolver = makeResolver({ baseDir: "/app/defaults/tools", groupDir: "agent" });
		const ident = resolvePackIdentityForTool(resolver, "extension");
		assert.equal(ident.packId, "");
		assert.equal(ident.isPack, false);
	});
});
