/**
 * Regression: PUT /api/roles/:name?projectId=X must succeed for builtin
 * roles that have not yet been overridden at project scope.
 *
 * Before the fix, the PUT handler called `ctx.roleStore.get(name)` directly.
 * `ctx.roleStore` is created fresh per project and `setBuiltins()` is never
 * applied to it, so builtin roles (`coder`, `architect`, etc.) returned
 * `undefined` and the handler responded 404 "Role not found in project".
 *
 * The fix resolves through `configCascade.resolveRoles(projectId)` first and
 * falls back to the cascade item when the project store has no entry. The
 * subsequent `ctx.roleStore.put(updated)` promotes the role to project scope
 * on first edit (promote-on-first-edit semantics).
 *
 * These tests pin that contract by replaying the handler's resolution logic
 * against a real RoleStore backed by a temp dir, with a stubbed cascade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { RoleStore } = await import("../src/server/agent/role-store.ts");
type RoleStoreT = InstanceType<typeof RoleStore>;
type Role = ReturnType<RoleStoreT["get"]> extends infer R | undefined ? NonNullable<R> : never;

function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-api-roles-update-"));
}

/**
 * Stubbed cascade that returns a fixed set of resolved roles. Mirrors the
 * shape of `ConfigCascade.resolveRoles()` used at the call site in server.ts.
 */
function makeCascade(roles: Role[]) {
	return {
		resolveRoles(_projectId?: string) {
			return roles.map(item => ({ item, origin: "builtin" as const }));
		},
	};
}

/**
 * Replays the PUT handler's resolution + update logic from
 * `src/server/server.ts` (~line 4554, the `qProjectId` branch). Returns
 * the HTTP status code and any persisted record so tests can assert end
 * state.
 *
 * Keep this in sync with the handler body — the handler is intentionally
 * compact and re-implementing the logic here is cheaper than threading a
 * full gateway up just to PUT a role.
 */
function runHandler(opts: {
	roleStore: RoleStoreT;
	cascade: ReturnType<typeof makeCascade>;
	name: string;
	body: Record<string, unknown>;
	now?: number;
}): { status: number } {
	const { roleStore, cascade, name, body, now = Date.now() } = opts;

	const resolvedInCascade = cascade.resolveRoles("test-project").find(r => r.item.name === name);
	if (!resolvedInCascade) return { status: 404 };
	const existing = roleStore.get(name) ?? resolvedInCascade.item;

	const validPolicies = new Set(["allow", "ask", "never", "always-allow", "ask-once", "always-ask", "never-ask"]);
	let toolPolicies = existing.toolPolicies;
	if (body.toolPolicies !== undefined) {
		const cleaned: Record<string, "allow" | "ask" | "never"> = {};
		if (body.toolPolicies && typeof body.toolPolicies === "object") {
			for (const [k, v] of Object.entries(body.toolPolicies as Record<string, unknown>)) {
				if (typeof v === "string" && validPolicies.has(v)) cleaned[k] = v as "allow" | "ask" | "never";
			}
		}
		toolPolicies = cleaned;
	}
	let model = existing.model;
	if (body.model !== undefined) {
		model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
	}
	let thinkingLevel = existing.thinkingLevel;
	if (body.thinkingLevel !== undefined) {
		thinkingLevel = typeof body.thinkingLevel === "string" && body.thinkingLevel.trim() ? body.thinkingLevel.trim() : undefined;
	}
	const updated: Role = {
		...existing,
		label: (body.label as string) ?? existing.label,
		promptTemplate: (body.promptTemplate as string) ?? existing.promptTemplate,
		accessory: (body.accessory as string) ?? existing.accessory,
		toolPolicies,
		model,
		thinkingLevel,
		name,
		updatedAt: now,
	};
	roleStore.put(updated);
	return { status: 200 };
}

function builtinCoder(): Role {
	return {
		name: "coder",
		label: "Coder",
		promptTemplate: "You are a coder.",
		accessory: "bandana",
		model: "anthropic/claude-sonnet-4-5",
		thinkingLevel: "medium",
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("PUT /api/roles/:name?projectId=X — builtin promotion", () => {
	it("promotes a builtin role to project scope on first PUT (200, YAML on disk)", () => {
		const dir = mkTempDir();
		const roleStore = new RoleStore(dir);
		const cascade = makeCascade([builtinCoder()]);

		// Pre-condition: builtin role is NOT in the project store yet.
		assert.equal(roleStore.get("coder"), undefined);

		const res = runHandler({
			roleStore,
			cascade,
			name: "coder",
			body: { model: "anthropic/claude-opus-4" },
			now: 12345,
		});

		assert.equal(res.status, 200);

		// Project-level YAML now exists on disk.
		const yamlPath = path.join(dir, "roles", "coder.yaml");
		assert.ok(fs.existsSync(yamlPath), `expected project-level role file at ${yamlPath}`);
		const raw = fs.readFileSync(yamlPath, "utf-8");
		assert.match(raw, /model:\s*anthropic\/claude-opus-4/);

		// And the store reports the promoted record with the new field plus
		// the builtin's preserved fields (label, promptTemplate, accessory).
		const promoted = roleStore.get("coder");
		assert.ok(promoted);
		assert.equal(promoted!.model, "anthropic/claude-opus-4");
		assert.equal(promoted!.label, "Coder");
		assert.equal(promoted!.promptTemplate, "You are a coder.");
		assert.equal(promoted!.accessory, "bandana");
		assert.equal(promoted!.updatedAt, 12345);
	});

	it("subsequent PUTs update the project-scoped record in place", () => {
		const dir = mkTempDir();
		const roleStore = new RoleStore(dir);
		const cascade = makeCascade([builtinCoder()]);

		// First PUT promotes.
		runHandler({
			roleStore,
			cascade,
			name: "coder",
			body: { model: "anthropic/claude-opus-4" },
			now: 1000,
		});

		// Second PUT updates the existing project-scope record.
		const res = runHandler({
			roleStore,
			cascade,
			name: "coder",
			body: { thinkingLevel: "high" },
			now: 2000,
		});

		assert.equal(res.status, 200);
		const updated = roleStore.get("coder");
		assert.ok(updated);
		// Both the first edit (model) and the second (thinkingLevel) persist.
		assert.equal(updated!.model, "anthropic/claude-opus-4");
		assert.equal(updated!.thinkingLevel, "high");
		assert.equal(updated!.updatedAt, 2000);
	});

	it("returns 404 when the role does not exist in the cascade", () => {
		const dir = mkTempDir();
		const roleStore = new RoleStore(dir);
		const cascade = makeCascade([builtinCoder()]); // only "coder" is known

		const res = runHandler({
			roleStore,
			cascade,
			name: "does-not-exist",
			body: { model: "anthropic/claude-opus-4" },
		});

		assert.equal(res.status, 404);

		// And no file was written.
		const yamlPath = path.join(dir, "roles", "does-not-exist.yaml");
		assert.equal(fs.existsSync(yamlPath), false);
	});
});
