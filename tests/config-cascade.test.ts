/**
 * Unit test for ConfigCascade three-layer resolution of Role.model and
 * Role.thinkingLevel: project > server > builtin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConfigCascade, normalizeConfigProjectId } = await import("../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../src/server/agent/builtin-config.ts");
const { RoleStore } = await import("../src/server/agent/role-store.ts");
const { HEADQUARTERS_PROJECT_ID } = await import("../src/server/agent/project-registry.ts");

function mkTemp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cascade-test-"));
}

function writeRoleYaml(dir: string, name: string, fields: Record<string, unknown>) {
	const rolesDir = path.join(dir, "roles");
	fs.mkdirSync(rolesDir, { recursive: true });
	const lines = [
		`name: ${name}`,
		`label: ${fields.label ?? name}`,
		`accessory: ${fields.accessory ?? "none"}`,
		...(fields.model ? [`model: ${fields.model}`] : []),
		...(fields.thinkingLevel ? [`thinkingLevel: ${fields.thinkingLevel}`] : []),
		"createdAt: 0",
		"updatedAt: 0",
		`promptTemplate: ${fields.promptTemplate ?? "p"}`,
	];
	fs.writeFileSync(path.join(rolesDir, `${name}.yaml`), lines.join("\n"));
}

describe("ConfigCascade — Role.model and Role.thinkingLevel three-layer resolution", () => {
	it("project overrides server overrides builtin for both fields", () => {
		// Builtin layer: needs roles/<name>.yaml under <builtinsDir>
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", {
			model: "anthropic/claude-haiku",
			thinkingLevel: "low",
		});

		// Server layer: standalone server stores
		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "anthropic/claude-sonnet",
			thinkingLevel: "medium",
			createdAt: 0,
			updatedAt: 0,
		});

		// Project layer: per-project store
		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir);
		projectRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "anthropic/claude-opus-4",
			thinkingLevel: "high",
			createdAt: 0,
			updatedAt: 0,
		});

		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};

		// Mock ProjectContextManager — only needs getOrCreate(projectId) to return a ctx with roleStore.
		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { roleStore: projectRoleStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);

		// No project: server wins over builtin
		const sysRoles = cascade.resolveRoles();
		const sysCoder = sysRoles.find(r => r.item.name === "coder");
		assert.ok(sysCoder);
		assert.equal(sysCoder!.origin, "server");
		assert.equal(sysCoder!.item.model, "anthropic/claude-sonnet");
		assert.equal(sysCoder!.item.thinkingLevel, "medium");

		// With project: project wins over server
		const projRoles = cascade.resolveRoles("proj1");
		const projCoder = projRoles.find(r => r.item.name === "coder");
		assert.ok(projCoder);
		assert.equal(projCoder!.origin, "project");
		assert.equal(projCoder!.item.model, "anthropic/claude-opus-4");
		assert.equal(projCoder!.item.thinkingLevel, "high");
	});

	it("resolveRoleModelResolution reports source hierarchy + editability per field", () => {
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", {
			model: "anthropic/claude-haiku",
			thinkingLevel: "low",
		});
		// Role with no field overrides anywhere → both fall back to default.
		writeRoleYaml(builtinsDir, "plain", {});
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		// Server overrides only the model for coder; thinkingLevel still inherited.
		serverRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "anthropic/claude-sonnet",
			createdAt: 0,
			updatedAt: 0,
		});

		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir);
		// Project overrides only thinkingLevel (thinking-only override); model
		// stays inherited from the server layer.
		projectRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			thinkingLevel: "high",
			createdAt: 0,
			updatedAt: 0,
		});

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { roleStore: projectRoleStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);

		// System scope (no project): server is the editable layer.
		const sys = cascade.resolveRoleModelResolution("coder");
		assert.equal(sys.model.source, "role");
		assert.equal(sys.model.origin, "server");
		assert.equal(sys.model.value, "anthropic/claude-sonnet");
		assert.equal(sys.model.editable, true);
		assert.equal(sys.model.sourceLabel, "Server");
		// thinkingLevel only exists in builtin → inherited at system scope.
		assert.equal(sys.thinkingLevel.source, "inherited-role");
		assert.equal(sys.thinkingLevel.origin, "builtin");
		assert.equal(sys.thinkingLevel.value, "low");

		// Project scope: project is the editable layer.
		const proj = cascade.resolveRoleModelResolution("coder", "proj1");
		// model not overridden in project → inherited from server.
		assert.equal(proj.model.source, "inherited-role");
		assert.equal(proj.model.origin, "server");
		assert.equal(proj.model.value, "anthropic/claude-sonnet");
		assert.equal(proj.model.editable, true);
		// thinking-only override at the project layer.
		assert.equal(proj.thinkingLevel.source, "role");
		assert.equal(proj.thinkingLevel.origin, "project");
		assert.equal(proj.thinkingLevel.value, "high");
		assert.equal(proj.thinkingLevel.sourceLabel, "Project");

		// Role with no field anywhere → default fallback (no value).
		const plain = cascade.resolveRoleModelResolution("plain", "proj1");
		assert.equal(plain.model.source, "default");
		assert.equal(plain.model.value, undefined);
		assert.equal(plain.model.editable, true);
		assert.equal(plain.thinkingLevel.source, "default");
		assert.equal(plain.thinkingLevel.value, undefined);
	});

	it("metadata reports the winning higher-precedence role (global-user) over a shadowed server field (finding #4)", () => {
		// Builtin + server both define `coder` with a model; a global-user user-pack
		// role also defines `coder` with a DIFFERENT model. The global-user band sits
		// ABOVE server in PackResolver precedence, so it is the whole-role winner and
		// its field must be reported — NOT the lower-precedence server model.
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", { model: "anthropic/claude-haiku", thinkingLevel: "low" });
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put({
			name: "coder", label: "Coder", promptTemplate: "p", accessory: "none",
			model: "anthropic/claude-sonnet", thinkingLevel: "medium",
			createdAt: 0, updatedAt: 0,
		});

		// Global-user user pack lives under <home>/.bobbit/config/roles/<name>.yaml.
		const homeDir = mkTemp();
		writeRoleYaml(path.join(homeDir, ".bobbit", "config"), "coder", { model: "anthropic/claude-opus-4" });

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = { getOrCreate: () => undefined } as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);
		cascade.setGlobalUserBase(homeDir);

		// Sanity: the whole-role winner is the global-user pack, shadowing server/builtin.
		const winner = cascade.resolveRoles().find(r => r.item.name === "coder");
		assert.ok(winner);
		assert.equal(winner!.origin, "user");
		assert.equal(winner!.item.model, "anthropic/claude-opus-4");

		// Metadata must follow that precedence for the model field: the global-user
		// value wins; it is above the (system-scope) editable server layer, so it is
		// reported as an inherited-role override, not the shadowed server model.
		const meta = cascade.resolveRoleModelResolution("coder");
		assert.equal(meta.model.source, "inherited-role");
		assert.equal(meta.model.origin, "user");
		assert.equal(meta.model.value, "anthropic/claude-opus-4");
		// The global-user winner sits ABOVE the system-scope editable server layer.
		// `PUT /api/roles/:name` writes the server layer, which cannot override that
		// higher-precedence value, so the model field must be reported read-only —
		// presenting it as editable would make the inline control a no-op (finding #3).
		assert.equal(meta.model.editable, false);

		// The global-user role omits thinkingLevel, so the field falls through the
		// lower layers: server supplies it as the system-scope editable layer, so it
		// IS a directly-editable role override (the write target owns it).
		assert.equal(meta.thinkingLevel.source, "role");
		assert.equal(meta.thinkingLevel.origin, "server");
		assert.equal(meta.thinkingLevel.value, "medium");
		assert.equal(meta.thinkingLevel.editable, true);
	});

	it("marks an above-current-scope winner (global-user at system scope) read-only, but a below-scope winner (builtin) editable (finding #3)", () => {
		// `coder` is defined at builtin (model haiku) and global-user (model opus).
		// At SYSTEM scope the editable write target is the server layer (rank 2).
		//  - global-user (rank 4) > server: a server-layer PUT cannot override it →
		//    model must be read-only (editable:false), else the inline control no-ops.
		//  - builtin    (rank 0) < server: a server-layer PUT DOES shadow it, so a
		//    builtin-sourced field stays editable (customize-then-edit is valid).
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", { model: "anthropic/claude-haiku", thinkingLevel: "low" });
		// `solo` is defined ONLY at builtin (no higher layer shadows it).
		writeRoleYaml(builtinsDir, "solo", { model: "anthropic/claude-haiku" });
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const homeDir = mkTemp();
		writeRoleYaml(path.join(homeDir, ".bobbit", "config"), "coder", { model: "anthropic/claude-opus-4" });

		const serverStores = {
			getRoles: () => [], // server defines neither role
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = { getOrCreate: () => undefined } as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);
		cascade.setGlobalUserBase(homeDir);

		// global-user winner above the server write target → read-only model field.
		const coder = cascade.resolveRoleModelResolution("coder");
		assert.equal(coder.model.source, "inherited-role");
		assert.equal(coder.model.origin, "user");
		assert.equal(coder.model.value, "anthropic/claude-opus-4");
		assert.equal(coder.model.editable, false);

		// builtin winner below the server write target → still editable.
		const solo = cascade.resolveRoleModelResolution("solo");
		assert.equal(solo.model.source, "inherited-role");
		assert.equal(solo.model.origin, "builtin");
		assert.equal(solo.model.value, "anthropic/claude-haiku");
		assert.equal(solo.model.editable, true);
	});

	it("metadata reports a server-market winner over a shadowed builtin field at system scope (finding #1)", () => {
		// builtin defines `coder` with a model + thinkingLevel; the server store has
		// NO coder, so a server-market pack role is the whole-role winner. The
		// server-market band (rank 1) sits BELOW the system-scope editable server
		// band (rank 2) but ABOVE builtin (rank 0). The previous guard only trusted
		// the winner when winnerRank >= editableRank, so it fell through and reported
		// the lower builtin model. The winner's model must be reported instead.
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", { model: "anthropic/claude-haiku", thinkingLevel: "low" });
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverStores = {
			getRoles: () => [], // server store does NOT define coder
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = { getOrCreate: () => undefined } as any;

		const marketRole = {
			name: "coder", label: "Coder", promptTemplate: "p", accessory: "none",
			model: "anthropic/claude-opus-4", createdAt: 0, updatedAt: 0,
		};
		const marketProvider = {
			marketEntries: (scope: string) => scope === "server"
				? [{
					id: "market:server:mk", kind: "market", scope: "server", path: "/virtual/mk",
					readOnly: true, layout: "defaults-tree",
					manifest: { name: "mk", description: "", version: "1", contents: { roles: ["coder"], tools: [], skills: [], entrypoints: [] } },
					preloaded: { roles: [{ name: "coder", item: marketRole }] },
				}]
				: [],
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm, undefined, marketProvider);

		// Sanity: the server-market pack is the whole-role winner.
		const winner = cascade.resolveRoles().find(r => r.item.name === "coder");
		assert.ok(winner);
		assert.equal(winner!.origin, "server");
		assert.equal(winner!.originPackName, "mk");
		assert.equal(winner!.item.model, "anthropic/claude-opus-4");

		const meta = cascade.resolveRoleModelResolution("coder");
		// Model: the winning server-market value, NOT the shadowed builtin haiku.
		assert.equal(meta.model.source, "inherited-role");
		assert.equal(meta.model.origin, "server");
		assert.equal(meta.model.value, "anthropic/claude-opus-4");
		assert.equal(meta.model.originPackName, "mk");
		assert.equal(meta.model.sourceLabel, "mk");
		// Pack-managed → read-only inline.
		assert.equal(meta.model.editable, false);
		// thinkingLevel: market role omits it → falls through to the builtin field.
		assert.equal(meta.thinkingLevel.source, "inherited-role");
		assert.equal(meta.thinkingLevel.origin, "builtin");
		assert.equal(meta.thinkingLevel.value, "low");
		assert.equal(meta.thinkingLevel.editable, false);
	});

	it("metadata reports a global-user winner over a shadowed server field at PROJECT scope (finding #1)", () => {
		// builtin + server both define `coder` model; a global-user user-pack role
		// also defines a DIFFERENT model. At PROJECT scope the project layer has no
		// coder override, so the global-user role (rank 4) is the whole-role winner —
		// BELOW the project editable band (rank 6) but ABOVE the server band (rank 2).
		// The previous guard fell through and reported the shadowed server model; the
		// global-user model must be reported instead, and it stays editable (user
		// pack, not a market pack).
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", { model: "anthropic/claude-haiku", thinkingLevel: "low" });
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put({
			name: "coder", label: "Coder", promptTemplate: "p", accessory: "none",
			model: "anthropic/claude-sonnet", thinkingLevel: "medium",
			createdAt: 0, updatedAt: 0,
		});

		const homeDir = mkTemp();
		writeRoleYaml(path.join(homeDir, ".bobbit", "config"), "coder", { model: "anthropic/claude-opus-4" });

		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir); // empty: no coder override

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { roleStore: projectRoleStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);
		cascade.setGlobalUserBase(homeDir);

		// Sanity: at project scope the global-user role is the winner.
		const winner = cascade.resolveRoles("proj1").find(r => r.item.name === "coder");
		assert.ok(winner);
		assert.equal(winner!.origin, "user");
		assert.equal(winner!.item.model, "anthropic/claude-opus-4");

		const meta = cascade.resolveRoleModelResolution("coder", "proj1");
		// Model: the winning global-user value, NOT the shadowed server sonnet.
		assert.equal(meta.model.source, "inherited-role");
		assert.equal(meta.model.origin, "user");
		assert.equal(meta.model.value, "anthropic/claude-opus-4");
		assert.equal(meta.model.editable, true);
		// thinkingLevel: global-user role omits it → server supplies the value.
		assert.equal(meta.thinkingLevel.source, "inherited-role");
		assert.equal(meta.thinkingLevel.origin, "server");
		assert.equal(meta.thinkingLevel.value, "medium");
		assert.equal(meta.thinkingLevel.editable, true);
	});

	it("metadata reports a project-scoped winner over a shadowed server field as an editable role override (finding #1)", () => {
		// The project layer defines `coder` model; server defines a different model.
		// At project scope the project role is the winner AND the editable layer, so
		// the field reads as a direct `role` override (editable), never the shadowed
		// server value.
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", { model: "anthropic/claude-haiku", thinkingLevel: "low" });
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put({
			name: "coder", label: "Coder", promptTemplate: "p", accessory: "none",
			model: "anthropic/claude-sonnet", thinkingLevel: "medium",
			createdAt: 0, updatedAt: 0,
		});

		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir);
		projectRoleStore.put({
			name: "coder", label: "Coder", promptTemplate: "p", accessory: "none",
			model: "anthropic/claude-opus-4",
			createdAt: 0, updatedAt: 0,
		});

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { roleStore: projectRoleStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);

		const meta = cascade.resolveRoleModelResolution("coder", "proj1");
		// Model: project override wins, reported as an editable role override.
		assert.equal(meta.model.source, "role");
		assert.equal(meta.model.origin, "project");
		assert.equal(meta.model.value, "anthropic/claude-opus-4");
		assert.equal(meta.model.editable, true);
		assert.equal(meta.model.sourceLabel, "Project");
		// thinkingLevel: project role omits it → falls through to the server field.
		assert.equal(meta.thinkingLevel.source, "inherited-role");
		assert.equal(meta.thinkingLevel.origin, "server");
		assert.equal(meta.thinkingLevel.value, "medium");
	});

	it("falls through to builtin when neither server nor project define the role", () => {
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "tester", {
			model: "anthropic/claude-haiku",
			thinkingLevel: "off",
		});
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverStores = {
			getRoles: () => [],
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = { getOrCreate: () => undefined } as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);
		const roles = cascade.resolveRoles();
		const tester = roles.find(r => r.item.name === "tester");
		assert.ok(tester);
		assert.equal(tester!.origin, "builtin");
		assert.equal(tester!.item.model, "anthropic/claude-haiku");
		assert.equal(tester!.item.thinkingLevel, "off");
	});
});

describe("ConfigCascade — Headquarters server-scope alias", () => {
	it("normalizes Headquarters to server scope for non-workflow config only", () => {
		assert.equal(normalizeConfigProjectId(HEADQUARTERS_PROJECT_ID), undefined);
		assert.equal(normalizeConfigProjectId("proj1"), "proj1");

		const builtins = new BuiltinConfigProvider(mkTemp());
		const serverRole = {
			name: "coder",
			label: "Coder",
			promptTemplate: "server prompt",
			accessory: "none",
			model: "server/model",
			thinkingLevel: "medium",
			createdAt: 0,
			updatedAt: 0,
		};
		const projectRole = {
			...serverRole,
			promptTemplate: "project prompt",
			model: "project/model",
			thinkingLevel: "high",
		};
		const serverTool = { name: "shared_tool", description: "server" };
		const projectTool = { name: "shared_tool", description: "project" };
		const serverPolicy = { default: "allow" };
		const projectPolicy = { default: "deny" };
		const hqWorkflow = { id: "hq-flow", name: "HQ Flow", gates: [] };
		const calls: string[] = [];
		const fakePcm = {
			getOrCreate: (id: string) => {
				calls.push(id);
				if (id !== HEADQUARTERS_PROJECT_ID) return undefined;
				return {
					roleStore: {
						getAllLocal: () => [projectRole],
						getLocal: (name: string) => name === "coder" ? projectRole : undefined,
					},
					toolManager: { getLocalTools: () => [projectTool] },
					toolGroupPolicyStore: { getAll: () => ({ Shell: projectPolicy }) },
					workflowStore: { getAllLocal: () => [hqWorkflow] },
				};
			},
		} as any;
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [serverRole],
			getTools: () => [serverTool as any],
			getToolGroupPolicies: () => ({ Shell: serverPolicy as any }),
		}, fakePcm);

		const roles = cascade.resolveRoles(HEADQUARTERS_PROJECT_ID);
		assert.equal(roles.find(r => r.item.name === "coder")?.origin, "server");
		assert.equal(roles.find(r => r.item.name === "coder")?.item.promptTemplate, "server prompt");
		assert.equal(cascade.resolveRoleModel("coder", HEADQUARTERS_PROJECT_ID), "server/model");
		assert.equal(cascade.resolveRoleThinkingLevel("coder", HEADQUARTERS_PROJECT_ID), "medium");
		assert.equal(cascade.resolveRolePromptTemplate("coder", HEADQUARTERS_PROJECT_ID), "server prompt");
		assert.equal(cascade.resolveTools(HEADQUARTERS_PROJECT_ID).find(t => t.item.name === "shared_tool")?.origin, "server");
		assert.equal(cascade.resolveToolGroupPolicies(HEADQUARTERS_PROJECT_ID).Shell.origin, "server");
		assert.deepEqual(calls, [], "non-workflow Headquarters config must not load the project context");

		const workflows = cascade.resolveWorkflows(HEADQUARTERS_PROJECT_ID);
		assert.deepEqual(workflows.map(w => [w.item.id, w.origin]), [["hq-flow", "project"]]);
		assert.deepEqual(calls, [HEADQUARTERS_PROJECT_ID], "workflow resolution remains project-scoped for Headquarters");
	});

	it("normalizes Headquarters before market-pack and activation lookups", () => {
		const builtins = new BuiltinConfigProvider(mkTemp());
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		}, { getOrCreate: () => undefined } as any, undefined, undefined, mkTemp(), mkTemp());
		const marketCalls: Array<[string, string | undefined]> = [];
		const activationCalls: Array<[string, string | undefined, string]> = [];
		cascade.setMarketPackProvider({
			marketEntries(scope, projectId) {
				marketCalls.push([scope, projectId]);
				if (scope !== "server") return [];
				return [{
					id: "market:server:sample",
					kind: "market",
					scope: "server",
					path: mkTemp(),
					readOnly: true,
					layout: "defaults-tree",
					manifest: {
						name: "sample",
						description: "sample",
						version: "1.0.0",
						contents: { roles: [], tools: ["market_tool"], skills: [], entrypoints: [] },
					},
					preloaded: { tools: [{ name: "market_tool", item: { name: "market_tool", description: "market" } }] },
				} as any];
			},
		});
		cascade.setPackActivationProvider({
			disabled(scope, projectId, packName) {
				activationCalls.push([scope, projectId, packName]);
				return {};
			},
		});

		assert.equal(cascade.resolveTools(HEADQUARTERS_PROJECT_ID).find(t => t.item.name === "market_tool")?.origin, "server");
		assert.deepEqual(marketCalls, [["server", undefined], ["global-user", undefined]]);
		assert.deepEqual(activationCalls, [["server", undefined, "sample"]]);
	});
});

// ---------------------------------------------------------------------------
// S8 seam, V0 — ConfigCascade.resolveVerificationPolicy (see
// docs/design/verification-policy-seam.md §2/§4). Deliberately NOT routed
// through PackResolver — same three-layer (builtin -> server -> project)
// manual merge shape as resolveToolGroupPolicies, but per-field (not a
// name-keyed map) via mergeVerificationPolicyRaw + a single final
// resolveVerificationPolicy validation pass.
// ---------------------------------------------------------------------------
describe("ConfigCascade — resolveVerificationPolicy", () => {
	it("with no builtin file, no server override, no project override: resolves to DEFAULT_VERIFICATION_POLICY", async () => {
		const { DEFAULT_VERIFICATION_POLICY } = await import("../src/server/agent/verification-logic.ts");
		const builtins = new BuiltinConfigProvider(mkTemp());
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		}, { getOrCreate: () => undefined } as any);

		assert.deepEqual(cascade.resolveVerificationPolicy(), DEFAULT_VERIFICATION_POLICY);
		assert.deepEqual(cascade.resolveVerificationPolicy("proj1"), DEFAULT_VERIFICATION_POLICY);
	});

	it("project overrides server overrides builtin, per field — matching the tool-group-policies precedence", async () => {
		const { VerificationPolicyStore } = await import("../src/server/agent/verification-policy-store.ts");

		const builtinsDir = mkTemp();
		fs.writeFileSync(path.join(builtinsDir, "verification-policy.yaml"), [
			"gateCacheDefault: sha",
			"parallelReviewsDefault: true",
			"gateRoles:",
			"  ready-to-merge:",
			"    childRewrite: adapt-ready-to-merge",
		].join("\n"));
		const builtins = new BuiltinConfigProvider(builtinsDir);

		// Server layer: mirrors how server.ts wires a top-level VerificationPolicyStore
		// with setBuiltinRaw + an on-disk override.
		const serverConfigDir = mkTemp();
		const serverStore = new VerificationPolicyStore(serverConfigDir);
		serverStore.setBuiltinRaw(builtins.getVerificationPolicyRaw());
		fs.writeFileSync(path.join(serverConfigDir, "verification-policy.yaml"), "parallelReviewsDefault: false\n");

		// Project layer: per-project instance, never receives setBuiltinRaw
		// (ConfigCascade supplies the true builtin layer separately) — matches
		// ToolGroupPolicyStore's existing pattern.
		const projectConfigDir = mkTemp();
		const projectStore = new VerificationPolicyStore(projectConfigDir);
		fs.writeFileSync(path.join(projectConfigDir, "verification-policy.yaml"), [
			"gateCacheDefault: content",
			"gateRoles:",
			"  my-custom-gate:",
			"    childRewrite: none",
		].join("\n"));

		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { verificationPolicyStore: projectStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
			getVerificationPolicyRaw: () => serverStore.getMergedRaw(),
		}, fakePcm);

		// System scope (no project): builtin + server layers only.
		const systemPolicy = cascade.resolveVerificationPolicy();
		assert.equal(systemPolicy.gateCacheDefault, "sha", "builtin value survives when no override sets it");
		assert.equal(systemPolicy.parallelReviewsDefault, false, "server override wins over builtin");
		assert.deepEqual(systemPolicy.gateRoles, { "ready-to-merge": { childRewrite: "adapt-ready-to-merge" } });

		// Project scope: project overrides server overrides builtin.
		const projectPolicy = cascade.resolveVerificationPolicy("proj1");
		assert.equal(projectPolicy.gateCacheDefault, "content", "project override wins over builtin");
		assert.equal(projectPolicy.parallelReviewsDefault, false, "server override still applies when the project doesn't touch this field");
		assert.deepEqual(projectPolicy.gateRoles, {
			"ready-to-merge": { childRewrite: "adapt-ready-to-merge" },
			"my-custom-gate": { childRewrite: "none" },
		}, "gateRoles merged by key across all three layers, not replaced wholesale");
	});

	it("Headquarters normalizes to system scope — the project layer is never consulted", () => {
		const builtins = new BuiltinConfigProvider(mkTemp());
		const calls: string[] = [];
		const fakePcm = {
			getOrCreate: (id: string) => { calls.push(id); return undefined; },
		} as any;
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		}, fakePcm);

		cascade.resolveVerificationPolicy(HEADQUARTERS_PROJECT_ID);
		assert.deepEqual(calls, [], "Headquarters must not trigger a project-context lookup for non-workflow config");
	});

	it("a ServerStores fake that doesn't implement getVerificationPolicyRaw (existing test doubles) degrades to builtin-only", async () => {
		const { DEFAULT_VERIFICATION_POLICY } = await import("../src/server/agent/verification-logic.ts");
		const builtins = new BuiltinConfigProvider(mkTemp());
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
			// getVerificationPolicyRaw intentionally omitted.
		}, { getOrCreate: () => undefined } as any);

		assert.deepEqual(cascade.resolveVerificationPolicy(), DEFAULT_VERIFICATION_POLICY);
	});
});
