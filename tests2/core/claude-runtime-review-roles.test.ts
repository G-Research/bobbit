// v2-native — shipped Claude runtime reviewer role contracts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { RoleLoader, PackResolver } from "../../src/server/agent/pack-resolver.ts";
import type { Role } from "../../src/server/agent/role-store.ts";
import { ACCESSORY_IDS } from "../../src/ui/bobbit-sprite-data.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const defaultsDir = path.join(repoRoot, "defaults");
const rolesDir = path.join(defaultsDir, "roles");
const roleNames = [
	"claude-protocol-scout",
	"backend-parity-reviewer",
	"billing-safety-auditor",
] as const;

type RoleSource = {
	name?: unknown;
	label?: unknown;
	accessory?: unknown;
	promptTemplate?: unknown;
	toolPolicies?: unknown;
	model?: unknown;
	createdAt?: unknown;
	updatedAt?: unknown;
};

const sourceRoles: Record<(typeof roleNames)[number], RoleSource> = {
	"claude-protocol-scout": YAML.parse(
		fs.readFileSync(path.join(rolesDir, "claude-protocol-scout.yaml"), "utf8"),
	) as RoleSource,
	"backend-parity-reviewer": YAML.parse(
		fs.readFileSync(path.join(rolesDir, "backend-parity-reviewer.yaml"), "utf8"),
	) as RoleSource,
	"billing-safety-auditor": YAML.parse(
		fs.readFileSync(path.join(rolesDir, "billing-safety-auditor.yaml"), "utf8"),
	) as RoleSource,
};

function sourceRole(name: (typeof roleNames)[number]): RoleSource {
	return sourceRoles[name];
}

function resolvedRoles(): Map<string, Role> {
	const builtinEntry = {
		id: "builtin",
		kind: "builtin" as const,
		scope: "builtin" as const,
		path: defaultsDir,
		readOnly: true,
		layout: "defaults-tree" as const,
	};
	return new Map(
		new PackResolver([builtinEntry], [new RoleLoader()])
			.resolve<Role>("roles")
			.map(({ name, item }) => [name, item]),
	);
}

function normalized(prompt: string): string {
	return prompt.replace(/\s+/g, " ");
}

function expectConcern(prompt: string, concern: RegExp, role: string): void {
	expect(normalized(prompt), `${role} must cover ${concern}`).toMatch(concern);
}

function expectReviewerConvergence(role: Role): void {
	const prompt = normalized(role.promptTemplate);
	expect(prompt).toMatch(/(?:goal spec(?:ification)?|goal requirements?).{0,100}(?:authoritative|scope)/i);
	expect(prompt).toMatch(/(?:blocker|fail).{0,180}(?:explicit (?:goal )?requirement|concrete.{0,80}regression)/i);
	expect(prompt).toMatch(/(?:file|symbol|line).{0,180}(?:causal path|causal chain)|(?:causal path|causal chain).{0,180}(?:file|symbol|line)/i);
	expect(prompt).toMatch(/(?:minimal|recommended) (?:fix|remediation)/i);
	expect(prompt).toMatch(/(?:focused tests?|verification)/i);
	expect(prompt).toMatch(/(?:submit|call).{0,80}`?verification_result`?/i);
	expect(prompt).toMatch(/(?:never|do not).{0,100}(?:gate_signal|signal (?:a )?gate|produce gate content)/i);
}

describe("Claude runtime reviewer roles", () => {
	it("ships the three real YAML files with the required role schema", () => {
		for (const name of roleNames) {
			const source = sourceRole(name);
			expect(source.name).toBe(name);
			expect(source.label, `${name} needs a display label`).toEqual(expect.any(String));
			expect(source.accessory, `${name} needs an accessory`).toEqual(expect.any(String));
			expect(ACCESSORY_IDS, `${name} accessory must be registered in the canonical sprite registry`).toContain(source.accessory);
			expect(source.model, `${name} must not pin a provider-specific model in the builtin YAML`).toBeUndefined();
			expect(source.promptTemplate, `${name} needs a prompt`).toEqual(expect.any(String));
			expect((source.promptTemplate as string).trim()).not.toBe("");
			expect(source.createdAt, `${name} needs creation metadata`).toEqual(expect.any(Number));
			expect(source.updatedAt, `${name} needs update metadata`).toEqual(expect.any(Number));
			expect(source.toolPolicies, `${name} needs explicit tool-policy ceilings`).toEqual(expect.any(Object));
		}
	});

	it("loads and normalizes every role through the builtin PackResolver", () => {
		const resolved = resolvedRoles();
		for (const name of roleNames) {
			const role = resolved.get(name);
			expect(role, `${name} must resolve from the shipped builtin pack`).toBeDefined();
			expect(role).toMatchObject({ name, label: expect.any(String), promptTemplate: expect.any(String) });
			for (const policy of Object.values(role!.toolPolicies ?? {})) {
				expect(["allow", "ask", "never"]).toContain(policy);
			}
			expect(role!.model, `${name} must use the selected runtime model rather than pin a builtin provider model`).toBeUndefined();
			expect(Buffer.byteLength(role!.promptTemplate, "utf8"), `${name} prompt must stay within 8 KiB`).toBeLessThanOrEqual(8 * 1024);
		}
	});

	it("keeps the auditors read-only and all three roles out of gate orchestration", () => {
		const roles = resolvedRoles();
		for (const name of ["backend-parity-reviewer", "billing-safety-auditor"] as const) {
			const policies = roles.get(name)!.toolPolicies ?? {};
			expect(policies.edit, `${name} must be read-only`).toBe("never");
			expect(policies.bash_bg, `${name} must not start background work`).toBe("never");
			expect(policies.team_delegate, `${name} must not delegate work`).toBe("never");
			expect(policies.gate_signal, `${name} must not signal gates`).toBe("never");
			expect(policies.verification_result, `${name} must submit the existing verifier result`).toBe("allow");
		}

		const scout = roles.get("claude-protocol-scout")!.toolPolicies ?? {};
		expect(scout.edit, "the protocol scout may only make explicitly granted evidence writes").toBe("ask");
		expect(scout.bash_bg, "the protocol scout must conserve local subscription capacity").toBe("never");
		expect(scout.team_delegate).toBe("never");
		expect(scout.gate_signal).toBe("never");
		expect(scout.goal_spawn_child).toBe("never");
		expect(scout.verification_result, "the scout supplies evidence to its task owner rather than acting as a gate verifier").toBe("never");
	});

	it("requires the protocol scout to collect only sanitized observed SDK evidence", () => {
		const role = resolvedRoles().get("claude-protocol-scout")!;
		expect(normalized(role.promptTemplate)).toMatch(/(?:never|do not).{0,100}(?:gate_signal|signal(?:ing)? gates?|produce gate content|submit verification results?)/i);
		expectConcern(role.promptTemplate, /(?:Agent SDK|claude-agent-sdk).{0,100}(?:initiali[sz]|session|tool)/i, role.name);
		expectConcern(role.promptTemplate, /(?:SDK|Claude).{0,100}version/i, role.name);
		expectConcern(role.promptTemplate, /(?:saniti[sz]|redact).{0,160}(?:fixture|transcript|evidence)/i, role.name);
		expectConcern(role.promptTemplate, /(?:do not|never).{0,160}(?:token|raw environment|auth files?|credential)/i, role.name);
		expectConcern(role.promptTemplate, /(?:unobserved|observed).{0,160}(?:claim|evidence|protocol)|(?:protocol claim|claim).{0,100}(?:captured|observed) evidence/i, role.name);
		expectConcern(role.promptTemplate, /(?:limited|narrow(?:ly)? scoped|smallest targeted).{0,160}(?:subscription|SDK|evidence|run)/i, role.name);
	});

	it("requires the parity reviewer to preserve Pi and translated-runtime seams", () => {
		const role = resolvedRoles().get("backend-parity-reviewer")!;
		expectReviewerConvergence(role);
		expectConcern(role.promptTemplate, /claude-agent-sdk/i, role.name);
		expectConcern(role.promptTemplate, /(?:absent|other|anthropic).{0,100}(?:provider|providers?).{0,160}\bPi\b|\bPi\b.{0,160}(?:absent|other|anthropic).{0,100}(?:provider|providers?)/i, role.name);
		expectConcern(role.promptTemplate, /(?:fixture|snapshot).{0,100}(?:drift|version)|(?:drift|version).{0,100}(?:fixture|snapshot)/i, role.name);
		expectConcern(role.promptTemplate, /(?:IRpcBridge|SessionManager|bridge|session seam)/i, role.name);
		expectConcern(role.promptTemplate, /(?:canonical|mcp__bobbit__|tool identit)/i, role.name);
		expectConcern(role.promptTemplate, /transcript.{0,100}(?:usage|partition)|(?:usage|partition).{0,100}transcript/i, role.name);
	});

	it("requires the billing auditor to reject non-subscription credential fallbacks", () => {
		const role = resolvedRoles().get("billing-safety-auditor")!;
		expectReviewerConvergence(role);
		expectConcern(role.promptTemplate, /subscription(?:-only)?/i, role.name);
		expectConcern(role.promptTemplate, /apiKeySource/i, role.name);
		expectConcern(role.promptTemplate, /(?:API key|api key|Bedrock|Vertex|cloud).{0,160}(?:fallback|environment|credential)|(?:fallback|environment|credential).{0,160}(?:API key|api key|Bedrock|Vertex|cloud)/i, role.name);
		expectConcern(role.promptTemplate, /(?:sandbox|auth).{0,120}(?:fail closed|fail-closed)|(?:fail closed|fail-closed).{0,120}(?:sandbox|auth)/i, role.name);
		expectConcern(role.promptTemplate, /(?:billed|actual).{0,100}notional|notional.{0,100}(?:billed|actual)/i, role.name);
	});
});
