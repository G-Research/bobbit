// CLF-W5: pinning tests for the gate-risk classifier's rule table
// (`classifyGateRisk`), its path-class helper (`classifyGateRiskPath`), its
// `DecisionClassifier` wrapper, and the real git-backed changed-file gatherer
// (`gatherGateRiskChangedFiles`) it's consulted with from `verifyGateSignal`.
// Mirrors `tests/model-tier-classifier.test.ts`'s shape for CLF-W4.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	classifyGateRisk,
	classifyGateRiskPath,
	gateRiskClassifier,
	gatherGateRiskChangedFiles,
	GATE_RISK_CLASSIFIER_ID,
	GATE_RISK_POINT,
	GATE_RISK_KIND,
	HIGH_RISK_SURFACES,
	LARGE_CHANGESET_FILE_THRESHOLD,
} from "../src/server/agent/gate-risk-classifier.ts";

describe("classifyGateRiskPath", () => {
	it("classifies tests/ paths as 'tests'", () => {
		assert.equal(classifyGateRiskPath("tests/foo.test.ts"), "tests");
		assert.equal(classifyGateRiskPath("tests/e2e/ui/foo.spec.ts"), "tests");
	});

	it("classifies docs/ paths and any *.md as 'docs'", () => {
		assert.equal(classifyGateRiskPath("docs/internals.md"), "docs");
		assert.equal(classifyGateRiskPath("README.md"), "docs");
		assert.equal(classifyGateRiskPath("src/server/agent/README.md"), "docs");
	});

	it("classifies src/server/ paths as 'server'", () => {
		assert.equal(classifyGateRiskPath("src/server/agent/session-manager.ts"), "server");
	});

	it("classifies src/ui/ and src/app/ paths as 'ui'", () => {
		assert.equal(classifyGateRiskPath("src/ui/components/Foo.tsx"), "ui");
		assert.equal(classifyGateRiskPath("src/app/state.ts"), "ui");
	});

	it("classifies everything else as 'other'", () => {
		assert.equal(classifyGateRiskPath("package.json"), "other");
		assert.equal(classifyGateRiskPath("scripts/build.mjs"), "other");
	});
});

describe("classifyGateRisk (deterministic changed-file rule table)", () => {
	it("abstains when changedFiles is undefined — the signal itself is unavailable", () => {
		assert.deepEqual(classifyGateRisk({}), { kind: "abstain" });
	});

	it("selects 'low' for an empty changeset — a fully-known 'zero files changed' signal", () => {
		const decision = classifyGateRisk({ changedFiles: [] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "low");
	});

	it("selects 'low' for a small docs/tests/ui-only changeset", () => {
		const decision = classifyGateRisk({ changedFiles: ["docs/foo.md", "tests/foo.test.ts", "src/ui/Foo.tsx"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "low");
	});

	for (const surface of HIGH_RISK_SURFACES) {
		const isDir = surface.endsWith("/");
		const sample = isDir ? `${surface}oauth.ts` : surface;
		it(`selects 'high' when a changed file matches the high-risk surface "${surface}"`, () => {
			const decision = classifyGateRisk({ changedFiles: ["docs/readme.md", sample] });
			assert.deepEqual(decision, {
				kind: "select",
				choice: "high",
				confidence: 1,
				rationale: `matched deterministic rule 'high-risk-surface': changed file "${sample}" is on the explicit high-risk surface list`,
			});
		});
	}

	it("does NOT match a high-risk surface via substring — e.g. session-manager.test.ts is a different, lower-risk file than session-manager.ts", () => {
		const decision = classifyGateRisk({ changedFiles: ["tests/session-manager.test.ts"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "low");
	});

	it("selects 'medium' for a changeset exceeding the large-changeset threshold, even with no server/high-risk files", () => {
		const files = Array.from({ length: LARGE_CHANGESET_FILE_THRESHOLD + 1 }, (_, i) => `docs/file-${i}.md`);
		const decision = classifyGateRisk({ changedFiles: files });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "medium");
		assert.match((decision as { rationale: string }).rationale, /large-changeset/);
	});

	it("does NOT flag 'medium' on volume when changeset size is exactly at the threshold", () => {
		const files = Array.from({ length: LARGE_CHANGESET_FILE_THRESHOLD }, (_, i) => `docs/file-${i}.md`);
		const decision = classifyGateRisk({ changedFiles: files });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "low");
	});

	it("selects 'medium' when src/server/ files change with zero tests/ files in the same changeset", () => {
		const decision = classifyGateRisk({ changedFiles: ["src/server/agent/foo.ts", "docs/readme.md"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "medium");
		assert.match((decision as { rationale: string }).rationale, /server-change-no-tests/);
	});

	it("selects 'low' when src/server/ files change WITH an accompanying tests/ file", () => {
		const decision = classifyGateRisk({ changedFiles: ["src/server/agent/foo.ts", "tests/foo.test.ts"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "low");
	});

	it("high-risk-surface rule takes precedence over the server-without-tests rule", () => {
		const decision = classifyGateRisk({ changedFiles: ["src/server/server.ts"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "high");
	});

	it("never proposes anything other than the three symbolic labels", () => {
		const cases: Array<string[]> = [
			[],
			["docs/foo.md"],
			["src/server/agent/foo.ts"],
			["src/server/server.ts"],
			Array.from({ length: 20 }, (_, i) => `docs/file-${i}.md`),
		];
		for (const changedFiles of cases) {
			const decision = classifyGateRisk({ changedFiles });
			if (decision.kind === "select") {
				assert.ok(["low", "medium", "high"].includes(decision.choice as string));
			}
		}
	});
});

describe("gateRiskClassifier (DecisionClassifier wrapper)", () => {
	const ctx = { sessionId: "sess-1", cwd: "/tmp" };

	it("has the expected built-in classifier id", () => {
		assert.equal(gateRiskClassifier.id, GATE_RISK_CLASSIFIER_ID);
	});

	it("registers at (gate-verify, risk)", () => {
		assert.equal(GATE_RISK_POINT, "gate-verify");
		assert.equal(GATE_RISK_KIND, "risk");
	});

	it("reads arg.changedFiles and selects the right label", async () => {
		const decision = await gateRiskClassifier.evaluate(ctx, { changedFiles: ["src/server/server.ts"] });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "high");
	});

	it("abstains for a malformed arg (wrong type) rather than throwing", async () => {
		const decision = await gateRiskClassifier.evaluate(ctx, { changedFiles: "not-an-array" });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a changedFiles array containing a non-string entry", async () => {
		const decision = await gateRiskClassifier.evaluate(ctx, { changedFiles: ["ok.ts", 42] });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a null/undefined arg rather than throwing", async () => {
		assert.deepEqual(await gateRiskClassifier.evaluate(ctx, undefined), { kind: "abstain" });
		assert.deepEqual(await gateRiskClassifier.evaluate(ctx, null), { kind: "abstain" });
	});

	it("abstains for arg with no changedFiles key at all (signal unavailable)", async () => {
		assert.deepEqual(await gateRiskClassifier.evaluate(ctx, {}), { kind: "abstain" });
	});
});

describe("gatherGateRiskChangedFiles (real git-backed signal gatherer)", () => {
	let repo: string;
	const gitEnv = ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test"];

	before(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-risk-changed-files-"));
		const remoteDir = path.join(root, "remote.git");
		repo = path.join(root, "repo");
		execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
		execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir, stdio: "ignore" });
		execFileSync("git", [...gitEnv, "clone", remoteDir, repo], { stdio: "ignore" });
		fs.mkdirSync(path.join(repo, "src", "server", "agent"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src", "server", "agent", "foo.ts"), "export const a = 1;\n");
		execFileSync("git", [...gitEnv, "add", "-A"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", [...gitEnv, "commit", "-qm", "base"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", [...gitEnv, "push", "-q", "origin", "master"], { cwd: repo, stdio: "ignore" });

		fs.writeFileSync(path.join(repo, "src", "server", "agent", "foo.ts"), "export const a = 2;\n");
		fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
		fs.writeFileSync(path.join(repo, "tests", "foo.test.ts"), "// test\n");
		fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
		execFileSync("git", [...gitEnv, "add", "-A"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", [...gitEnv, "commit", "-qm", "unpushed change"], { cwd: repo, stdio: "ignore" });
	});

	after(() => {
		fs.rmSync(path.dirname(repo), { recursive: true, force: true });
	});

	it("lists changed files between origin/<baseBranch> and HEAD, excluding package-lock.json", async () => {
		const files = await gatherGateRiskChangedFiles(repo, "master");
		assert.deepEqual([...(files ?? [])].sort(), ["src/server/agent/foo.ts", "tests/foo.test.ts"]);
	});

	it("returns undefined (never throws) when the base branch has no origin remote counterpart", async () => {
		const files = await gatherGateRiskChangedFiles(repo, "nonexistent-branch");
		assert.equal(files, undefined);
	});

	it("returns undefined (never throws) when cwd is not a git repo at all", async () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "gate-risk-not-a-repo-"));
		try {
			const files = await gatherGateRiskChangedFiles(notARepo, "master");
			assert.equal(files, undefined);
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});
});
