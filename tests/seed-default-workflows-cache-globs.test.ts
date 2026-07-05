/**
 * F4/VER-01 default-workflow activation — `cacheInputGlobs` on the SHARED
 * `seed-default-workflows.ts` template (used both by `migrate-project-yaml.ts`
 * for legacy projects and by `server.ts` to auto-seed a brand-new project's
 * workflows on its first goal — see docs/design/gate-step-cache.md).
 *
 * Unlike `tests/gate-cache-globs-adoption.test.ts` (which pins THIS repo's
 * own Bobbit-specific globs — `src/**`, `tsconfig*.json`, etc. — declared
 * directly in `.bobbit/config/project.yaml`), this template serves
 * *arbitrary* managed projects with no shared source-tree convention, so it
 * cannot soundly hardcode a language-specific subpath: a JS/TS-shaped glob
 * would be UNDER-broad (and therefore unsafe, per the design doc's own
 * "never acceptable" bar) for e.g. a Python or Go component.
 *
 * The one glob that IS sound for every layout is `["**"]`
 * (`COMPONENT_SCOPED_CACHE_GLOBS`): `gitListTrackedPaths`/`gitDiffIsClean`
 * (verification-harness.ts) run at the step's resolved `cwd`
 * (`componentRoot()`), and git scopes tree-ish/diff pathspecs to the current
 * working directory's subtree — so `["**"]` matches every tracked path
 * *under that component*, nothing outside it. A step is reused only when
 * literally nothing in its own component changed, which is sound regardless
 * of what the component contains.
 *
 * Two levels of coverage, mirroring `gate-cache-globs-adoption.test.ts`:
 *
 *  1. STATIC PIN — every workflow's Build/Type check/Unit tests command
 *     steps declare `["**"]`; every step whose inputs can't be soundly
 *     bounded by a file diff (E2E, the bug-fix repro-test, agent-qa,
 *     llm-review, ready-to-merge) stays undeclared.
 *
 *  2. FUNCTIONAL PIN — against the REAL git-backed `ContentCacheGitDeps`, a
 *     content change in a SIBLING component's directory does not bust the
 *     cache (the real multi-component win — see `buildAllComponentsWorkflow`
 *     in per-component-workflows.ts), while a change inside the step's own
 *     component directory does.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	buildDefaultWorkflows,
	COMPONENT_SCOPED_CACHE_GLOBS,
	type SeededGate,
	type SeededVerifyStep,
	type SeededWorkflow,
} from "../src/server/state-migration/seed-default-workflows.ts";
import { buildAllComponentsWorkflow } from "../src/server/state-migration/per-component-workflows.ts";
import { buildContentStepCache } from "../src/server/agent/verification-logic.ts";
import { gitListTrackedPaths, gitDiffIsClean } from "../src/server/agent/verification-harness.ts";

function findGate(wf: SeededWorkflow, gateId: string): SeededGate {
	const gate = wf.gates.find((g) => g.id === gateId);
	assert.ok(gate, `gate "${gateId}" present in workflow "${wf.id}"`);
	return gate!;
}

function findStep(gate: SeededGate, stepName: string): SeededVerifyStep {
	const step = (gate.verify ?? []).find((s) => s.name === stepName);
	assert.ok(step, `step "${stepName}" present in gate "${gate.id}"`);
	return step!;
}

// ===================================================================
// 1. Static pin
// ===================================================================

describe("F4/VER-01 — seed-default-workflows.ts declares component-scoped cacheInputGlobs", () => {
	assert.deepEqual(COMPONENT_SCOPED_CACHE_GLOBS, ["**"], "the constant itself must stay the sound, layout-agnostic glob");

	const wfs = buildDefaultWorkflows("myproj");

	const implementationWorkflows: Array<{ id: string; checkName: string; hasE2e: boolean }> = [
		{ id: "general", checkName: "Type check passes", hasE2e: true },
		{ id: "feature", checkName: "Type check passes", hasE2e: true },
		{ id: "bug-fix", checkName: "Type check", hasE2e: true },
		{ id: "quick-fix", checkName: "Type check passes", hasE2e: true },
		{ id: "solo-fast", checkName: "Type check passes", hasE2e: false },
	];

	for (const { id: workflowId, checkName, hasE2e } of implementationWorkflows) {
		const impl = findGate(wfs[workflowId]!, "implementation");

		it(`${workflowId}/implementation: Build declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, "Build").cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});

		it(`${workflowId}/implementation: ${JSON.stringify(checkName)} declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, checkName).cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});

		it(`${workflowId}/implementation: Unit tests declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, "Unit tests").cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});

		if (hasE2e) {
			it(`${workflowId}/implementation: E2E tests stays UNCACHED — live server/browser process, not soundly bounded by a file diff`, () => {
				assert.equal(findStep(impl, "E2E tests").cacheInputGlobs, undefined);
			});
		}
	}

	it("bug-fix/implementation: the repro-test step stays UNCACHED — per-goal {{reproducing-test.meta.test_command}}, no static glob can express a dynamic command", () => {
		const impl = findGate(wfs["bug-fix"]!, "implementation");
		assert.equal(findStep(impl, "Repro test passes (bug fixed)").cacheInputGlobs, undefined);
	});

	it("feature/implementation: QA testing (agent-qa) stays UNCACHED — spawns a live browser/server, same nondeterminism class as E2E", () => {
		const impl = findGate(wfs["feature"]!, "implementation");
		assert.equal(findStep(impl, "QA testing").cacheInputGlobs, undefined);
	});

	for (const workflowId of ["general", "feature", "bug-fix", "quick-fix", "solo-fast"]) {
		it(`${workflowId}: no llm-review or ready-to-merge step declares cacheInputGlobs`, () => {
			for (const gate of wfs[workflowId]!.gates) {
				for (const step of gate.verify ?? []) {
					if (step.type === "command" && (step.name === "Build" || step.name.startsWith("Type check") || step.name === "Unit tests")) continue;
					assert.equal(step.cacheInputGlobs, undefined, `${workflowId}/${gate.id}/"${step.name}" must stay sha-exact`);
				}
			}
		});
	}
});

describe("F4/VER-01 — buildAllComponentsWorkflow fan-out declares the same component-scoped globs", () => {
	const components = [
		{ name: "svc-a", repo: ".", relativePath: "svc-a", commands: { build: "make build", check: "make check", unit: "make test", e2e: "make e2e" } },
		{ name: "svc-b", repo: ".", relativePath: "svc-b", commands: { build: "make build", check: "make check", unit: "make test" } },
	];
	const wf = buildAllComponentsWorkflow(components as any);
	const impl = findGate(wf, "implementation");

	for (const name of ["svc-a", "svc-b"]) {
		it(`Build: ${name} declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, `Build: ${name}`).cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});
		it(`Type check: ${name} declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, `Type check: ${name}`).cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});
		it(`Unit tests: ${name} declares COMPONENT_SCOPED_CACHE_GLOBS`, () => {
			assert.deepEqual(findStep(impl, `Unit tests: ${name}`).cacheInputGlobs, COMPONENT_SCOPED_CACHE_GLOBS);
		});
	}

	it("E2E tests: svc-a stays UNCACHED", () => {
		assert.equal(findStep(impl, "E2E tests: svc-a").cacheInputGlobs, undefined);
	});
});

// ===================================================================
// 2. Functional pin — real git-backed deps, two sibling "components" as
//    subdirectories of one repo (mirrors componentRoot()'s single-repo,
//    relativePath-scoped layout).
// ===================================================================

describe("F4/VER-01 — [\"**\"] produces real cross-component isolation (real git deps)", () => {
	let repo: string;
	let svcA: string;
	let svcB: string;

	before(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-f4-cache-"));
		const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "pipe" });
		git("git init -q");
		git('git config user.email "test@test.com"');
		git('git config user.name "Test"');
		svcA = path.join(repo, "svc-a");
		svcB = path.join(repo, "svc-b");
		fs.mkdirSync(svcA, { recursive: true });
		fs.mkdirSync(svcB, { recursive: true });
		fs.writeFileSync(path.join(svcA, "main.py"), "v1\n"); // arbitrary non-JS layout on purpose
		fs.writeFileSync(path.join(svcB, "main.go"), "v1\n");
		git("git add -A && git commit -qm base");
	});

	after(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	function commit(rel: string, content: string, msg: string): string {
		fs.writeFileSync(path.join(repo, rel), content);
		execSync("git add -A && git commit -qm " + JSON.stringify(msg), { cwd: repo, stdio: "pipe" });
		return execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
	}

	function headSha(): string {
		return execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
	}

	const deps = { listTrackedPaths: gitListTrackedPaths, diffIsClean: gitDiffIsClean };

	function priorPassedSignal(sha: string, stepName: string): any {
		return [{
			id: "sig-0", gateId: "g", goalId: "goal", sessionId: "s", timestamp: Date.now() - 1000,
			commitSha: sha,
			verification: { status: "passed", steps: [{ name: stepName, passed: true, output: "ok", duration_ms: 1 }] },
		}];
	}

	it("a change in the SIBLING component (svc-b) is a content HIT for svc-a's step — cross-component isolation", async () => {
		const shaBase = headSha();
		const shaSiblingChange = commit("svc-b/main.go", `v2-${Date.now()}\n`, "svc-b change");
		const steps: any[] = [{ name: "Build: svc-a", type: "command", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS }];
		const { cache, decisions } = await buildContentStepCache(
			priorPassedSignal(shaBase, "Build: svc-a"), "sig-1", shaSiblingChange, undefined, steps, new Map([["Build: svc-a", svcA]]), deps,
		);
		assert.equal(cache.size, 1, JSON.stringify(decisions));
		assert.deepEqual(decisions, [{ stepName: "Build: svc-a", keyKind: "content", result: "hit" }]);
	});

	it("a change WITHIN the step's own component (svc-a) BUSTS its cache", async () => {
		const shaBase = headSha();
		const shaOwnChange = commit("svc-a/main.py", `v2-${Date.now()}\n`, "svc-a change");
		const steps: any[] = [{ name: "Build: svc-a", type: "command", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS }];
		const { cache, decisions } = await buildContentStepCache(
			priorPassedSignal(shaBase, "Build: svc-a"), "sig-1", shaOwnChange, undefined, steps, new Map([["Build: svc-a", svcA]]), deps,
		);
		assert.equal(cache.size, 0);
		assert.deepEqual(decisions, [{ stepName: "Build: svc-a", keyKind: "content", result: "miss" }]);
	});

	it("single-component projects (cwd === repo root) see the whole repo — a change anywhere busts the cache (safe no-op, not a regression)", async () => {
		const shaBase = headSha();
		const shaAnyChange = commit("svc-b/main.go", `v3-${Date.now()}\n`, "any change");
		const steps: any[] = [{ name: "Build", type: "command", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS }];
		const { cache, decisions } = await buildContentStepCache(
			priorPassedSignal(shaBase, "Build"), "sig-1", shaAnyChange, undefined, steps, new Map([["Build", repo]]), deps,
		);
		assert.equal(cache.size, 0);
		assert.deepEqual(decisions, [{ stepName: "Build", keyKind: "content", result: "miss" }]);
	});
});
