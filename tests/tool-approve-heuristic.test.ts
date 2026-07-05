// CLF-W2.5: pinning tests for the first REAL classifier registered at the
// (tool-call, tool-approve) decision seam — the conservative rule table
// (`classifyToolApprove`), its `DecisionClassifier` wrapper
// (`toolApproveHeuristicClassifier`), and the registration-gate flag
// (`isToolApproveHeuristicEnabled`). See
// src/server/agent/tool-approve-heuristic.ts's header comment for the full
// design/scope — this wave's rule table is deliberately narrow because
// `ToolApproveArg` carries no command/argument content, only tool identity.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
	classifyToolApprove,
	toolApproveHeuristicClassifier,
	isToolApproveHeuristicEnabled,
	TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID,
	DANGEROUS_TOOL_GROUPS,
	READ_ONLY_SAFE_TOOL_NAMES,
} from "../src/server/agent/tool-approve-heuristic.ts";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND } from "../src/server/agent/tool-approve-classifier.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("classifyToolApprove — table-driven rule tests", () => {
	const cases: Array<{ name: string; arg: { toolName: string; toolGroup: string; roleName?: string }; expected: "select-deny" | "select-allow" | "abstain" }> = [
		// --- deny: dangerous tool-guard groups (defaults/tool-group-policies.yaml's `never` groups) ---
		{ name: "Children group tool → deny", arg: { toolName: "goal_archive_child", toolGroup: "Children" }, expected: "select-deny" },
		{ name: "Team group tool → deny", arg: { toolName: "team_dismiss", toolGroup: "Team" }, expected: "select-deny" },
		{ name: "PR Walkthrough group tool → deny", arg: { toolName: "readonly_bash", toolGroup: "PR Walkthrough" }, expected: "select-deny" },
		{ name: "dangerous group match is case-insensitive", arg: { toolName: "team_spawn", toolGroup: "team" }, expected: "select-deny" },
		{ name: "dangerous group match tolerates surrounding whitespace", arg: { toolName: "team_spawn", toolGroup: " Team " }, expected: "select-deny" },

		// --- allow: hand-curated read-only-safe tools ---
		{ name: "read → allow", arg: { toolName: "read", toolGroup: "File System" }, expected: "select-allow" },
		{ name: "ls → allow", arg: { toolName: "ls", toolGroup: "File System" }, expected: "select-allow" },
		{ name: "grep → allow", arg: { toolName: "grep", toolGroup: "File System" }, expected: "select-allow" },
		{ name: "find → allow", arg: { toolName: "find", toolGroup: "File System" }, expected: "select-allow" },
		{ name: "read-only-safe match is case-insensitive", arg: { toolName: "READ", toolGroup: "File System" }, expected: "select-allow" },

		// --- abstain: everything not covered by either rule ---
		{ name: "write (mutating File System tool) → abstain", arg: { toolName: "write", toolGroup: "File System" }, expected: "abstain" },
		{ name: "edit (mutating File System tool) → abstain", arg: { toolName: "edit", toolGroup: "File System" }, expected: "abstain" },
		{ name: "bash (unrestricted shell — no argument visibility) → abstain", arg: { toolName: "bash", toolGroup: "Shell" }, expected: "abstain" },
		{ name: "bash_bg → abstain", arg: { toolName: "bash_bg", toolGroup: "Shell" }, expected: "abstain" },
		{ name: "an unrecognized MCP tool → abstain, no ambiguity guessing", arg: { toolName: "mcp__playwright__click", toolGroup: "mcp__playwright" }, expected: "abstain" },
		{ name: "Skills group (allow-by-default, not in the dangerous set) → abstain", arg: { toolName: "activate_skill", toolGroup: "Skills" }, expected: "abstain" },
	];

	for (const { name, arg, expected } of cases) {
		it(name, () => {
			const decision = classifyToolApprove(arg);
			if (expected === "abstain") {
				assert.deepEqual(decision, { kind: "abstain" });
			} else {
				assert.equal(decision.kind, "select");
				assert.equal((decision as { choice: string }).choice, expected === "select-deny" ? "deny" : "allow");
				assert.equal((decision as { confidence?: number }).confidence, 1);
				assert.equal(typeof (decision as { rationale?: string }).rationale, "string");
				assert.match((decision as { rationale: string }).rationale, /matched deterministic rule/);
			}
		});
	}

	it("deny rationale names the matched tool and group", () => {
		const decision = classifyToolApprove({ toolName: "team_dismiss", toolGroup: "Team" });
		assert.equal(decision.kind, "select");
		assert.match((decision as { rationale: string }).rationale, /"team_dismiss"/);
		assert.match((decision as { rationale: string }).rationale, /"Team"/);
		assert.match((decision as { rationale: string }).rationale, /'dangerous-group'/);
	});

	it("allow rationale names the matched tool and flags record-only status", () => {
		const decision = classifyToolApprove({ toolName: "grep", toolGroup: "File System" });
		assert.equal(decision.kind, "select");
		assert.match((decision as { rationale: string }).rationale, /"grep"/);
		assert.match((decision as { rationale: string }).rationale, /'read-only-safe'/);
		assert.match((decision as { rationale: string }).rationale, /record-only/);
	});
});

describe("DANGEROUS_TOOL_GROUPS — single source of truth with defaults/tool-group-policies.yaml", () => {
	it("contains exactly the groups defaults/tool-group-policies.yaml marks `never` by default", () => {
		const yamlPath = path.join(__dirname, "..", "defaults", "tool-group-policies.yaml");
		const raw = fs.readFileSync(yamlPath, "utf-8");
		const data = parse(raw) as Record<string, string>;
		const neverGroups = Object.entries(data)
			.filter(([, policy]) => policy === "never")
			.map(([group]) => group)
			.sort();
		assert.deepEqual([...DANGEROUS_TOOL_GROUPS].sort(), neverGroups, "DANGEROUS_TOOL_GROUPS drifted from defaults/tool-group-policies.yaml's `never` groups — update the constant (or this test) to match");
	});
});

describe("toolApproveHeuristicClassifier (DecisionClassifier wrapper)", () => {
	const ctx = { sessionId: "sess-1", cwd: "/tmp" };

	it("has the expected built-in classifier id", () => {
		assert.equal(toolApproveHeuristicClassifier.id, TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID);
	});

	it("registers at (tool-call, tool-approve), matching the CLF-W2 seam", () => {
		assert.equal(TOOL_APPROVE_POINT, "tool-call");
		assert.equal(TOOL_APPROVE_KIND, "tool-approve");
	});

	it("denies a dangerous-group tool", async () => {
		const decision = await toolApproveHeuristicClassifier.evaluate(ctx, { toolName: "team_dismiss", toolGroup: "Team" });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "deny");
	});

	it("allows a read-only-safe tool", async () => {
		const decision = await toolApproveHeuristicClassifier.evaluate(ctx, { toolName: "ls", toolGroup: "File System" });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "allow");
	});

	it("abstains for a malformed arg (missing toolGroup) rather than throwing", async () => {
		const decision = await toolApproveHeuristicClassifier.evaluate(ctx, { toolName: "read" });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a null/undefined arg rather than throwing", async () => {
		assert.deepEqual(await toolApproveHeuristicClassifier.evaluate(ctx, undefined), { kind: "abstain" });
		assert.deepEqual(await toolApproveHeuristicClassifier.evaluate(ctx, null), { kind: "abstain" });
	});
});

describe("isToolApproveHeuristicEnabled", () => {
	afterEach(() => {
		delete process.env.BOBBIT_CLF_TOOL_APPROVE;
	});

	it("is false when BOBBIT_CLF_TOOL_APPROVE is unset", () => {
		delete process.env.BOBBIT_CLF_TOOL_APPROVE;
		assert.equal(isToolApproveHeuristicEnabled(), false);
	});

	it("is false for an empty string (unset-equivalent)", () => {
		process.env.BOBBIT_CLF_TOOL_APPROVE = "";
		assert.equal(isToolApproveHeuristicEnabled(), false);
	});

	it("is true for 'observe' (registers in telemetry-only mode)", () => {
		process.env.BOBBIT_CLF_TOOL_APPROVE = "observe";
		assert.equal(isToolApproveHeuristicEnabled(), true);
	});

	it("is true for 'enforce'", () => {
		process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
		assert.equal(isToolApproveHeuristicEnabled(), true);
	});

	it("is true for any other non-empty value (registration itself isn't picky about the exact string)", () => {
		process.env.BOBBIT_CLF_TOOL_APPROVE = "1";
		assert.equal(isToolApproveHeuristicEnabled(), true);
	});
});

describe("READ_ONLY_SAFE_TOOL_NAMES — matches defaults/tools/filesystem's non-mutating tools", () => {
	it("does not include the mutating File System tools (edit, write)", () => {
		assert.equal(READ_ONLY_SAFE_TOOL_NAMES.includes("edit"), false);
		assert.equal(READ_ONLY_SAFE_TOOL_NAMES.includes("write"), false);
	});

	it("covers exactly read, ls, grep, find", () => {
		assert.deepEqual([...READ_ONLY_SAFE_TOOL_NAMES].sort(), ["find", "grep", "ls", "read"]);
	});
});
