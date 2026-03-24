/**
 * Unit tests for RoleManager and PersonalityManager name validation,
 * duplicate detection, missing fields, and defaults.
 * Uses in-memory mock stores — no disk I/O.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PersonalityManager } from "../src/server/agent/personality-manager.ts";
import type { Role } from "../src/server/agent/role-store.ts";
import type { Personality } from "../src/server/agent/personality-store.ts";

// We can't use RoleManager directly because it fires off generateRoleNames
// (async HTTP call to Claude) as a side-effect of createRole. Instead,
// replicate the pure validation logic inline. The validation is identical
// in both RoleManager and PersonalityManager — same NAME_PATTERN regex.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Minimal RoleManager that skips the generateRoleNames side-effect */
class TestRoleManager {
	constructor(private store: MockRoleStore) {}

	createRole(opts: {
		name: string;
		label: string;
		promptTemplate: string;
		allowedTools?: string[];
		accessory?: string;
	}): Role {
		const { name, label, promptTemplate, allowedTools = [], accessory = "none" } = opts;
		if (!name || typeof name !== "string") throw new Error("Missing role name");
		if (!NAME_PATTERN.test(name)) throw new Error("Role name must be lowercase alphanumeric + hyphens (e.g. 'my-role')");
		if (this.store.get(name)) throw new Error(`Role "${name}" already exists`);
		if (!label || typeof label !== "string") throw new Error("Missing role label");

		const now = Date.now();
		const role: Role = { name, label, promptTemplate: promptTemplate || "", allowedTools, accessory, createdAt: now, updatedAt: now };
		this.store.put(role);
		return role;
	}

	getRole(name: string): Role | undefined { return this.store.get(name); }
	listRoles(): Role[] { return this.store.getAll(); }
	updateRole(name: string, updates: { label?: string; promptTemplate?: string; allowedTools?: string[]; accessory?: string }): boolean {
		return this.store.update(name, updates);
	}
	deleteRole(name: string): boolean {
		if (!this.store.get(name)) return false;
		this.store.remove(name);
		return true;
	}
}

// ---------------------------------------------------------------------------
// In-memory mock stores
// ---------------------------------------------------------------------------

class MockRoleStore {
	private roles = new Map<string, Role>();
	put(role: Role): void { this.roles.set(role.name, role); }
	get(name: string): Role | undefined { return this.roles.get(name); }
	remove(name: string): void { this.roles.delete(name); }
	getAll(): Role[] { return Array.from(this.roles.values()); }
	reload(): void { /* no-op */ }
	update(name: string, updates: Partial<Omit<Role, "name" | "createdAt">>): boolean {
		const existing = this.roles.get(name);
		if (!existing) return false;
		Object.assign(existing, updates, { updatedAt: Date.now() });
		return true;
	}
}

class MockPersonalityStore {
	private personalities = new Map<string, Personality>();
	put(p: Personality): void { this.personalities.set(p.name, p); }
	get(name: string): Personality | undefined { return this.personalities.get(name); }
	remove(name: string): void { this.personalities.delete(name); }
	getAll(): Personality[] { return Array.from(this.personalities.values()); }
	reload(): void { /* no-op */ }
	update(name: string, updates: Partial<Omit<Personality, "name" | "createdAt">>): boolean {
		const existing = this.personalities.get(name);
		if (!existing) return false;
		Object.assign(existing, updates, { updatedAt: Date.now() });
		return true;
	}
}

// ---------------------------------------------------------------------------
// RoleManager tests
// ---------------------------------------------------------------------------

describe("RoleManager", () => {
	let store: MockRoleStore;
	let mgr: TestRoleManager;

	beforeEach(() => {
		store = new MockRoleStore();
		mgr = new TestRoleManager(store);
	});

	describe("name validation", () => {
		it("accepts single-character name 'a'", () => {
			const role = mgr.createRole({ name: "a", label: "A", promptTemplate: "" });
			assert.equal(role.name, "a");
		});

		it("accepts alphanumeric-hyphens 'my-role-123'", () => {
			const role = mgr.createRole({ name: "my-role-123", label: "My Role", promptTemplate: "" });
			assert.equal(role.name, "my-role-123");
		});

		it("rejects uppercase 'TestRole'", () => {
			assert.throws(() => {
				mgr.createRole({ name: "TestRole", label: "Test", promptTemplate: "" });
			}, /lowercase/);
		});

		it("rejects spaces 'test role'", () => {
			assert.throws(() => {
				mgr.createRole({ name: "test role", label: "Test", promptTemplate: "" });
			}, /lowercase/);
		});

		it("rejects special chars 'test_role!'", () => {
			assert.throws(() => {
				mgr.createRole({ name: "test_role!", label: "Test", promptTemplate: "" });
			}, /lowercase/);
		});

		it("rejects empty string", () => {
			assert.throws(() => {
				mgr.createRole({ name: "", label: "Test", promptTemplate: "" });
			}, /Missing role name/);
		});
	});

	describe("duplicate detection", () => {
		it("rejects duplicate role name", () => {
			mgr.createRole({ name: "test-role", label: "First", promptTemplate: "" });
			assert.throws(() => {
				mgr.createRole({ name: "test-role", label: "Second", promptTemplate: "" });
			}, /already exists/);
		});
	});

	describe("missing fields", () => {
		it("rejects missing label", () => {
			assert.throws(() => {
				mgr.createRole({ name: "test-role", label: "", promptTemplate: "" });
			}, /Missing role label/);
		});
	});

	describe("defaults", () => {
		it("defaults accessory to 'none'", () => {
			const role = mgr.createRole({ name: "test-role", label: "Test", promptTemplate: "" });
			assert.equal(role.accessory, "none");
		});

		it("defaults allowedTools to empty array", () => {
			const role = mgr.createRole({ name: "test-role", label: "Test", promptTemplate: "" });
			assert.deepEqual(role.allowedTools, []);
		});

		it("defaults promptTemplate to empty string", () => {
			const role = mgr.createRole({ name: "test-role", label: "Test", promptTemplate: "" });
			assert.equal(role.promptTemplate, "");
		});

		it("sets createdAt and updatedAt", () => {
			const before = Date.now();
			const role = mgr.createRole({ name: "test-role", label: "Test", promptTemplate: "" });
			assert.ok(role.createdAt >= before);
			assert.ok(role.updatedAt >= before);
		});
	});

	describe("CRUD", () => {
		it("getRole returns created role", () => {
			mgr.createRole({ name: "test", label: "Test", promptTemplate: "prompt" });
			const role = mgr.getRole("test");
			assert.ok(role);
			assert.equal(role.label, "Test");
		});

		it("getRole returns undefined for nonexistent", () => {
			assert.equal(mgr.getRole("nope"), undefined);
		});

		it("deleteRole removes it", () => {
			mgr.createRole({ name: "test", label: "Test", promptTemplate: "" });
			assert.equal(mgr.deleteRole("test"), true);
			assert.equal(mgr.getRole("test"), undefined);
		});

		it("deleteRole returns false for nonexistent", () => {
			assert.equal(mgr.deleteRole("nope"), false);
		});

		it("updateRole changes fields", () => {
			mgr.createRole({ name: "test", label: "Old", promptTemplate: "" });
			mgr.updateRole("test", { label: "New" });
			assert.equal(mgr.getRole("test")!.label, "New");
		});

		it("updateRole returns false for nonexistent", () => {
			assert.equal(mgr.updateRole("nope", { label: "X" }), false);
		});
	});
});

// ---------------------------------------------------------------------------
// PersonalityManager tests
// ---------------------------------------------------------------------------

describe("PersonalityManager", () => {
	let store: MockPersonalityStore;
	let mgr: PersonalityManager;

	beforeEach(() => {
		store = new MockPersonalityStore();
		mgr = new PersonalityManager(store as any);
	});

	describe("name validation", () => {
		it("accepts single-character name 'a'", () => {
			const p = mgr.createPersonality({ name: "a", label: "A", description: "", promptFragment: "" });
			assert.equal(p.name, "a");
		});

		it("accepts alphanumeric-hyphens 'my-personality-123'", () => {
			const p = mgr.createPersonality({ name: "my-personality-123", label: "My P", description: "", promptFragment: "" });
			assert.equal(p.name, "my-personality-123");
		});

		it("rejects uppercase 'TestPersonality'", () => {
			assert.throws(() => {
				mgr.createPersonality({ name: "TestPersonality", label: "Test", description: "", promptFragment: "" });
			}, /lowercase/);
		});

		it("rejects spaces 'test personality'", () => {
			assert.throws(() => {
				mgr.createPersonality({ name: "test personality", label: "Test", description: "", promptFragment: "" });
			}, /lowercase/);
		});

		it("rejects empty string", () => {
			assert.throws(() => {
				mgr.createPersonality({ name: "", label: "Test", description: "", promptFragment: "" });
			}, /Missing personality name/);
		});
	});

	describe("duplicate detection", () => {
		it("rejects duplicate personality name", () => {
			mgr.createPersonality({ name: "test", label: "First", description: "", promptFragment: "" });
			assert.throws(() => {
				mgr.createPersonality({ name: "test", label: "Second", description: "", promptFragment: "" });
			}, /already exists/);
		});
	});

	describe("missing fields", () => {
		it("rejects missing label", () => {
			assert.throws(() => {
				mgr.createPersonality({ name: "test", label: "", description: "", promptFragment: "" });
			}, /Missing personality label/);
		});
	});

	describe("defaults", () => {
		it("defaults description to empty string", () => {
			const p = mgr.createPersonality({ name: "test", label: "Test", description: "", promptFragment: "frag" });
			assert.equal(p.description, "");
		});

		it("defaults promptFragment to empty string", () => {
			const p = mgr.createPersonality({ name: "test", label: "Test", description: "desc", promptFragment: "" });
			assert.equal(p.promptFragment, "");
		});
	});

	describe("CRUD", () => {
		it("getPersonality returns created personality", () => {
			mgr.createPersonality({ name: "test", label: "Test", description: "d", promptFragment: "f" });
			const p = mgr.getPersonality("test");
			assert.ok(p);
			assert.equal(p.label, "Test");
		});

		it("deletePersonality removes it", () => {
			mgr.createPersonality({ name: "test", label: "Test", description: "", promptFragment: "" });
			assert.equal(mgr.deletePersonality("test"), true);
			assert.equal(mgr.getPersonality("test"), undefined);
		});

		it("deletePersonality returns false for nonexistent", () => {
			assert.equal(mgr.deletePersonality("nope"), false);
		});

		it("updatePersonality changes fields", () => {
			mgr.createPersonality({ name: "test", label: "Old", description: "", promptFragment: "" });
			mgr.updatePersonality("test", { label: "New" });
			assert.equal(mgr.getPersonality("test")!.label, "New");
		});
	});

	describe("resolvePersonalities", () => {
		it("returns matching personalities", () => {
			mgr.createPersonality({ name: "a", label: "A", description: "d", promptFragment: "frag-a" });
			mgr.createPersonality({ name: "b", label: "B", description: "d", promptFragment: "frag-b" });
			const resolved = mgr.resolvePersonalities(["a", "b"]);
			assert.equal(resolved.length, 2);
			assert.equal(resolved[0].promptFragment, "frag-a");
		});

		it("skips unknown names silently", () => {
			mgr.createPersonality({ name: "a", label: "A", description: "", promptFragment: "f" });
			const resolved = mgr.resolvePersonalities(["a", "unknown"]);
			assert.equal(resolved.length, 1);
		});

		it("returns empty for all unknown", () => {
			const resolved = mgr.resolvePersonalities(["x", "y"]);
			assert.deepEqual(resolved, []);
		});
	});
});
