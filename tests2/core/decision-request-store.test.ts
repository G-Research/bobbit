import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
	DECISION_REQUEST_RETENTION_MS,
	DecisionRequestStore,
	type DecisionMemory,
	type StoredDecisionRequest,
} from "../../src/server/agent/decision-request-store.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let memfs: MemFs = createMemFs();
let sequence = 0;
const importFixtureRoot = path.resolve("memfs", "project-import-fixture");

function stateDir(label: string): string {
	const dir = path.resolve("/memfs/decision-request-store", `${label}-${sequence++}`);
	memfs.mkdirSync(dir, { recursive: true });
	return dir;
}

function request(id: string, overrides: Partial<StoredDecisionRequest> = {}): StoredDecisionRequest {
	return {
		id,
		projectId: "project-1",
		sessionId: "session-1",
		delivery: { kind: "session", sessionId: "session-1" },
		goalId: "goal-1",
		asker: { packId: "pack-1", hookId: "hook-1", event: "beforePrompt" },
		dedupeId: `dedupe-${id}`,
		questionId: `question-${id}`,
		request: {
			version: 1,
			key: "deployment",
			title: "Deploy?",
			question: "Which deployment target should be used?",
			options: [{ value: "safe", label: "Safe" }, { value: "fast", label: "Fast" }],
			other: { maxLength: 280 },
			default: { kind: "option", value: "safe" },
			scope: "goal",
			deadlineAt: "2026-01-01T00:01:00.000Z",
			effect: { kind: "none" },
		},
		status: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		deadlineAt: "2026-01-01T00:01:00.000Z",
		continuationState: "pending",
		continuationAttempts: 0,
		...overrides,
	};
}

function memory(overrides: Partial<DecisionMemory> = {}): DecisionMemory {
	return {
		scope: "goal",
		scopeId: "goal-1",
		packId: "pack-1",
		hookId: "hook-1",
		key: "deployment",
		value: { kind: "option", value: "safe" },
		validatedAt: "2026-01-01T00:01:00.000Z",
		sourceRequestId: "request-1",
		...overrides,
	};
}

function consentRequest(id: string): StoredDecisionRequest {
	const pending = request(id);
	const { default: _default, ...requestWithoutDefault } = pending.request;
	return {
		...pending,
		request: { ...requestWithoutDefault, requestedClass: "consent-required" },
		decisionClass: "consent-required",
		classificationReason: "core-unsafe-tool",
		protectedOperation: { id: "operation-1", kind: "tool-call" },
		timeoutAction: "pause-goal",
	};
}

function pause(id: string) {
	return {
		goalId: "goal-1",
		reason: { kind: "awaiting-extension-consent" as const, requestId: id, createdAt: "2026-01-01T00:02:00.000Z" },
	};
}

function inbox() {
	return {
		sourceKey: "consent-pause:project-1:request-1",
		status: "pending" as const,
		updatedAt: "2026-01-01T00:02:00.000Z",
	};
}

describe("DecisionRequestStore", () => {
	it("migrates schema-1 session records to an explicit session delivery", () => {
		const dir = stateDir("schema-1");
		const legacy = request("legacy");
		const { delivery: _delivery, ...v1Request } = legacy;
		memfs.writeFileSync(path.join(dir, "extension-decision-requests.json"), JSON.stringify({
			version: 1, requests: { legacy: v1Request }, memories: {},
		}), "utf-8");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.isHealthy(), true);
		assert.deepEqual(store.get("legacy")?.delivery, { kind: "session", sessionId: "session-1" });
		assert.equal(store.get("legacy")?.sessionId, "session-1");
	});

	it("atomically persists requests and exact scoped memories across restart", () => {
		const dir = stateDir("round-trip");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.put(request("request-1")), true);
		const result = store.writeTerminalFirst("request-1", {
			status: "resolved",
			resolvedAt: "2026-01-01T00:01:00.000Z",
			resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" },
		}, memory());
		assert.equal(result.written, true);

		const restarted = new DecisionRequestStore(dir, memfs);
		assert.equal(restarted.isHealthy(), true);
		assert.equal(restarted.get("request-1")?.status, "resolved");
		assert.deepEqual(restarted.getMemory(memory()), memory());
	});

	it.each(["accepted", "rejected"] as const)("restores a %s import proposal decision after restart", (status) => {
		const dir = stateDir(`proposal-${status}`);
		const store = new DecisionRequestStore(dir, memfs);
		const imported = request("request-1", {
			sessionId: undefined,
			goalId: undefined,
			delivery: { kind: "project-import", importId: "import-1" },
			asker: { packId: "pack-1", hookId: "hook-1", event: "projectImported" },
			request: { ...request("seed").request, scope: "project" },
		});
		assert.equal(store.put(imported), true);
		assert.equal(store.writeTerminalFirst("request-1", {
			status: "resolved",
			resolvedAt: "2026-01-01T00:01:00.000Z",
			resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" },
		}).written, true);
		assert.equal(store.updateProposal("request-1", { status: "created", type: "role", rev: 1 }), true);
		const application = { projectId: "project-1", importId: "import-1", requestId: "request-1", type: "role" as const, rev: 1, snapshotSha256: "a".repeat(64), key: `import-proposal-v1:${"b".repeat(64)}` };
		if (status === "accepted") {
			assert.equal(store.claimImportProposal(application, "2026-01-01T00:02:00.000Z").claimed, true);
			assert.equal(store.finalizeImportProposal(application, "2026-01-01T00:03:00.000Z"), true);
		} else {
			assert.equal(store.updateProposal("request-1", { status: "rejected", type: "role", rev: 1, decidedAt: "2026-01-01T00:02:00.000Z" }), true);
		}

		const restarted = new DecisionRequestStore(dir, memfs);
		assert.equal(restarted.isHealthy(), true);
		assert.equal(restarted.get("request-1")?.proposal?.status, status);
	});

	it("claims and finalizes exactly one immutable import proposal application", () => {
		const dir = stateDir("proposal-claim");
		const store = new DecisionRequestStore(dir, memfs);
		const imported = request("request-1", {
			projectId: "project-1", sessionId: undefined, goalId: undefined,
			delivery: { kind: "project-import", importId: "import-1" },
			asker: { packId: "pack-1", hookId: "hook-1", event: "projectImported" },
			request: { ...request("seed").request, scope: "project" },
		});
		assert.equal(store.put(imported), true);
		assert.equal(store.writeTerminalFirst("request-1", { status: "resolved", resolvedAt: "2026-01-01T00:01:00.000Z", resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" } }).written, true);
		assert.equal(store.updateProposal("request-1", { status: "created", type: "role", rev: 1 }), true);
		const application = { projectId: "project-1", importId: "import-1", requestId: "request-1", type: "role" as const, rev: 1, snapshotSha256: "a".repeat(64), key: `import-proposal-v1:${"b".repeat(64)}` };
		assert.equal(store.claimImportProposal(application, "2026-01-01T00:02:00.000Z").claimed, true);
		assert.equal(store.claimImportProposal(application, "2026-01-01T00:02:01.000Z").claimed, false);
		assert.equal(store.updateProposal("request-1", { status: "rejected", type: "role", rev: 1, decidedAt: "2026-01-01T00:02:01.000Z" }), false);
		// A deterministic pre-effect failure releases only its exact durable claim.
		assert.equal(store.releaseImportProposal({ ...application, key: `import-proposal-v1:${"c".repeat(64)}` }), false);
		assert.equal(store.releaseImportProposal(application), true);
		assert.equal(store.get("request-1")?.proposal?.status, "created");
		assert.equal(store.claimImportProposal(application, "2026-01-01T00:02:02.000Z").claimed, true);
		assert.equal(store.finalizeImportProposal(application, "2026-01-01T00:03:00.000Z", { role: "imported" }), true);
		assert.equal(store.markImportProposalAudited("request-1", application, "2026-01-01T00:03:01.000Z"), true);
		assert.equal(store.markImportProposalAudited("request-1", application, "2026-01-01T00:03:02.000Z"), false);
		const restarted = new DecisionRequestStore(dir, memfs);
		const restartedProposal = restarted.get("request-1")?.proposal;
		assert.ok(restartedProposal?.status === "accepted");
		assert.equal(restartedProposal.auditedAt, "2026-01-01T00:03:01.000Z", "restart replay observes the durable audit fence");
		assert.deepEqual(restarted.listApplyingImportProposals("import-1"), []);
	});

	it("fails closed on malformed tagged proposal states", () => {
		const malformed = [
			{ status: "created", type: "role" },
			{ status: "created", type: "role", rev: 1, decidedAt: "2026-01-01T00:02:00.000Z" },
			{ status: "failed", type: "role" },
			{ status: "failed", type: "role", code: "PROPOSAL_SEED_FAILED", decidedAt: "2026-01-01T00:02:00.000Z" },
			{ status: "accepted", type: "role", rev: 0, decidedAt: "2026-01-01T00:02:00.000Z" },
			{ status: "rejected", type: "role", rev: 1, decidedAt: "not-an-instant", code: "PROPOSAL_SEED_FAILED" },
		];
		for (const proposal of malformed) {
			const dir = stateDir("malformed-proposal");
			const store = new DecisionRequestStore(dir, memfs);
			assert.equal(store.put(request("request-1", { status: "resolved", resolvedAt: "2026-01-01T00:01:00.000Z" })), true);
			const file = path.join(dir, "extension-decision-requests.json");
			const snapshot = JSON.parse(memfs.readFileSync(file, "utf-8"));
			snapshot.requests["request-1"].proposal = proposal;
			memfs.writeFileSync(file, JSON.stringify(snapshot), "utf-8");
			assert.equal(new DecisionRequestStore(dir, memfs).isHealthy(), false);
		}
	});

	it("persists immutable import runs and completes each hook once", () => {
		const store = new DecisionRequestStore(stateDir("import-run"), memfs);
		const run = {
			id: "import-1", projectId: "project-1", createdAt: "2026-01-01T00:00:00.000Z",
			context: {
				event: "projectImported" as const, projectId: "project-1", importId: "import-1",
				projectRoot: importFixtureRoot, ownedRoots: [importFixtureRoot, path.join(importFixtureRoot, "api")],
				components: [{ id: "component-1", root: path.join(importFixtureRoot, "api"), languages: ["typescript"] }],
			},
			hooks: { "pack-1:hook-1": { state: "pending" as const } },
		};
		assert.equal(store.ensureImportRun(run)?.created, true);
		assert.equal(store.ensureImportRun(run)?.created, false);
		assert.equal(store.ensureImportRun({ ...run, context: { ...run.context, projectRoot: path.resolve("memfs", "other-project") } }), undefined);
		assert.equal(store.completeImportHook("import-1", "pack-1:hook-1", "applied", "2026-01-01T00:01:00.000Z"), true);
		assert.equal(store.completeImportHook("import-1", "pack-1:hook-1", "error", "2026-01-01T00:02:00.000Z"), false);
		assert.equal(store.getImportRun("import-1")?.completedAt, "2026-01-01T00:01:00.000Z");
	});

	it("fails closed at load for a forged import context but restores an exact snapshot", () => {
		const dir = stateDir("import-load-validation");
		const run = {
			id: "import-1", projectId: "project-1", createdAt: "2026-01-01T00:00:00.000Z", hooks: {},
			context: {
				event: "projectImported" as const, projectId: "project-1", importId: "import-1", projectRoot: importFixtureRoot,
				ownedRoots: [importFixtureRoot, path.join(importFixtureRoot, "api")],
				components: [{ id: "component-1", root: path.join(importFixtureRoot, "api"), languages: ["typescript"] }],
			},
		};
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.ensureImportRun(run)?.created, true);
		assert.equal(new DecisionRequestStore(dir, memfs).isHealthy(), true);

		const file = path.join(dir, "extension-decision-requests.json");
		const forged = JSON.parse(memfs.readFileSync(file, "utf-8"));
		forged.importRuns["import-1"].context.ownedRoots = [importFixtureRoot, `${importFixtureRoot}-escape`];
		memfs.writeFileSync(file, JSON.stringify(forged), "utf-8");
		assert.equal(new DecisionRequestStore(dir, memfs).isHealthy(), false);
	});

	it("persists a consent pause once, excludes it from retention, and CASes exact resume", () => {
		const dir = stateDir("consent-pause");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.put(consentRequest("request-1")), true);
		const initial = store.writeConsentPauseFirst("request-1", {
			pausedAt: "2026-01-01T00:02:00.000Z", pause: pause("request-1"), inbox: inbox(),
		});
		assert.equal(initial.written, true);
		assert.equal(store.writeConsentPauseFirst("request-1", {
			pausedAt: "2026-01-01T00:03:00.000Z", pause: pause("request-1"), inbox: inbox(),
		}).written, false);
		assert.equal(store.pruneTerminalRequests(Date.parse("2026-03-01T00:00:00.000Z")), 0);

		const differentPause = { ...pause("request-1"), reason: { ...pause("request-1").reason, createdAt: "2026-01-01T00:02:01.000Z" } };
		assert.equal(store.claimConsentResume("request-1", { pause: differentPause, claimedAt: "2026-01-01T00:03:00.000Z", value: { kind: "option", value: "safe" } }).claimed, false);
		assert.equal(store.claimConsentResume("request-1", { pause: pause("request-1"), claimedAt: "2026-01-01T00:03:00.000Z", value: { kind: "option", value: "safe" } }).claimed, true);
		assert.equal(store.claimConsentResume("request-1", { pause: pause("request-1"), claimedAt: "2026-01-01T00:03:01.000Z", value: { kind: "option", value: "safe" } }).claimed, false);
		assert.equal(store.completeConsentResume("request-1", {
			pause: pause("request-1"), completedAt: "2026-01-01T00:04:00.000Z", outcome: "resumed",
			terminal: { status: "resolved", resolvedAt: "2026-01-01T00:04:00.000Z", resolution: { value: { kind: "option", value: "forged" }, actor: "user", reason: "answered" } },
		}).completed, false);
		assert.equal(store.get("request-1")?.status, "paused-awaiting-consent");
		assert.equal(store.get("request-1")?.consentPause?.resume?.status, "claimed");
		assert.equal(store.completeConsentResume("request-1", {
			pause: pause("request-1"), completedAt: "2026-01-01T00:04:00.000Z", outcome: "resumed",
			terminal: { status: "resolved", resolvedAt: "2026-01-01T00:04:00.000Z", resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" } },
		}).completed, true);
		assert.equal(store.get("request-1")?.status, "resolved");
	});

	it("fails closed at load for a claimed consent value outside its request", () => {
		const dir = stateDir("forged-claimed-consent");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.put(consentRequest("request-1")), true);
		assert.equal(store.writeConsentPauseFirst("request-1", {
			pausedAt: "2026-01-01T00:02:00.000Z", pause: pause("request-1"), inbox: inbox(),
		}).written, true);
		assert.equal(store.claimConsentResume("request-1", {
			pause: pause("request-1"), claimedAt: "2026-01-01T00:03:00.000Z", value: { kind: "option", value: "safe" },
		}).claimed, true);
		const file = path.join(dir, "extension-decision-requests.json");
		const snapshot = JSON.parse(memfs.readFileSync(file, "utf-8"));
		snapshot.requests["request-1"].consentPause.resume.value = { kind: "option", value: "forged" };
		memfs.writeFileSync(file, JSON.stringify(snapshot), "utf-8");

		const restarted = new DecisionRequestStore(dir, memfs);
		assert.equal(restarted.isHealthy(), false);
		assert.deepEqual(restarted.list(), []);
	});

	it("fails closed on a non-matching consent resume and source-key updates remain deduplicated", () => {
		const store = new DecisionRequestStore(stateDir("consent-non-matching"), memfs);
		assert.equal(store.put(consentRequest("request-1")), true);
		store.writeConsentPauseFirst("request-1", { pausedAt: "2026-01-01T00:02:00.000Z", pause: pause("request-1"), inbox: inbox() });
		assert.equal(store.claimConsentResume("request-1", { pause: pause("request-1"), claimedAt: "2026-01-01T00:03:00.000Z", value: { kind: "option", value: "safe" } }).claimed, true);
		assert.equal(store.completeConsentResume("request-1", {
			pause: pause("request-1"), completedAt: "2026-01-01T00:04:00.000Z", outcome: "not-matching",
			terminal: { status: "denied", resolvedAt: "2026-01-01T00:04:00.000Z" },
		}).completed, true);
		assert.equal(store.get("request-1")?.status, "denied");
		assert.equal(store.updateConsentInboxSurface("request-1", "consent-pause:project-1:request-1", {
			status: "surfaced", entryId: "inbox-1", updatedAt: "2026-01-01T00:04:00.000Z",
		}), true);
		assert.equal(store.updateConsentInboxSurface("request-1", "different-source", {
			status: "cancelled", updatedAt: "2026-01-01T00:05:00.000Z",
		}), false);
		assert.equal(store.get("request-1")?.consentInbox?.entryId, "inbox-1");
	});

	it("keeps terminal deferrable dedupe while exposing only active consent duplicates", () => {
		const store = new DecisionRequestStore(stateDir("active-consent-dedupe"), memfs);
		const terminalConsent = consentRequest("consent-terminal");
		terminalConsent.dedupeId = "same-consent";
		const activeConsent = consentRequest("consent-active");
		activeConsent.dedupeId = "same-consent";
		const deferrable = request("deferrable-terminal", { dedupeId: "same-deferrable" });
		assert.equal(store.put(terminalConsent), true);
		assert.equal(store.writeTerminalFirst("consent-terminal", { status: "denied", resolvedAt: "2026-01-01T00:01:00.000Z" }).written, true);
		assert.equal(store.put(activeConsent), true);
		assert.equal(store.put(deferrable), true);
		assert.equal(store.writeTerminalFirst("deferrable-terminal", { status: "defaulted", resolvedAt: "2026-01-01T00:01:00.000Z", resolution: { value: { kind: "option", value: "safe" }, actor: "deadline", reason: "deadline_elapsed" } }).written, true);
		assert.equal(store.findActiveByDedupeId("same-consent")?.id, "consent-active");
		assert.equal(store.findByDedupeId("same-deferrable")?.id, "deferrable-terminal");
	});

	it("refuses a consent record with a persisted default but accepts a stripped forced elevation", () => {
		const store = new DecisionRequestStore(stateDir("consent-default"), memfs);
		const invalid = consentRequest("request-1");
		invalid.request.default = { kind: "option", value: "safe" };
		assert.equal(store.put(invalid), false);

		const forced = consentRequest("request-2");
		forced.request.requestedClass = "deferrable";
		assert.equal(store.put(forced), true);
	});

	it("returns defensive copies for requests and memories", () => {
		const store = new DecisionRequestStore(stateDir("copies"), memfs);
		store.put(request("request-1"));
		store.putMemory(memory());
		const copy = store.get("request-1")!;
		copy.request.options[0].label = "mutated";
		copy.asker.packId = "mutated";
		const storedMemory = store.getMemory(memory())!;
		storedMemory.value = { kind: "other", text: "mutated" };
		assert.equal(store.get("request-1")!.request.options[0].label, "Safe");
		assert.equal(store.get("request-1")!.asker.packId, "pack-1");
		assert.deepEqual(store.getMemory(memory())!.value, { kind: "option", value: "safe" });
	});

	it("does not cross session, goal, project, pack, hook, or key memory identities", () => {
		const store = new DecisionRequestStore(stateDir("scope"), memfs);
		store.putMemory(memory());
		for (const isolated of [
			memory({ scope: "session", scopeId: "session-1" }),
			memory({ scopeId: "goal-2" }),
			memory({ scope: "project", scopeId: "project-1" }),
			memory({ packId: "pack-2" }),
			memory({ hookId: "hook-2" }),
			memory({ key: "other-key" }),
		]) assert.equal(store.getMemory(isolated), undefined);
		assert.deepEqual(store.getMemory(memory()), memory());
	});

	it("serializes terminal writes: the first terminal answer and memory win", () => {
		const store = new DecisionRequestStore(stateDir("first-terminal"), memfs);
		store.put(request("request-1"));
		const first = store.writeTerminalFirst("request-1", {
			status: "resolved",
			resolvedAt: "2026-01-01T00:01:00.000Z",
			resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" },
		}, memory());
		const second = store.writeTerminalFirst("request-1", {
			status: "expired",
			resolvedAt: "2026-01-01T00:02:00.000Z",
			resolution: { value: { kind: "option", value: "fast" }, actor: "deadline", reason: "deadline_elapsed" },
		}, memory({ value: { kind: "option", value: "fast" } }));
		assert.equal(first.written, true);
		assert.equal(second.written, false);
		assert.equal(second.request?.resolution?.value.kind, "option");
		assert.equal((second.request?.resolution?.value as { value: string }).value, "safe");
		assert.deepEqual(store.getMemory(memory())!.value, { kind: "option", value: "safe" });
	});

	it("retains pending requests, prunes old terminal records, and preserves memories", () => {
		const store = new DecisionRequestStore(stateDir("retention"), memfs);
		const now = Date.parse("2026-02-01T00:00:00.000Z");
		store.put(request("old", { status: "resolved", resolvedAt: new Date(now - DECISION_REQUEST_RETENTION_MS - 1).toISOString() }));
		store.put(request("recent", { status: "resolved", resolvedAt: new Date(now - DECISION_REQUEST_RETENTION_MS).toISOString() }));
		store.put(request("pending"));
		store.putMemory(memory({ sourceRequestId: "old" }));
		assert.equal(store.pruneTerminalRequests(now), 1);
		assert.equal(store.get("old"), undefined);
		assert.ok(store.get("recent"));
		assert.ok(store.get("pending"));
		assert.ok(store.getMemory(memory({ sourceRequestId: "old" })));
	});

	it("fails closed on persisted requests that violate the shared decision contract", () => {
		const corruptions: Array<{ name: string; mutate: (snapshot: any) => void }> = [
			{ name: "default outside options", mutate: state => { state.requests["request-1"].request.default = { kind: "option", value: "forged" }; } },
			{ name: "malformed other schema", mutate: state => { state.requests["request-1"].request.other = { maxLength: 280, unexpected: true }; } },
			{ name: "unsafe other regex", mutate: state => { state.requests["request-1"].request.other.pattern = "^(a+)+$"; } },
			{ name: "inverted other bounds", mutate: state => { state.requests["request-1"].request.other = { minLength: 9, maxLength: 4 }; } },
			{ name: "incomplete proposal effect partition", mutate: state => {
				state.requests["request-1"].request.effect = { kind: "proposal", proposals: {
					safe: { proposalType: "goal", args: { title: "Safe" } },
					fast: { proposalType: "goal", args: { title: "Fast" } },
				} };
			} },
			{ name: "resolution outside request controls", mutate: state => {
				state.requests["request-1"].status = "resolved";
				state.requests["request-1"].resolvedAt = "2026-01-01T00:01:00.000Z";
				state.requests["request-1"].resolution = { value: { kind: "option", value: "forged" }, actor: "user", reason: "answered" };
			} },
			{ name: "resolution other violating regex", mutate: state => {
				state.requests["request-1"].request.other.pattern = "^[A-Z]+$";
				state.requests["request-1"].status = "resolved";
				state.requests["request-1"].resolvedAt = "2026-01-01T00:01:00.000Z";
				state.requests["request-1"].resolution = { value: { kind: "other", text: "lowercase" }, actor: "user", reason: "answered" };
			} },
		];
		for (const { name, mutate } of corruptions) {
			const dir = stateDir(`strict-replay-${name}`);
			const store = new DecisionRequestStore(dir, memfs);
			assert.equal(store.put(request("request-1")), true);
			const file = path.join(dir, "extension-decision-requests.json");
			const snapshot = JSON.parse(memfs.readFileSync(file, "utf-8"));
			mutate(snapshot);
			memfs.writeFileSync(file, JSON.stringify(snapshot), "utf-8");
			const restarted = new DecisionRequestStore(dir, memfs);
			assert.equal(restarted.isHealthy(), false, name);
			assert.deepEqual(restarted.list(), [], `${name} must not partially load a request`);
		}
	});

	it("fails closed on corrupt state without changing unrelated project state", () => {
		const dir = stateDir("corrupt");
		const file = path.join(dir, "extension-decision-requests.json");
		memfs.writeFileSync(file, "not-json", "utf-8");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.isHealthy(), false);
		assert.equal(store.list().length, 0);
		assert.equal(store.put(request("request-1")), false);
		assert.equal(memfs.readFileSync(file, "utf-8"), "not-json");
	});

	it("keeps the old in-memory and disk snapshot when atomic publication fails", () => {
		const dir = stateDir("atomic-failure");
		const store = new DecisionRequestStore(dir, memfs);
		store.put(request("request-1"));
		const file = path.join(dir, "extension-decision-requests.json");
		const before = memfs.readFileSync(file, "utf-8");
		const rename = memfs.renameSync.bind(memfs);
		(memfs as any).renameSync = () => { throw new Error("rename failed"); };
		try {
			assert.equal(store.put(request("request-2")), false);
		} finally {
			(memfs as any).renameSync = rename;
		}
		assert.equal(store.get("request-2"), undefined);
		assert.equal(memfs.readFileSync(file, "utf-8"), before);
	});
});
