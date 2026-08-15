import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { DecisionRequestManager } from "../../src/server/agent/decision-request-manager.js";
import { DecisionRequestStore } from "../../src/server/agent/decision-request-store.js";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.js";
import {
	ProposalSeedService,
	proposalDraftOwnerId,
	type ProposalDraftOwner,
	type ProposalSeedServiceDeps,
} from "../../src/server/proposals/proposal-seed-service.js";
import { parseProposalFile } from "../../src/server/proposals/proposal-files.js";
import { createMemFs } from "../harness/mem-fs.js";

function proposalRequest(): ValidatedExtensionDecisionRequest {
	return {
		version: 1, key: "proposal", title: "Create draft", question: "Create a draft?",
		options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
		other: { maxLength: 20 }, default: { kind: "option", value: "no" }, scope: "goal",
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		effect: { kind: "proposal", proposals: {
			yes: { proposalType: "goal", args: { title: "Draft only" } },
			no: { proposalType: "goal", args: { title: "No draft" } },
			other: { proposalType: "goal", args: { title: "Other draft" } },
		} },
	};
}

describe("decision proposal routing", () => {
	it("creates only an editable proposal seed after the durable answer", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-proposal-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const calls: Array<{ owner: string | ProposalDraftOwner; type: string; args: Record<string, unknown> }> = [];
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store,
			proposalSeedService: {
				seedFromDecision: async (owner, type, args) => {
					calls.push({ owner, type, args });
					return { ok: true as const, status: 200 as const, rev: 4, fields: {} };
				},
			},
		});
		const created = await manager.create({ projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt", packId: "pack", hookId: "hook" }, proposalRequest());
		assert.equal(store.get(created.requestId!)?.proposal, undefined);
		await manager.answer("project", created.requestId!, { kind: "option", value: "yes" });
		assert.deepEqual(calls, [{ owner: "session", type: "goal", args: { title: "Draft only" } }]);
		assert.deepEqual(store.get(created.requestId!)?.proposal, { status: "created", type: "goal", rev: 4 });
	});

	it("preserves the answer when proposal draft creation fails", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-proposal-failure-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store,
			proposalSeedService: { seedFromDecision: async () => { throw new Error("isolated"); } },
		});
		const created = await manager.create({ projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt", packId: "pack", hookId: "hook" }, proposalRequest());
		const result = await manager.answer("project", created.requestId!, { kind: "option", value: "yes" });
		assert.equal(result.status, "resolved");
		assert.equal(store.get(created.requestId!)?.proposal?.status, "failed");
	});

	it("seeds a project-owned draft and projection without accessing a session", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-import-owner-"));
		const owner = { kind: "project-import" as const, projectId: "project-123", importId: "import-123", requestId: "request-123" };
		const workspaces: unknown[] = [];
		const noSessionAccess = () => { throw new Error("project-import must not access SessionManager"); };
		const service = new ProposalSeedService({
			stateDir,
			sessionManager: { getSession: noSessionAccess, getPersistedSession: noSessionAccess } as any,
			projectRegistry: { get: (id: string) => id === owner.projectId ? { id, hidden: false } : undefined } as any,
			projectContextManager: {} as any,
			configCascade: {} as any,
			getGoal: () => undefined,
			getPreference: () => undefined,
			systemProjectId: "system",
			headquartersProjectId: "headquarters",
			readBody: async () => ({}),
			openProjectImportProposalWorkspace: workspace => { workspaces.push(workspace); },
		} satisfies ProposalSeedServiceDeps);
		try {
			const result = await service.seedFromDecision(owner, "role", {
				name: "import-role", label: "Import role", prompt: "Only a draft.",
			});
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(proposalDraftOwnerId(owner), "project-import-import-123");
			assert.deepEqual(result.fields, {
				name: "import-role", label: "Import role", prompt: "Only a draft.", projectId: owner.projectId,
			});
			assert.deepEqual(await parseProposalFile(stateDir, proposalDraftOwnerId(owner), "role"), {
				ok: true, value: { type: "role", fields: result.fields },
			});
			assert.deepEqual(workspaces, [{
				owner, draftId: proposalDraftOwnerId(owner), proposalType: "role", fields: result.fields, rev: result.rev,
			}]);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});
