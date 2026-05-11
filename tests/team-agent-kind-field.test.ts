/**
 * reviewer kind field — Reviewer kind field, restart-resubscribe skip.
 *
 * `TeamAgent.kind` and `PersistedTeamEntry.agents[].kind` carry one of
 * `"worker" | "reviewer"`. `registerReviewerSession` writes `"reviewer"`;
 * worker spawns and team-lead start write `"worker"`.
 *
 * `resubscribeTeamEvents` skips reviewers when re-attaching the
 * `agent_end → notifyTeamLead` listener. `notifyTeamLead` has a defensive
 * guard with the legacy `role === "reviewer"` fallback for pre-`kind`
 * persisted records.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SOURCE_TM = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "team-manager.ts");
const SOURCE_TS = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "team-store.ts");

describe("kind field declared on persisted shape", () => {
	const teamStore = fs.readFileSync(SOURCE_TS, "utf-8");

	it("PersistedTeamEntry.agents[].kind is declared as `worker | reviewer`", () => {
		assert.match(teamStore, /kind\?:\s*"worker"\s*\|\s*"reviewer"/);
	});

	it("kind is documented as defaulting to worker on load (back-compat)", () => {
		assert.match(teamStore, /Defaults to "worker"/, "back-compat behaviour must be documented");
	});
});

describe("reviewer kind field — TeamManager wiring", () => {
	const tm = fs.readFileSync(SOURCE_TM, "utf-8");

	it("TeamAgent in-memory shape carries `kind: \"worker\" | \"reviewer\"`", () => {
		assert.match(tm, /kind:\s*"worker"\s*\|\s*"reviewer"/);
	});

	it("registerReviewerSession writes kind: \"reviewer\"", () => {
		// Anchor on the method declaration (leading tab) to avoid matching
		// the `unregisterReviewerSession` substring or in-comment mentions.
		const decl = /\n\tregisterReviewerSession\(/;
		const m = decl.exec(tm);
		assert.ok(m, "registerReviewerSession method declaration must be present");
		const idx = m.index;
		const window = tm.slice(idx, idx + 1_500);
		assert.match(window, /kind:\s*"reviewer"/, "registerReviewerSession must stamp kind:reviewer");
	});

	it("at least one worker spawn site writes kind: \"worker\"", () => {
		// Greppable invariant — kind:"worker" must appear somewhere in the
		// file (in the agent-record construction site for workers).
		assert.match(tm, /kind:\s*"worker"/);
	});

	it("resubscribeTeamEvents skips reviewers when attaching the agent_end listener", () => {
		// Anchor on the method definition (not a comment mention elsewhere).
		const defRe = /(?:^|\n)\s*resubscribeTeamEvents\s*\(/;
		const m = defRe.exec(tm);
		assert.ok(m, "resubscribeTeamEvents method definition must exist");
		const window = tm.slice(m.index, m.index + 6_000);
		// Skip predicate: kind === "reviewer" || role === "reviewer"
		assert.match(window, /kind\s*===\s*"reviewer"/);
		assert.match(window, /role\s*===\s*"reviewer"/);
	});

	it("restoreTeams lazy-migrates pre-kind records to kind: \"worker\"", () => {
		// Anchor on the private method declaration (preceded by `private `)
		// to skip the constructor's call site.
		const declRe = /private\s+restoreTeams\s*\(/;
		const m = declRe.exec(tm);
		assert.ok(m, "private restoreTeams method must be declared");
		const idx = m.index;
		// 20 KB window because `restoreTeams` is large — the boot-recovery
		// passes (orphan team-store, fully-orphan recovery, tree-level rename)
		// push the lazy-migration to ~15 KB from the method start.
		const window = tm.slice(idx, idx + 20_000);
		// The migration check.
		assert.match(window, /a\.kind\s*===\s*"reviewer"\s*\?\s*"reviewer"\s*:\s*"worker"/);
	});
});

describe("reviewer kind field — defensive guard pattern", () => {
	const tm = fs.readFileSync(SOURCE_TM, "utf-8");

	it("the kind === reviewer skip predicate has a `role === reviewer` fallback for pre-kind records", () => {
		// Both forms must appear together in the resubscribeTeamEvents window.
		const defRe = /(?:^|\n)\s*resubscribeTeamEvents\s*\(/;
		const m = defRe.exec(tm);
		assert.ok(m, "resubscribeTeamEvents method definition must exist");
		const window = tm.slice(m.index, m.index + 6_000);
		assert.match(
			window,
			/kind\s*===\s*"reviewer"\s*\|\|\s*agent\.role\s*===\s*"reviewer"/,
			"defensive guard must be `kind === reviewer || role === reviewer`",
		);
	});
});

describe("reviewer kind field — predicate logic mirror", () => {
	type Agent = { sessionId: string; role: string; kind?: "worker" | "reviewer" };

	function shouldSkipReattach(agent: Agent): boolean {
		// Mirror of the production guard.
		return agent.kind === "reviewer" || agent.role === "reviewer";
	}

	it("skips a reviewer session by kind", () => {
		assert.equal(shouldSkipReattach({ sessionId: "r", role: "reviewer", kind: "reviewer" }), true);
	});

	it("skips a pre-kind reviewer record (kind undefined, role === reviewer)", () => {
		assert.equal(shouldSkipReattach({ sessionId: "r", role: "reviewer" }), true,
			"defensive role-fallback must catch records written before the kind field existed");
	});

	it("does NOT skip a worker session", () => {
		assert.equal(shouldSkipReattach({ sessionId: "w", role: "coder", kind: "worker" }), false);
	});

	it("does NOT skip a pre-kind worker record (kind undefined, role !== reviewer)", () => {
		assert.equal(shouldSkipReattach({ sessionId: "w", role: "coder" }), false);
	});
});
