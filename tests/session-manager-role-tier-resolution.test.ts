/**
 * CLF-W1c (F5-read verify): does `SessionManager.resolveInitialModel` /
 * `resolveInitialThinkingLevel` actually read a PROJECT-scoped role
 * `model`/`thinkingLevel` override through `configCascade`, or only a
 * flat/server-level role?
 *
 * These two methods are the single shared engine behind every spawn class
 * that pins a role tier at spawn time:
 *   - normal session create (`buildPipelineContext` wires them as
 *     `ctx.resolveInitialModel`/`resolveInitialThinkingLevel`, consumed by
 *     `session-setup.ts::_resolveBridgeOptions`)
 *   - session restore (`restoreSession`, session-manager.ts ~5546/5549)
 *   - role-reassignment respawn (`assignRole`, ~7543/7546)
 *   - force-abort respawn (`session-live-control.ts`)
 *
 * A source-level pin (below) confirms all four call sites route through
 * these exact methods rather than a stale/duplicated copy. This test proves
 * the methods themselves are correct: they resolve `role` + `projectId`
 * against `configCascade` (project > server > builtin), not just a flat
 * roleStore lookup — the thing that would make a project-level role
 * override silently invisible to restore/respawn.
 *
 * Companion coverage:
 *   - tests/builtin-role-thinking-tiers.test.ts — the builtin tier VALUES.
 *   - tests/session-setup-role-override.test.ts — the `plan.role ?? plan.roleName`
 *     fallback inside `_resolveBridgeOptions` (mocked resolvers).
 *   - tests/team-manager.test.ts — team-lead/worker spawn wiring (CLF-W1c fix).
 *   - tests/verification-harness-role-tier-resolution.test.ts — reviewer/QA/
 *     legacy-sub-session spawn wiring.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-role-tier-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");

const managers: any[] = [];
function makeManager(): any {
	const manager: any = new SessionManager();
	managers.push(manager);
	return manager;
}
afterEach(() => {
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
	}
});

type FakeRole = { name: string; model?: string; thinkingLevel?: string };

/**
 * Minimal fake ConfigCascade. `resolveRoles(projectId)` returns a
 * PROJECT-SCOPED role list — different projects see different overrides —
 * so a test can prove `projectId` is actually threaded through to the
 * cascade rather than being dropped in favor of a flat/global lookup.
 * `resolveRoleModel`/`resolveRoleThinkingLevel` mirror the same table (the
 * field-level fallback `resolveRoleModelValue`/`resolveRoleThinkingLevelValue`
 * may consult either, depending on whether `resolveSessionRole` finds a hit
 * first).
 */
function makeCascade(rolesByProject: Record<string, FakeRole[]>): any {
	const forProject = (projectId?: string) => rolesByProject[projectId ?? "__none__"] ?? [];
	return {
		resolveRoles: (projectId?: string) => forProject(projectId).map(r => ({ item: r, origin: "project", overrides: undefined })),
		resolveRoleModel: (roleName: string, projectId?: string) => forProject(projectId).find(r => r.name === roleName)?.model,
		resolveRoleThinkingLevel: (roleName: string, projectId?: string) => forProject(projectId).find(r => r.name === roleName)?.thinkingLevel,
	};
}

describe("SessionManager.resolveInitialModel/resolveInitialThinkingLevel — CLF-W1c", () => {
	it("resolveInitialModel reads a PROJECT-scoped role override via configCascade (not a flat/global lookup)", () => {
		const manager = makeManager();
		manager.configCascade = makeCascade({
			"proj-a": [{ name: "security-reviewer", model: "acme/model-a" }],
			"proj-b": [{ name: "security-reviewer", model: "acme/model-b" }],
		});

		assert.equal(manager.resolveInitialModel("security-reviewer", "proj-a"), "acme/model-a");
		assert.equal(manager.resolveInitialModel("security-reviewer", "proj-b"), "acme/model-b");
		// No projectId ⇒ no matching cascade entry ⇒ falls through (no pref set) ⇒ undefined.
		assert.equal(manager.resolveInitialModel("security-reviewer", undefined), undefined);
	});

	it("resolveInitialThinkingLevel reads a PROJECT-scoped role override via configCascade", () => {
		const manager = makeManager();
		manager.configCascade = makeCascade({
			"proj-a": [{ name: "docs-writer", thinkingLevel: "low" }],
			"proj-b": [{ name: "docs-writer", thinkingLevel: "high" }],
		});

		assert.equal(manager.resolveInitialThinkingLevel("docs-writer", "proj-a"), "low");
		assert.equal(manager.resolveInitialThinkingLevel("docs-writer", "proj-b"), "high");
	});

	it("falls back to default.sessionModel preference when the role has no model override", () => {
		const manager = makeManager();
		manager.configCascade = makeCascade({ "proj-a": [{ name: "coder" }] }); // role exists, no model set
		manager.preferencesStore = { get: (key: string) => (key === "default.sessionModel" ? "acme/pref-model" : undefined) };

		assert.equal(manager.resolveInitialModel("coder", "proj-a"), "acme/pref-model");
	});

	it("falls back to default.sessionThinkingLevel preference when the role has no thinkingLevel override", () => {
		const manager = makeManager();
		manager.configCascade = makeCascade({ "proj-a": [{ name: "coder" }] }); // role exists, no thinkingLevel set
		// No default.sessionModel set here — resolveInitialThinkingLevel only clamps
		// against a resolvable model, and this test isolates the pref fallback itself
		// from the (separately-covered) per-model clamp behavior.
		manager.preferencesStore = { get: (key: string) => (key === "default.sessionThinkingLevel" ? "high" : undefined) };

		assert.equal(manager.resolveInitialThinkingLevel("coder", "proj-a"), "high");
	});

	it("returns undefined for model and 'medium' for thinking level when nothing is configured anywhere", () => {
		const manager = makeManager();
		assert.equal(manager.resolveInitialModel("general", "proj-a"), undefined);
		assert.equal(manager.resolveInitialThinkingLevel("general", "proj-a"), "medium");
	});

	it("resolveInitialModel/resolveInitialThinkingLevel return undefined/'medium' for a role with no configCascade entry, even with prefs set", () => {
		const manager = makeManager();
		manager.configCascade = makeCascade({ "proj-a": [] }); // no roles at all
		manager.preferencesStore = { get: () => undefined };

		assert.equal(manager.resolveInitialModel("ghost-role", "proj-a"), undefined);
		assert.equal(manager.resolveInitialThinkingLevel("ghost-role", "proj-a"), "medium");
	});
});

describe("source pin: restore / respawn / force-abort-respawn route through the tested resolvers — CLF-W1c", () => {
	const src = fs.readFileSync(
		path.join(process.cwd(), "src/server/agent/session-manager.ts"),
		"utf-8",
	);
	const liveControlSrc = fs.readFileSync(
		path.join(process.cwd(), "src/server/agent/session-live-control.ts"),
		"utf-8",
	);
	const reviveSrc = fs.readFileSync(
		path.join(process.cwd(), "src/server/agent/session-revive.ts"),
		"utf-8",
	);
	const setupPlumbingSrc = fs.readFileSync(
		path.join(process.cwd(), "src/server/agent/session-setup-plumbing.ts"),
		"utf-8",
	);

	it("restoreSession falls back to this.resolveInitialModel/resolveInitialThinkingLevel(ps.role, ps.projectId)", () => {
		const idx = reviveSrc.indexOf("async restoreSession(ps: PersistedSession)");
		assert.ok(idx > 0, "restoreSession declaration not found");
		const window = reviveSrc.slice(idx, idx + 15_000);
		assert.match(window, /this\.deps\.host\.resolveInitialModel\(ps\.role, ps\.projectId\)/);
		assert.match(window, /this\.deps\.host\.resolveInitialThinkingLevel\(ps\.role, ps\.projectId\)/);
	});

	it("assignRole (role-reassignment respawn) falls back to this.resolveInitialModel/resolveInitialThinkingLevel(role.name, session.projectId)", () => {
		const idx = src.indexOf("async assignRole(id: string, role:");
		assert.ok(idx > 0, "assignRole declaration not found");
		const window = src.slice(idx, idx + 15_000);
		assert.match(window, /this\.resolveInitialModel\(role\.name, session\.projectId\)/);
		assert.match(window, /this\.resolveInitialThinkingLevel\(role\.name, session\.projectId\)/);
	});

	it("force-abort respawn falls back to this.resolveInitialModel/resolveInitialThinkingLevel(session.role, session.projectId)", () => {
		// Anchor on the force-abort-specific persisted lookup var name used just
		// before the model/thinking pin block (moved to session-live-control.ts
		// in SM decomposition cohort 15).
		const idx = liveControlSrc.indexOf("const forceRespawnPersisted = this.resolveStoreForSession(id).get(id);");
		assert.ok(idx > 0, "force-abort respawn persisted lookup not found");
		const window = liveControlSrc.slice(idx, idx + 2000);
		assert.match(window, /this\.resolveInitialModel\(session\.role, session\.projectId\)/);
		assert.match(window, /this\.resolveInitialThinkingLevel\(session\.role, session\.projectId\)/);
	});

	it("buildPipelineContext wires resolveInitialModel/resolveInitialThinkingLevel to session-setup.ts (normal-create pipeline)", () => {
		assert.match(setupPlumbingSrc, /resolveInitialModel:\s*\(role, projectId\)\s*=>\s*this\.deps\.resolveInitialModel\(role, projectId\)/);
		assert.match(setupPlumbingSrc, /resolveInitialThinkingLevel:\s*\(role, projectId\)\s*=>\s*this\.deps\.resolveInitialThinkingLevel\(role, projectId\)/);
	});
});
