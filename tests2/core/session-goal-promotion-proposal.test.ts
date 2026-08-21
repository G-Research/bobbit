import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { copyProposalDirIfPresent } from "../../src/server/agent/continue-archived.js";
import { resolveSessionGoalWorktreeMode } from "../../src/server/agent/session-goal-promotion.js";
import {
	editProposalFile,
	latestRev,
	parseProposalFile,
	proposalFilePath,
	readProposalFile,
	readSnapshot,
	restoreSnapshot,
	writeProposalFile,
} from "../../src/server/proposals/proposal-files.js";

const roots: string[] = [];

function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-goal-proposal-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session-goal promotion proposal mode", () => {
	it("keeps absent legacy drafts byte-compatible and defaults them to new-worktree", async () => {
		const stateDir = fixtureRoot();
		await writeProposalFile(stateDir, "legacy-owner", "goal", {
			title: "Legacy",
			spec: "Body.\n",
		});

		const raw = await readProposalFile(stateDir, "legacy-owner", "goal");
		assert.equal(raw, "---\ntitle: Legacy\n---\nBody.\n");
		const parsed = await parseProposalFile(stateDir, "legacy-owner", "goal");
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.fields.worktreeMode, undefined);
		assert.equal(resolveSessionGoalWorktreeMode(parsed.value.fields.worktreeMode), "new-worktree");
	});

	it("round-trips current-session through edits, reload, snapshots, and archived continuation copy", async () => {
		const stateDir = fixtureRoot();
		const sourceId = "proposal-owner";
		await writeProposalFile(stateDir, sourceId, "goal", {
			title: "Promote this session",
			spec: "Keep the existing checkout.\n",
			worktreeMode: "new-worktree",
		});
		const rev1 = await readSnapshot(stateDir, sourceId, "goal", 1);
		assert.match(rev1!, /worktreeMode: new-worktree/);

		const edited = await editProposalFile(
			stateDir,
			sourceId,
			"goal",
			"worktreeMode: new-worktree",
			"worktreeMode: current-session",
		);
		assert.equal(edited.ok, true, JSON.stringify(edited));
		assert.equal(await latestRev(stateDir, sourceId, "goal"), 2);

		const reloaded = await parseProposalFile(stateDir, sourceId, "goal");
		assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
		if (!reloaded.ok) return;
		assert.equal(reloaded.value.fields.worktreeMode, "current-session");

		const continuedId = "continued-owner";
		copyProposalDirIfPresent(sourceId, continuedId, stateDir);
		assert.equal(
			fs.readFileSync(proposalFilePath(stateDir, continuedId, "goal"), "utf8"),
			fs.readFileSync(proposalFilePath(stateDir, sourceId, "goal"), "utf8"),
		);
		const continued = await parseProposalFile(stateDir, continuedId, "goal");
		assert.equal(continued.ok, true, JSON.stringify(continued));
		if (continued.ok) assert.equal(continued.value.fields.worktreeMode, "current-session");

		const restored = await restoreSnapshot(stateDir, sourceId, "goal", 1);
		assert.equal(restored.ok, true, JSON.stringify(restored));
		if (restored.ok) assert.equal(restored.fields.worktreeMode, "new-worktree");
		const restoredRaw = await readProposalFile(stateDir, sourceId, "goal");
		assert.equal(restoredRaw, rev1);
	});

	it("rejects invalid worktree modes without changing the owning draft", async () => {
		const stateDir = fixtureRoot();
		const ownerId = "invalid-owner";
		await writeProposalFile(stateDir, ownerId, "goal", {
			title: "Valid goal",
			spec: "Body.\n",
			worktreeMode: "current-session",
		});
		const before = await readProposalFile(stateDir, ownerId, "goal");

		const edit = await editProposalFile(
			stateDir,
			ownerId,
			"goal",
			"worktreeMode: current-session",
			"worktreeMode: arbitrary-worktree",
		);
		assert.equal(edit.ok, false);
		if (!edit.ok) {
			assert.equal("code" in edit ? edit.code : undefined, "STRUCTURAL_VALIDATION_FAILED");
		}
		assert.equal(await readProposalFile(stateDir, ownerId, "goal"), before);
	});

	it("updates only the proposal owner's draft and never serializes coordinate authority", async () => {
		const stateDir = fixtureRoot();
		for (const sessionId of ["owner-a", "owner-b"]) {
			await writeProposalFile(stateDir, sessionId, "goal", {
				title: `Goal ${sessionId}`,
				spec: "Body.\n",
				worktreeMode: "new-worktree",
			});
		}
		const otherBefore = await readProposalFile(stateDir, "owner-b", "goal");

		await writeProposalFile(stateDir, "owner-a", "goal", {
			title: "Goal owner-a",
			spec: "Body.\n",
			worktreeMode: "current-session",
			promoteSessionId: "attacker-selected-session",
			worktreePath: "/attacker/worktree",
			branch: "attacker/branch",
			repoPath: "/attacker/repo",
			containerId: "attacker-container",
		});

		const ownerRaw = await readProposalFile(stateDir, "owner-a", "goal");
		assert.match(ownerRaw!, /worktreeMode: current-session/);
		for (const forbidden of ["promoteSessionId", "worktreePath", "branch", "repoPath", "containerId"]) {
			assert.doesNotMatch(ownerRaw!, new RegExp(forbidden));
		}
		assert.equal(await readProposalFile(stateDir, "owner-b", "goal"), otherBefore);
	});
});
