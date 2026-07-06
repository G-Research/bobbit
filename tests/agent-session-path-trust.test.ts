import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	isContainerAgentSessionPath,
	isHostAbsoluteAgentSessionPath,
} from "../src/server/agent/agent-session-path.js";

/**
 * Pins the canonical host-vs-container path-trust predicate semantics after the
 * PR #250 consolidation into `src/server/agent/agent-session-path.ts`.
 *
 * Why this test exists (drift forensics): the SM decomposition cohort-1
 * extraction (commit 254ce9f4) claimed to copy `isContainerAgentSessionPath`
 * verbatim from `session-manager.ts` into `archived-worktree-manager.ts`, but
 * the copied body actually DIFFERED — it classified broad prefixes
 * (`/workspace`, `/root/.claude`, `/home/`) as "container", while the canonical
 * predicate only trusts the two agent-session container dirs
 * (`/home/node/.bobbit/agent/sessions`, `/bobbit-state/sessions`). That drifted
 * copy's only call site was archived-worktree-manager's purge/deletion path,
 * where container-classified paths bypass the `resolveSafeSessionsPath`
 * trusted-roots constraint. PR #250 deleted the drifted copy in favor of the
 * canonical one, which means:
 *   (a) Linux host paths under `/home/<user>/` are host-classified and gain the
 *       trusted-roots deletion constraint (safety improvement), and
 *   (b) `/workspace` / `/root/.claude` paths are host-classified, fail
 *       `resolveSafeSessionsPath`, and deletion is cleanly skipped instead of
 *       raw-passed.
 *
 * Deletion-path classification must never silently broaden or narrow again —
 * if you need to change these semantics, change this test deliberately and
 * audit every importer of agent-session-path.ts.
 */
describe("agent-session-path trust predicates (pins PR #250 drift fix)", () => {
	describe("isContainerAgentSessionPath", () => {
		it("trusts the sandbox agent-sessions dir and files inside it", () => {
			assert.equal(isContainerAgentSessionPath("/home/node/.bobbit/agent/sessions"), true);
			assert.equal(isContainerAgentSessionPath("/home/node/.bobbit/agent/sessions/x.jsonl"), true);
			assert.equal(
				isContainerAgentSessionPath("/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01T00-00-00-000Z_sid.jsonl"),
				true,
			);
		});

		it("trusts the bobbit-state sessions mount and files inside it", () => {
			assert.equal(isContainerAgentSessionPath("/bobbit-state/sessions"), true);
			assert.equal(isContainerAgentSessionPath("/bobbit-state/sessions/x.jsonl"), true);
		});

		it("normalizes backslashes before classifying", () => {
			assert.equal(isContainerAgentSessionPath("\\home\\node\\.bobbit\\agent\\sessions\\x.jsonl"), true);
			assert.equal(isContainerAgentSessionPath("\\bobbit-state\\sessions\\x.jsonl"), true);
		});

		it("does NOT trust the broad prefixes the drifted cohort-1 copy trusted", () => {
			// These were container-classified by the unfaithful copy in
			// archived-worktree-manager.ts (254ce9f4) and would have bypassed
			// resolveSafeSessionsPath on the purge path. They must stay false.
			assert.equal(isContainerAgentSessionPath("/workspace/x.jsonl"), false);
			assert.equal(isContainerAgentSessionPath("/root/.claude/projects/p/x.jsonl"), false);
			assert.equal(isContainerAgentSessionPath("/home/aj/other/x.jsonl"), false);
		});
	});

	describe("isHostAbsoluteAgentSessionPath", () => {
		it("is false for undefined and container agent-session dirs", () => {
			assert.equal(isHostAbsoluteAgentSessionPath(undefined), false);
			assert.equal(isHostAbsoluteAgentSessionPath("/home/node/.bobbit/agent/sessions"), false);
			assert.equal(isHostAbsoluteAgentSessionPath("/home/node/.bobbit/agent/sessions/x.jsonl"), false);
			assert.equal(isHostAbsoluteAgentSessionPath("/bobbit-state/sessions/x.jsonl"), false);
		});

		it("is true for absolute host paths, including Linux /home/<user> and Windows drives", () => {
			assert.equal(isHostAbsoluteAgentSessionPath("/Users/aj/.bobbit/agent/sessions/x.jsonl"), true);
			// Linux host home dirs: the drifted copy container-classified all of
			// /home/, exempting these from the trusted-roots deletion constraint.
			assert.equal(isHostAbsoluteAgentSessionPath("/home/aj/.bobbit/agent/sessions/x.jsonl"), true);
			assert.equal(isHostAbsoluteAgentSessionPath("C:\\Users\\aj\\sessions\\x.jsonl"), true);
		});

		it("host-classifies /workspace and /root/.claude so the purge path constrains them", () => {
			// Host-classified → archived-worktree-manager's purge path routes them
			// through resolveSafeSessionsPath, which rejects out-of-root deletion
			// (clean skip instead of a raw host-side delete attempt).
			assert.equal(isHostAbsoluteAgentSessionPath("/workspace/x.jsonl"), true);
			assert.equal(isHostAbsoluteAgentSessionPath("/root/.claude/projects/p/x.jsonl"), true);
		});
	});
});
