// v2-native — Support assistant type + role wiring.
//
// Pins the backend surface for the built-in Support assistant:
//   • getAssistantDef("support") is registered (title/promptTitle).
//   • defaults/roles/support.yaml loads with accessory: headset and the
//     bobbit tier tool policies (orchestrate: allow, admin: ask).
//   • SUPPORT_ASSISTANT_PROMPT carries the confirmation-first instruction.
//   • assistantRoleForType maps support -> support, everything else -> assistant.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";

const { getAssistantDef, assistantRoleForType, composeAssistantTitle } = await import("../../src/server/agent/assistant-registry.ts");
const { SUPPORT_ASSISTANT_PROMPT } = await import("../../src/server/agent/support-assistant.ts");

const DEFAULTS_DIR = path.resolve(import.meta.dirname, "..", "..", "defaults");
const SUPPORT_ROLE_FILE = path.join(DEFAULTS_DIR, "roles", "support.yaml");

describe("support assistant type", () => {
	it("getAssistantDef('support') is registered with the right titles", () => {
		const def = getAssistantDef("support");
		assert.ok(def, "support assistant def must be registered");
		assert.equal(def!.type, "support");
		assert.equal(def!.title, "Support");
		assert.equal(def!.promptTitle, "Bobbit Support Assistant");
		assert.equal(def!.prompt, SUPPORT_ASSISTANT_PROMPT);
	});

	it("SUPPORT_ASSISTANT_PROMPT contains the confirmation-first instruction", () => {
		assert.match(SUPPORT_ASSISTANT_PROMPT, /without first explaining/);
		assert.match(SUPPORT_ASSISTANT_PROMPT, /explicit go-ahead/);
	});

	it("prompt references the bundled docs + src placeholders", () => {
		assert.match(SUPPORT_ASSISTANT_PROMPT, /\{\{BOBBIT_DOCS_DIR\}\}/);
		assert.match(SUPPORT_ASSISTANT_PROMPT, /\{\{BOBBIT_SRC_DIR\}\}/);
	});
});

describe("assistantRoleForType", () => {
	it("maps support -> support and everything else -> assistant", () => {
		assert.equal(assistantRoleForType("support"), "support");
		assert.equal(assistantRoleForType("goal"), "assistant");
		assert.equal(assistantRoleForType("project"), "assistant");
		assert.equal(assistantRoleForType(undefined), "assistant");
	});
});

describe("assistant titlePrefix", () => {
	it("exposes the exact type prefixes used for initial title + auto-rename", () => {
		const cases: Record<string, string> = {
			goal: "New Goal",
			role: "New Role",
			tool: "New Tool",
			staff: "New Staff",
			project: "New Project",
			"project-scaffolding": "New Project",
			support: "Support",
		};
		for (const [type, prefix] of Object.entries(cases)) {
			const def = getAssistantDef(type);
			assert.ok(def, `assistant def must be registered for ${type}`);
			assert.equal(def!.titlePrefix, prefix, `titlePrefix for ${type}`);
		}
	});
});

describe("composeAssistantTitle", () => {
	it("composes '<prefix>: <summary>'", () => {
		assert.equal(composeAssistantTitle("Support", "reset worktree pool"), "Support: reset worktree pool");
		assert.equal(composeAssistantTitle("New Goal", "add dark mode"), "New Goal: add dark mode");
	});
});

describe("support role definition", () => {
	it("defaults/roles/support.yaml loads with headset accessory + bobbit tier policies", () => {
		const raw = fs.readFileSync(SUPPORT_ROLE_FILE, "utf-8");
		const role = YAML.parse(raw) as {
			name?: string;
			accessory?: string;
			toolPolicies?: Record<string, string>;
			promptTemplate?: string;
		};
		assert.equal(role.name, "support");
		assert.equal(role.accessory, "headset");
		assert.equal(role.toolPolicies?.bobbit_orchestrate, "allow");
		assert.equal(role.toolPolicies?.bobbit_admin, "ask");
		// bobbit_read must NOT be listed — its `allow` default already applies.
		assert.equal(role.toolPolicies?.bobbit_read, undefined);
		assert.ok(role.promptTemplate && role.promptTemplate.length > 0, "support role needs a promptTemplate");
	});
});
