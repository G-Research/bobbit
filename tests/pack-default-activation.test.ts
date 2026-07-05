/**
 * Unit tests for the PURE default-disabled pack activation resolution
 * (src/server/agent/pack-default-activation.ts).
 *
 * A built-in (server-scope) pack that ships `defaultDisabled: true` (e.g.
 * Hindsight) must resolve DORMANT on a fresh server — every contributed entity
 * de-activated — until the user explicitly enables it OR it is "already
 * configured" (a live setup must keep working untouched). An explicit user
 * toggle (a persisted disabled-refs record, or the force-enable marker) always
 * wins.
 *
 * These tests pin the priority ladder + the helpers that build the synthesized
 * all-disabled refs and detect a configured provider, independent of the server
 * wiring (covered by the API E2E).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveDefaultActivationOverlay,
	buildAllDisabledRefs,
	isProviderConfigConfigured,
	type DefaultActivationContext,
} from "../src/server/agent/pack-default-activation.ts";
import type { PackManifest } from "../src/server/agent/pack-types.ts";

const ALL_DISABLED = {
	tools: ["hindsight_recall", "hindsight_retain"],
	providers: ["memory"],
	entrypoints: ["hindsight-session-menu"],
	runtimes: ["hindsight"],
};

function ctx(over: Partial<DefaultActivationContext>): DefaultActivationContext {
	return {
		scope: "server",
		packName: "hindsight",
		stored: {},
		isDefaultDisabled: true,
		isForceEnabled: false,
		isConfigured: false,
		allDisabledRefs: ALL_DISABLED,
		...over,
	};
}

describe("resolveDefaultActivationOverlay — priority ladder", () => {
	it("fresh + unconfigured + untouched ⇒ synthesizes all-disabled (dormant)", () => {
		assert.deepEqual(resolveDefaultActivationOverlay(ctx({})), ALL_DISABLED);
	});

	it("not default-disabled ⇒ no overlay (normal pack)", () => {
		assert.equal(resolveDefaultActivationOverlay(ctx({ isDefaultDisabled: false })), undefined);
	});

	it("non-server scope ⇒ no overlay (built-ins toggle at server scope)", () => {
		assert.equal(resolveDefaultActivationOverlay(ctx({ scope: "project" })), undefined);
		assert.equal(resolveDefaultActivationOverlay(ctx({ scope: "global-user" })), undefined);
	});

	it("explicit stored override (non-empty) ⇒ honored verbatim (no overlay) — even if configured", () => {
		assert.equal(resolveDefaultActivationOverlay(ctx({ stored: { tools: ["hindsight_recall"] } })), undefined);
		assert.equal(
			resolveDefaultActivationOverlay(ctx({ stored: { tools: ["x"] }, isConfigured: true })),
			undefined,
		);
	});

	it("explicit-enable marker ⇒ enabled (no overlay), even when not configured", () => {
		assert.equal(resolveDefaultActivationOverlay(ctx({ isForceEnabled: true })), undefined);
	});

	it("already configured (live setup) ⇒ enabled (no overlay)", () => {
		assert.equal(resolveDefaultActivationOverlay(ctx({ isConfigured: true })), undefined);
	});
});

describe("buildAllDisabledRefs", () => {
	const manifest: PackManifest = {
		name: "hindsight",
		description: "d",
		version: "1",
		contents: {
			roles: [],
			tools: ["hindsight"], // group dir name — NOT what ends up in DisabledRefs.tools
			skills: [],
			entrypoints: ["hindsight-session-menu", "hindsight-route"],
			providers: ["memory"],
			mcp: [],
			piExtensions: [],
			runtimes: ["hindsight"],
			workflows: [], // reserved (finding EXT-03) — never activation-toggleable regardless
		},
	};

	it("uses CONCRETE tool names (not the contents.tools group dirs) and omits empty kinds", () => {
		const refs = buildAllDisabledRefs(manifest, ["hindsight_recall", "hindsight_retain", "hindsight_reflect"]);
		assert.deepEqual(refs.tools, ["hindsight_recall", "hindsight_retain", "hindsight_reflect"]);
		assert.deepEqual(refs.entrypoints, ["hindsight-session-menu", "hindsight-route"]);
		assert.deepEqual(refs.providers, ["memory"]);
		assert.deepEqual(refs.runtimes, ["hindsight"]);
		// empty kinds dropped entirely
		assert.equal("roles" in refs, false);
		assert.equal("skills" in refs, false);
		// hooks/workflows are never activation-toggleable (finding EXT-03) — see the
		// dedicated test below for a non-empty contents.workflows.
		assert.equal("hooks" in refs, false);
		assert.equal("workflows" in refs, false);
	});

	it("a non-empty contents.workflows (finding EXT-03: reserved, not toggleable) is NEVER included in disabled refs", () => {
		const withWorkflows: PackManifest = {
			...manifest,
			contents: { ...manifest.contents, workflows: ["my-wf"] },
		};
		const refs = buildAllDisabledRefs(withWorkflows, ["hindsight_recall"]);
		assert.equal("workflows" in refs, false);
	});

	it("returns a fresh defensive copy (mutation does not leak into the manifest)", () => {
		const refs = buildAllDisabledRefs(manifest, ["t"]);
		refs.providers!.push("mutated");
		assert.deepEqual(manifest.contents.providers, ["memory"]);
	});
});

describe("isProviderConfigConfigured — live-setup rule (b)", () => {
	it("non-empty externalUrl ⇒ configured", () => {
		assert.equal(isProviderConfigConfigured({ externalUrl: "http://localhost:9177" }), true);
	});

	it("managed / managed-external-postgres mode ⇒ configured", () => {
		assert.equal(isProviderConfigConfigured({ mode: "managed" }), true);
		assert.equal(isProviderConfigConfigured({ mode: "managed-external-postgres" }), true);
	});

	it("default external mode with no externalUrl ⇒ NOT configured", () => {
		assert.equal(isProviderConfigConfigured({ mode: "external" }), false);
		assert.equal(isProviderConfigConfigured({ externalUrl: "   " }), false); // whitespace only
		assert.equal(isProviderConfigConfigured({}), false);
	});

	it("missing / non-object config ⇒ NOT configured", () => {
		assert.equal(isProviderConfigConfigured(null), false);
		assert.equal(isProviderConfigConfigured(undefined), false);
		assert.equal(isProviderConfigConfigured("nope"), false);
		assert.equal(isProviderConfigConfigured([1, 2]), false);
	});
});
