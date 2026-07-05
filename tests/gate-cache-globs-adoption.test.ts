/**
 * W3.1b — adoption of VER-01's content-keyed gate cache (`cacheInputGlobs`)
 * in Bobbit's OWN built-in verification workflows.
 *
 * VER-01 (docs/design/gate-step-cache.md) shipped the mechanism dark: a step
 * only gets content-keyed reuse under `BOBBIT_GATE_CACHE=content` once it
 * declares `cacheInputGlobs` on its `VerifyStep`. Nothing shipped with globs
 * by default — the doc's own "A/B plan" flagged real adoption as a follow-up
 * once "at least one workflow's command steps declare real `cacheInputGlobs`
 * for that project's actual layout". This file pins that adoption for
 * Bobbit's own live workflow config, `.bobbit/config/project.yaml` — the
 * project.yaml this repo uses to verify itself via the Ralph loop (see
 * `defaults/workflow-authoring-guide.md` §1: workflows are inlined per
 * project, not templated from `seed-default-workflows.ts`). That template
 * still doesn't hardcode Bobbit-specific globs like `src/**`/`tsconfig*.json`
 * — it's the legacy-migration fallback / new-project auto-seed for
 * *arbitrary* managed projects with no shared layout assumption, so a
 * language-specific glob would be unsound there — but it does now declare
 * the generic, layout-agnostic `cacheInputGlobs: ["**"]` (component-root
 * scoped) on its Build/Type check/Unit tests steps; see
 * `tests/seed-default-workflows-cache-globs.test.ts` for that pin.
 *
 * Two levels of coverage:
 *
 *  1. STATIC PIN — `.bobbit/config/project.yaml`, round-tripped through the
 *     real `normalizeWorkflow` the runtime uses, declares the expected
 *     `cacheInputGlobs` on the Build / Type check / Unit tests command steps
 *     across every workflow that has them (general, feature, bug-fix,
 *     quick-fix) — and leaves every step whose inputs can't be soundly
 *     bounded by a static file glob UNDECLARED: E2E tests (live server/
 *     browser process), the bug-fix repro-test step (a per-goal dynamic
 *     `{{agent.test_command}}`, not a fixed command), every `ready-to-merge`
 *     step and the entire `pr-review` workflow (both depend on live remote
 *     GitHub/git state, not this repo's tracked content at a given SHA), and
 *     `human-signoff-test` (an exerciser fixture with literal `sleep`
 *     commands, not real project commands).
 *
 *  2. FUNCTIONAL PIN — the adopted globs, run through the REAL git-backed
 *     `ContentCacheGitDeps` (`gitListTrackedPaths` / `gitDiffIsClean` from
 *     verification-harness.ts — not the fakes `tests/verification-logic.test.ts`
 *     uses to cover the decision logic in isolation) against a throwaway git
 *     repo whose layout mirrors every glob prefix, produce the expected
 *     verdicts: an unrelated (README-only) commit is a content HIT, a commit
 *     touching a globbed path BUSTS the cache.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { normalizeWorkflow, type Workflow, type WorkflowGate, type VerifyStep } from "../src/server/agent/workflow-store.ts";
import { buildContentStepCache } from "../src/server/agent/verification-logic.ts";
import { gitListTrackedPaths, gitDiffIsClean } from "../src/server/agent/verification-harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_YAML_PATH = path.join(__dirname, "..", ".bobbit", "config", "project.yaml");

function loadWorkflows(): Record<string, Workflow> {
	const raw = fs.readFileSync(PROJECT_YAML_PATH, "utf-8");
	const doc = YAML.parse(raw) as { workflows: Record<string, unknown> };
	const out: Record<string, Workflow> = {};
	for (const [id, wfRaw] of Object.entries(doc.workflows)) {
		const wf = normalizeWorkflow(wfRaw, id);
		if (wf) out[id] = wf;
	}
	return out;
}

function findGate(wf: Workflow, gateId: string): WorkflowGate {
	const gate = wf.gates.find(g => g.id === gateId);
	assert.ok(gate, `gate "${gateId}" present in workflow "${wf.id}"`);
	return gate as WorkflowGate;
}

function findStep(wf: Workflow, gateId: string, stepName: string): VerifyStep {
	const gate = findGate(wf, gateId);
	const step = (gate.verify ?? []).find(s => s.name === stepName);
	assert.ok(step, `step "${stepName}" present in ${wf.id}/${gateId}`);
	return step as VerifyStep;
}

// The three sound glob sets adopted below. Kept in one place so the static
// pin and the functional pin exercise the SAME arrays the project.yaml
// declares — a drift between "what we think we adopted" and "what's actually
// in the YAML" would fail the static pin below immediately.
const BUILD_GLOBS = [
	"src/**", "defaults/**", "market-packs/**", "scripts/**", "public/**",
	"index.html", "package.json", "package-lock.json",
	"tsconfig.json", "tsconfig.server.json", "tsconfig.web.json", "vite.config.ts",
];
const CHECK_GLOBS = [
	"src/**", "tsconfig.json", "tsconfig.server.json", "tsconfig.web.json",
	"package.json", "package-lock.json",
];
const UNIT_GLOBS = [
	"src/**", "tests/**", "defaults/**", "market-packs/**", "scripts/**",
	"index.html", "vite.config.ts", "package.json", "package-lock.json",
];

// ===================================================================
// 1. Static pin — project.yaml declares the right globs on the right steps,
//    and leaves every unsound step undeclared.
// ===================================================================

describe("W3.1b — project.yaml adopts VER-01 cacheInputGlobs on sound command steps", () => {
	const workflows = loadWorkflows();

	const implementationWorkflows: Array<{ id: string; checkName: string }> = [
		{ id: "general", checkName: "Type check passes" },
		{ id: "feature", checkName: "Type check passes" },
		{ id: "bug-fix", checkName: "Type check" },
		{ id: "quick-fix", checkName: "Type check passes" },
	];

	for (const { id: workflowId, checkName } of implementationWorkflows) {
		it(`${workflowId}/implementation: Build declares the adopted build globs`, () => {
			const step = findStep(workflows[workflowId], "implementation", "Build");
			assert.deepEqual(step.cacheInputGlobs, BUILD_GLOBS);
		});

		it(`${workflowId}/implementation: ${JSON.stringify(checkName)} declares the adopted typecheck globs`, () => {
			const step = findStep(workflows[workflowId], "implementation", checkName);
			assert.deepEqual(step.cacheInputGlobs, CHECK_GLOBS);
		});

		it(`${workflowId}/implementation: Unit tests declares the adopted unit-test globs`, () => {
			const step = findStep(workflows[workflowId], "implementation", "Unit tests");
			assert.deepEqual(step.cacheInputGlobs, UNIT_GLOBS);
		});

		it(`${workflowId}/implementation: E2E tests stays UNCACHED — live server/browser process, not soundly bounded by a file diff`, () => {
			const step = findStep(workflows[workflowId], "implementation", "E2E tests");
			assert.equal(step.cacheInputGlobs, undefined);
		});
	}

	it("bug-fix/implementation: the repro-test step stays UNCACHED — per-goal {{agent.test_command}}, no static glob can express a dynamic command", () => {
		const step = findStep(workflows["bug-fix"], "implementation", "Repro test passes (bug fixed)");
		assert.equal(step.cacheInputGlobs, undefined);
	});

	for (const workflowId of ["general", "feature", "bug-fix", "quick-fix"]) {
		it(`${workflowId}/ready-to-merge: every step stays UNCACHED — depends on live remote GitHub/git state, not this repo's tracked content`, () => {
			const gate = findGate(workflows[workflowId], "ready-to-merge");
			for (const step of gate.verify ?? []) {
				assert.equal(step.cacheInputGlobs, undefined, `"${step.name}" must stay sha-exact`);
			}
		});
	}

	it("pr-review workflow: no step declares cacheInputGlobs — every step reads live GitHub PR state (gh pr checkout/view/review), not this repo's tracked content at a SHA", () => {
		const wf = workflows["pr-review"];
		assert.ok(wf);
		for (const gate of wf.gates) {
			for (const step of gate.verify ?? []) {
				assert.equal(step.cacheInputGlobs, undefined, `${gate.id}/"${step.name}" must stay sha-exact`);
			}
		}
	});

	it("human-signoff-test workflow: no step declares cacheInputGlobs — an exerciser fixture (literal sleep commands), not a real project command", () => {
		const wf = workflows["human-signoff-test"];
		assert.ok(wf);
		for (const gate of wf.gates) {
			for (const step of gate.verify ?? []) {
				assert.equal(step.cacheInputGlobs, undefined, `${gate.id}/"${step.name}" must stay sha-exact`);
			}
		}
	});
});

// ===================================================================
// 2. Functional pin — the adopted globs, against the REAL git-backed deps,
//    produce real hits on unrelated changes and real busts on in-glob changes.
// ===================================================================

describe("W3.1b — adopted globs produce real content-cache hits/misses (real git deps)", () => {
	let repo: string;

	before(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-w31b-cache-"));
		const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "pipe" });
		git("git init -q");
		git('git config user.email "test@test.com"');
		git('git config user.name "Test"');
		// One tracked path per glob prefix referenced by BUILD/CHECK/UNIT_GLOBS,
		// plus a control path (README.md) outside every adopted glob.
		const seedFiles = [
			"src/server/agent/foo.ts",
			"tests/foo.test.ts",
			"defaults/roles/foo.yaml",
			"market-packs/foo/pack.yaml",
			"scripts/foo.mjs",
			"public/foo.svg",
			"index.html",
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			"tsconfig.server.json",
			"tsconfig.web.json",
			"vite.config.ts",
			"README.md",
		];
		for (const rel of seedFiles) {
			fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
			fs.writeFileSync(path.join(repo, rel), "v1\n");
		}
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

	const cases: Array<{ label: string; globs: string[] }> = [
		{ label: "Build", globs: BUILD_GLOBS },
		{ label: "Type check passes", globs: CHECK_GLOBS },
		{ label: "Unit tests", globs: UNIT_GLOBS },
	];

	for (const { label, globs } of cases) {
		it(`${label}: an unrelated commit (README.md-only) is a content HIT`, async () => {
			const shaBase = headSha();
			const shaReadme = commit("README.md", `readme update for ${label}\n`, `${label}: readme-only`);
			const steps: any[] = [{ name: label, type: "command", cacheInputGlobs: globs }];
			const { cache, decisions } = await buildContentStepCache(
				priorPassedSignal(shaBase, label), "sig-1", shaReadme, undefined, steps, new Map([[label, repo]]), deps,
			);
			assert.equal(cache.size, 1, JSON.stringify(decisions));
			assert.deepEqual(decisions, [{ stepName: label, keyKind: "content", result: "hit" }]);
		});

		it(`${label}: a commit touching a globbed path (src/server/agent/foo.ts) BUSTS the cache`, async () => {
			const shaBase = headSha();
			const shaSrc = commit("src/server/agent/foo.ts", `export const x = ${Date.now()};\n`, `${label}: src-change`);
			const steps: any[] = [{ name: label, type: "command", cacheInputGlobs: globs }];
			const { cache, decisions } = await buildContentStepCache(
				priorPassedSignal(shaBase, label), "sig-1", shaSrc, undefined, steps, new Map([[label, repo]]), deps,
			);
			assert.equal(cache.size, 0);
			assert.deepEqual(decisions, [{ stepName: label, keyKind: "content", result: "miss" }]);
		});
	}

	it("a step without cacheInputGlobs (E2E tests' real shape) stays sha-exact even against the real git deps — never consults content at all", async () => {
		const shaBase = headSha();
		const shaReadme = commit("README.md", "readme update for e2e\n", "e2e: readme-only");
		const steps: any[] = [{ name: "E2E tests", type: "command" }]; // no cacheInputGlobs — matches the real project.yaml shape
		const { cache, decisions } = await buildContentStepCache(
			priorPassedSignal(shaBase, "E2E tests"), "sig-1", shaReadme, undefined, steps, new Map([["E2E tests", repo]]), deps,
		);
		assert.equal(cache.size, 0);
		assert.deepEqual(decisions, [{ stepName: "E2E tests", keyKind: "sha", result: "miss", reason: "no cacheInputGlobs declared on step — sha-exact only" }]);
	});
});
