import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDefaultWorkflows, RALPH_LOOP_DESCRIPTION } from "../src/server/state-migration/seed-default-workflows.ts";

describe("buildDefaultWorkflows", () => {
	const wfs = buildDefaultWorkflows("myproj");

	function findGate(workflow: ReturnType<typeof buildDefaultWorkflows>[string], id: string) {
		const g = workflow.gates.find((x) => x.id === id);
		assert.ok(g, `gate ${id} should exist in workflow ${workflow.id}`);
		return g!;
	}

	it("general has design-time gap-analysis", () => {
		const designDoc = findGate(wfs.general, "design-doc");
		const has = designDoc.verify?.some((s) => s.name === "Gap analysis");
		assert.equal(has, true);
	});

	it("general has post-impl gap-analysis (phase 2)", () => {
		const impl = findGate(wfs.general, "implementation");
		const gap = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(gap);
		assert.equal(gap!.phase, 2);
		assert.equal(gap!.role, "spec-auditor");
	});

	it("feature still has both gap-analyses", () => {
		const f = wfs.feature;
		assert.ok(findGate(f, "design-doc").verify?.some((s) => s.name === "Gap analysis"));
		const impl = findGate(f, "implementation");
		const gap = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(gap);
		assert.equal(gap!.phase, 2);
	});

	it("quick-fix has neither gap-analysis", () => {
		const qf = wfs["quick-fix"];
		for (const g of qf.gates) {
			for (const s of g.verify ?? []) {
				assert.notEqual(s.name, "Gap analysis");
			}
		}
	});

	it("implementation gates carry Ralph-loop description for general/feature/bug-fix", () => {
		for (const id of ["general", "feature", "bug-fix"]) {
			const impl = findGate(wfs[id], "implementation");
			assert.equal(impl.description, RALPH_LOOP_DESCRIPTION, `${id}.implementation.description`);
		}
	});

	it("quick-fix implementation has a (shorter) Ralph-loop description", () => {
		const impl = findGate(wfs["quick-fix"], "implementation");
		assert.ok(impl.description && impl.description.toLowerCase().includes("ralph loop"));
	});

	// ────────────────────────────────────────────────────────────────
	// parent workflow integration gate — rollup CI suite (issue 9 fix)
	// Live test (PR #409 team-lead-317cdb83): the team-lead reported
	// the gate's 4 steps (Build/Type check/Unit/E2E) were too thin to
	// catch merge regressions — the project's actual CI runs lint /
	// boundaries / contract / integration / eval / fault-injection /
	// replay too. Solution: enumerate the superset; per-project
	// substitute-builtin-component prunes any command not declared.
	// ────────────────────────────────────────────────────────────────

	it("parent.integration enumerates the full CI superset (build, check, lint, boundaries, unit, contract, integration, eval, fault-injection, replay, e2e)", () => {
		const integration = findGate(wfs.parent, "integration");
		const commands = (integration.verify ?? [])
			.filter(s => s.type === "command")
			.map(s => (s as { command?: string }).command)
			.filter((c): c is string => typeof c === "string");
		const expected = ["build", "check", "lint", "boundaries", "unit", "contract", "integration", "eval", "fault-injection", "replay", "e2e"];
		for (const want of expected) {
			assert.ok(commands.includes(want), `parent.integration should include command "${want}" (found: ${commands.join(", ")})`);
		}
	});

	it("parent.integration phases: build at 0, static checks at 1, test tiers at 2, llm-review at 3", () => {
		const integration = findGate(wfs.parent, "integration");
		const byCommand = new Map<string, { phase?: number }>();
		for (const s of integration.verify ?? []) {
			const sAny = s as { command?: string; phase?: number };
			if (sAny.command) byCommand.set(sAny.command, { phase: sAny.phase });
		}
		// Build runs phase 0 (no phase set, defaults to 0).
		assert.equal(byCommand.get("build")?.phase, undefined, "build is phase 0 (no phase field)");
		// Static checks at phase 1.
		for (const cmd of ["check", "lint", "boundaries"]) {
			assert.equal(byCommand.get(cmd)?.phase, 1, `${cmd} should be phase 1`);
		}
		// Test tiers + e2e at phase 2.
		for (const cmd of ["unit", "contract", "integration", "eval", "fault-injection", "replay", "e2e"]) {
			assert.equal(byCommand.get(cmd)?.phase, 2, `${cmd} should be phase 2`);
		}
		// LLM review at phase 3.
		const llmReview = (integration.verify ?? []).find(s => s.type === "llm-review");
		assert.equal((llmReview as { phase?: number } | undefined)?.phase, 3);
	});

	it("parent.integration uses the supplied component name everywhere (rolls into substitute-builtin-component)", () => {
		const integration = findGate(wfs.parent, "integration");
		for (const s of integration.verify ?? []) {
			const sAny = s as { type?: string; component?: string };
			if (sAny.type === "command") {
				assert.equal(sAny.component, "myproj", `command step "${(s as { name?: string }).name}" should target the supplied component name`);
			}
		}
	});

	it("parent.integration's e2e step is enumerated (prune is the project's responsibility, not the seed's)", () => {
		// The seed must include `e2e` so projects that DO have an e2e
		// suite get it run. Projects that don't (agent-memory, others)
		// rely on substituteBuiltinComponent's prune to drop it at
		// per-project workflow-store seeding time.
		const integration = findGate(wfs.parent, "integration");
		const e2e = (integration.verify ?? []).find(s => (s as { command?: string }).command === "e2e");
		assert.ok(e2e, "parent.integration must enumerate e2e");
		assert.equal((e2e as { timeout?: number }).timeout, 900, "e2e timeout 15min for slow browser flows");
	});

	it("parent.integration order matches the canonical CI sequence (build first, llm-review last)", () => {
		const integration = findGate(wfs.parent, "integration");
		const names = (integration.verify ?? []).map(s => (s as { name?: string }).name);
		assert.equal(names[0], "Build", "build runs first — fastest fail signal");
		assert.equal(names[names.length - 1], "Code quality review", "llm-review last");
	});
});
