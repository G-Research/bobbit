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

	it("keeps session proposal draft owner ids unchanged", () => {
		assert.equal(proposalDraftOwnerId({ kind: "session", sessionId: "session_123" }), "session_123");
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
			assert.match(proposalDraftOwnerId(owner), /^project-import-v1-[a-f0-9]{64}$/);
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

	it("keeps same-type drafts from separate import requests distinct", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-import-collision-"));
		const first = { kind: "project-import" as const, projectId: "project-123", importId: "import-123", requestId: "request-one" };
		const second = { ...first, requestId: "request-two" };
		const workspaces: unknown[] = [];
		const service = new ProposalSeedService({
			stateDir,
			sessionManager: {} as any,
			projectRegistry: { get: (id: string) => id === first.projectId ? { id, hidden: false } : undefined } as any,
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
			const firstResult = await service.seedFromDecision(first, "role", {
				name: "first-import-role", label: "First import role", prompt: "First draft.",
			});
			const secondResult = await service.seedFromDecision(second, "role", {
				name: "second-import-role", label: "Second import role", prompt: "Second draft.",
			});
			assert.equal(firstResult.ok, true);
			assert.equal(secondResult.ok, true);
			if (!firstResult.ok || !secondResult.ok) return;

			const firstDraftId = proposalDraftOwnerId(first);
			const secondDraftId = proposalDraftOwnerId(second);
			assert.equal(proposalDraftOwnerId({ ...first }), firstDraftId);
			assert.notEqual(firstDraftId, secondDraftId);
			assert.notEqual(firstDraftId, proposalDraftOwnerId({ ...first, projectId: "project-456" }));
			assert.equal(firstDraftId.length, "project-import-v1-".length + 64);
			assert.deepEqual(workspaces, [
				{ owner: first, draftId: firstDraftId, proposalType: "role", fields: firstResult.fields, rev: firstResult.rev },
				{ owner: second, draftId: secondDraftId, proposalType: "role", fields: secondResult.fields, rev: secondResult.rev },
			]);
			assert.deepEqual(await parseProposalFile(stateDir, firstDraftId, "role"), {
				ok: true,
				value: { type: "role", fields: { name: "first-import-role", label: "First import role", prompt: "First draft.", projectId: first.projectId } },
			});
			assert.deepEqual(await parseProposalFile(stateDir, secondDraftId, "role"), {
				ok: true,
				value: { type: "role", fields: { name: "second-import-role", label: "Second import role", prompt: "Second draft.", projectId: second.projectId } },
			});
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});
