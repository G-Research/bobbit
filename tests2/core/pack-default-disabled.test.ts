// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// Ships-disabled-by-default first-party packs (Part 1 of the "Hide/Disable PR &
// Hindsight" goal). Pins the manifest `defaultDisabled` flag, the
// `isPackEffectivelyEnabled` chokepoint, the `activeBuiltinFirstPartyPackEntries`
// contribution filter, and the ConfigCascade role-drop behaviour:
//
//   - pr-walkthrough ships `defaultDisabled: true` and contributes NOTHING with
//     no stored activation override (role `pr-reviewer` unresolvable).
//   - an explicit `{ enabled: true }` override opts it back in (role resolves).
//   - the `terminal` built-in pack (no `defaultDisabled`) is unaffected — it
//     stays in the contribution band by default (regression guard).
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_MARKET_PACKS = path.join(__dirname, "..", "..", "market-packs");

const { parseManifest } = await import("../../src/server/agent/pack-manifest.ts");
const { isPackEffectivelyEnabled, activeBuiltinFirstPartyPackEntries, builtinFirstPartyPackEntries } =
	await import("../../src/server/agent/builtin-packs.ts");
const { ConfigCascade } = await import("../../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../../src/server/agent/builtin-config.ts");
const { HEADQUARTERS_PROJECT_ID } = await import("../../src/server/agent/project-registry.ts");
const { PackContributionRegistry } = await import("../../src/server/extension-host/pack-contribution-registry.ts");
const { ProjectConfigStore } = await import("../../src/server/agent/project-config-store.ts");

function mkTemp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pack-default-disabled-"));
}

describe("pack manifest — defaultDisabled flag", () => {
	it("parses `defaultDisabled: true`", () => {
		const m = parseManifest("name: p\ndescription: d\nversion: 1.0.0\ndefaultDisabled: true\ncontents: { roles: [], tools: [], skills: [] }\n");
		assert.ok(m);
		assert.equal(m.defaultDisabled, true);
	});

	it("omits the flag when absent (today's default-enabled behaviour)", () => {
		const m = parseManifest("name: p\ndescription: d\nversion: 1.0.0\ncontents: { roles: [], tools: [], skills: [] }\n");
		assert.ok(m);
		assert.equal(m.defaultDisabled, undefined);
	});

	it("treats non-`true` values as absent (only an explicit true opts in)", () => {
		const m = parseManifest("name: p\ndescription: d\nversion: 1.0.0\ndefaultDisabled: false\ncontents: { roles: [], tools: [], skills: [] }\n");
		assert.ok(m);
		assert.equal(m.defaultDisabled, undefined);
	});

	it("the shipped pr-walkthrough pack ships disabled by default", () => {
		const raw = fs.readFileSync(path.join(REPO_MARKET_PACKS, "pr-walkthrough", "pack.yaml"), "utf-8");
		const m = parseManifest(raw);
		assert.ok(m);
		assert.equal(m.defaultDisabled, true);
	});

	it("the shipped terminal pack does NOT ship disabled", () => {
		const raw = fs.readFileSync(path.join(REPO_MARKET_PACKS, "terminal", "pack.yaml"), "utf-8");
		const m = parseManifest(raw);
		assert.ok(m);
		assert.equal(m.defaultDisabled, undefined);
	});
});

describe("isPackEffectivelyEnabled", () => {
	it("normal packs are always effectively enabled here (per-entity filtering applies downstream)", () => {
		assert.equal(isPackEffectivelyEnabled({}, undefined), true);
		assert.equal(isPackEffectivelyEnabled({}, { enabled: true }), true);
		assert.equal(isPackEffectivelyEnabled({ defaultDisabled: false }, {}), true);
	});

	it("ships-disabled packs are OFF unless an explicit enable override is stored", () => {
		assert.equal(isPackEffectivelyEnabled({ defaultDisabled: true }, undefined), false);
		assert.equal(isPackEffectivelyEnabled({ defaultDisabled: true }, {}), false);
		assert.equal(isPackEffectivelyEnabled({ defaultDisabled: true }, { roles: ["x"] }), false);
		assert.equal(isPackEffectivelyEnabled({ defaultDisabled: true }, { enabled: true }), true);
	});
});

describe("activeBuiltinFirstPartyPackEntries", () => {
	it("drops pr-walkthrough by default but keeps terminal (regression guard)", () => {
		const active = activeBuiltinFirstPartyPackEntries(REPO_MARKET_PACKS, () => undefined).map((e) => e.manifest!.name);
		// terminal (no defaultDisabled) still present in the contribution band.
		assert.ok(active.includes("terminal"), `expected terminal, got ${active.join(",")}`);
		// pr-walkthrough ships disabled → excluded from CONTRIBUTION resolution.
		assert.ok(!active.includes("pr-walkthrough"), `pr-walkthrough must be excluded by default, got ${active.join(",")}`);
	});

	it("includes pr-walkthrough once an explicit enable override is present", () => {
		const active = activeBuiltinFirstPartyPackEntries(
			REPO_MARKET_PACKS,
			(name) => (name === "pr-walkthrough" ? { enabled: true } : undefined),
		).map((e) => e.manifest!.name);
		assert.ok(active.includes("pr-walkthrough"), `pr-walkthrough must resolve when enabled, got ${active.join(",")}`);
		assert.ok(active.includes("terminal"));
	});

	it("the RAW enumerator (marketplace listing) always includes pr-walkthrough", () => {
		// The Market UI lists built-in rows from the raw enumerator, so a
		// disabled pack still shows a row + toggle.
		const raw = builtinFirstPartyPackEntries(REPO_MARKET_PACKS).map((e) => e.manifest!.name);
		assert.ok(raw.includes("pr-walkthrough"));
	});
});

describe("ConfigCascade — ships-disabled built-in band", () => {
	function makeCascade(builtinPacksDir: string): InstanceType<typeof ConfigCascade> {
		const builtins = new BuiltinConfigProvider(mkTemp());
		return new ConfigCascade(
			builtins,
			{ getRoles: () => [], getTools: () => [], getToolGroupPolicies: () => ({}) },
			{ getOrCreate: () => undefined } as any,
			undefined,
			undefined,
			mkTemp(), // globalUserBase
			builtinPacksDir,
		);
	}

	it("does NOT resolve the pr-walkthrough `pr-reviewer` role by default", () => {
		const cascade = makeCascade(REPO_MARKET_PACKS);
		cascade.setPackActivationProvider({ disabled: () => ({}) });
		const roles = cascade.resolveRoles(HEADQUARTERS_PROJECT_ID);
		assert.ok(!roles.some((r) => r.item.name === "pr-reviewer"), "pr-reviewer must not resolve while pr-walkthrough is default-OFF");
	});

	it("resolves `pr-reviewer` once pr-walkthrough is explicitly enabled", () => {
		const cascade = makeCascade(REPO_MARKET_PACKS);
		cascade.setPackActivationProvider({
			disabled: (_scope, _projectId, packName) => (packName === "pr-walkthrough" ? { enabled: true } : {}),
		});
		const roles = cascade.resolveRoles(HEADQUARTERS_PROJECT_ID);
		assert.ok(roles.some((r) => r.item.name === "pr-reviewer"), "pr-reviewer must resolve when pr-walkthrough is enabled");
	});
});

describe("PackContributionRegistry via the active built-in band (entrypoints/routes/panels/providers)", () => {
	// Mirror the production wiring: the built-in band feeding the contribution
	// registry is the ACTIVE (effectively-enabled) enumerator, backed by a real
	// on-disk ProjectConfigStore for server-scope activation.
	function registryFor(store: InstanceType<typeof ProjectConfigStore>): InstanceType<typeof PackContributionRegistry> {
		const enumerate = () =>
			activeBuiltinFirstPartyPackEntries(REPO_MARKET_PACKS, (packName) => store.getPackActivation("server", packName));
		return new PackContributionRegistry(
			enumerate,
			(scope, _projectId, packName) => store.getPackActivation(scope as any, packName).entrypoints ?? [],
		);
	}

	it("registers NONE of pr-walkthrough's contributions by default (default-OFF)", () => {
		const store = new ProjectConfigStore(mkTemp());
		const pack = registryFor(store).getPack(undefined, "pr-walkthrough");
		assert.equal(pack, undefined, "pr-walkthrough must not register any contributions while default-OFF");
	});

	it("registers entrypoints, routes and panel once explicitly enabled, and reload persists it", () => {
		const dir = mkTemp();
		const store = new ProjectConfigStore(dir);
		store.setPackActivation("server", "pr-walkthrough", { enabled: true });

		const pack = registryFor(store).getPack(undefined, "pr-walkthrough");
		assert.ok(pack, "pr-walkthrough registers once enabled");
		const listNames = pack!.entrypoints.map((e) => e.listName);
		assert.ok(listNames.includes("pr-walkthrough-open"), `expected pr-walkthrough-open, got ${listNames.join(",")}`);
		assert.ok(pack!.routes?.names?.includes("bundle"), "routes register when enabled");
		assert.ok(pack!.panels.some((p) => p.id === "pr-walkthrough.panel"), "panel registers when enabled");

		// The enable survives a simulated restart (store re-instantiated from disk).
		const restarted = new ProjectConfigStore(dir);
		assert.ok(restarted.getPackActivation("server", "pr-walkthrough").enabled === true);
		assert.ok(registryFor(restarted).getPack(undefined, "pr-walkthrough"), "still registered after restart");
	});
});
