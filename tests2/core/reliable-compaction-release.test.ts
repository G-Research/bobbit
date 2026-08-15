import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initAuthorSidecarDir,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import {
	barrier,
	flushMicrotasks,
	makeReliableIntentHarness,
	type ReliableIntentHarness,
} from "./helpers/reliable-intent-fixture.js";

const harnesses: ReliableIntentHarness[] = [];
let authorStateDir = "";
const useHarness = (overrides: Record<string, any> = {}) => {
	const harness = makeReliableIntentHarness(overrides);
	harnesses.push(harness);
	return harness;
};

beforeEach(() => {
	authorStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reliable-compaction-release-"));
	initAuthorSidecarDir(authorStateDir, {
		secretsDir: path.join(authorStateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x52),
	});
});

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	fs.rmSync(authorStateDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function compactionEnd(reason: "manual" | "threshold" | "overflow", overrides: Record<string, unknown> = {}) {
	return {
		type: "compaction_end",
		reason,
		aborted: false,
		willRetry: reason !== "manual",
		result: {
			summary: `${reason} summary`,
			firstKeptEntryId: `${reason}-kept`,
			tokensBefore: 10_000,
		},
		...overrides,
	};
}

function successfulTerminal(manager: any, session: any): void {
	manager.handleAgentLifecycle(session, {
		type: "message_end",
		message: { id: `assistant-${session.completedTurnCount ?? 0}`, role: "assistant", stopReason: "stop", content: "done" },
	});
	manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
}

describe("reliable compaction admission fences", () => {
	it("manual compaction accepts prompt and steer visibly but performs zero RPC until completion", async () => {
		const { manager, session, prompt, steer } = useHarness({ status: "idle" });
		manager.handleAgentLifecycle(session, { type: "compaction_start", reason: "manual", compactionId: "compact-manual" });

		const promptAdmission = manager.enqueuePrompt(session.id, "P1 during manual", { intentId: "P1" });
		const steerAdmission = manager.deliverLiveSteer(session.id, "S1 during manual", { intentId: "S1" });
		await Promise.all([promptAdmission, steerAdmission]);

		expect(
			prompt,
			"RELIABLE_COMPACTION_FENCE_BROKEN: prompt RPC ran before compaction_end",
		).not.toHaveBeenCalled();
		expect(
			steer,
			"RELIABLE_COMPACTION_FENCE_BROKEN: steer RPC ran before compaction_end",
		).not.toHaveBeenCalled();
		expect(session.promptQueue.toArray()).toMatchObject([
			{ id: "P1", kind: "prompt", targetTurn: "next-turn", deliveryState: "queued" },
			{ id: "S1", kind: "steer", targetTurn: "next-turn", deliveryState: "queued" },
		]);

		const end = compactionEnd("manual");
		manager.handleAgentLifecycle(session, end);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("P1 during manual");
		expect(steer).not.toHaveBeenCalled();

		successfulTerminal(manager, session);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(prompt.mock.calls[1]?.[0]).toBe("S1 during manual");
	});

	it.each(["threshold", "overflow"] as const)(
		"%s compaction releases only continuation steers and waits for final turn end before prompts",
		async (reason) => {
			const { manager, session, prompt, steer } = useHarness({ status: "streaming" });
			manager.handleAgentLifecycle(session, { type: "compaction_start", reason });
			const compactionId = session._pendingCompactionStart?.compactionId;

			await manager.enqueuePrompt(session.id, "P1 next turn", { intentId: "P1" });
			await manager.deliverLiveSteer(session.id, "S1 continuation", { intentId: "S1" });
			await manager.enqueuePrompt(session.id, "P2 next turn", { intentId: "P2" });

			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(session.promptQueue.toArray()).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "P1", targetTurn: "next-turn" }),
				expect.objectContaining({ id: "S1", targetTurn: "continuation" }),
				expect.objectContaining({ id: "P2", targetTurn: "next-turn" }),
			]));

			const end: any = compactionEnd(reason);
			manager.handleAgentLifecycle(session, end);
			await flushMicrotasks();

			expect(end.compactionId).toBe(compactionId);
			expect(steer).toHaveBeenCalledTimes(1);
			expect(steer.mock.calls[0]?.[0]).toBe("S1 continuation");
			expect(prompt).not.toHaveBeenCalled();
			expect(session.promptQueue.toArray().map((row: any) => row.id)).toEqual(["P1", "P2"]);

			successfulTerminal(manager, session);
			await flushMicrotasks();
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(prompt.mock.calls[0]?.[0]).toBe("P1 next turn");
			expect(session.promptQueue.toArray().map((row: any) => row.id)).toEqual(["P2"]);
		},
	);
});

describe("post-terminal reliable drain settlement", () => {
	it("waits through post-agent compaction and dispatches next-turn work only after agent_settled", async () => {
		const promptRpc = barrier<any>();
		const prompt = vi.fn(() => promptRpc.hold());
		const { manager, session, steer, storeUpdates } = useHarness({
			id: "post-terminal-settled-drain",
			status: "streaming",
			prompt,
		});

		manager.handleAgentLifecycle(session, { type: "agent_start" });

		// Prove that the preceding same-run steer is not a stale carrier: Pi echoes
		// it and the exact attempt settles in the fsynced author sidecar.
		await manager.deliverLiveSteer(session.id, "prior live steer", { intentId: "steer-before-terminal" });
		await flushMicrotasks();
		expect(steer).toHaveBeenCalledTimes(1);
		const piSteerText = steer.mock.calls[0]![0];
		for (const type of ["message_start", "message_end"] as const) {
			const event = manager.prepareVisibleAgentEvent(session, {
				type,
				message: { id: "pi-user-steer-before-terminal", role: "user", content: piSteerText, timestamp: 1_700_000_000_010 },
			});
			manager.handleAgentLifecycle(session, event);
		}
		const settledSteer = readAuthorSidecar(session.id).find((row) => row.intentId === "steer-before-terminal");
		expect(settledSteer?.settlement?.outcome).toBe("echoed");
		expect(promptAuthorBindingMatchesText(settledSteer!, piSteerText)).toBe(true);
		expect(session.inFlightSteerTexts).toEqual([]);

		await manager.enqueuePrompt(session.id, "queued after current turn", { intentId: "prompt-after-turn" });
		expect(session.promptQueue.toArray()).toMatchObject([{
			id: "prompt-after-turn",
			kind: "prompt",
			targetTurn: "next-turn",
			deliveryState: "queued",
		}]);

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "assistant-final", role: "assistant", stopReason: "stop", content: "done" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		await flushMicrotasks();

		// agent_end is user-visible terminal bookkeeping, but Pi's run remains active.
		expect(session.completedTurnCount).toBe(1);
		expect(session.status).toBe("idle");
		expect(prompt, "POST_TERMINAL_PROMPT_DISPATCHED_BEFORE_PI_SETTLED").not.toHaveBeenCalled();
		expect(session.promptQueue.toArray().map((row: any) => row.id)).toEqual(["prompt-after-turn"]);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(storeUpdates.at(-1)).toMatchObject({ wasStreaming: false, streamingStartedAt: undefined });

		manager.handleAgentLifecycle(session, {
			type: "compaction_start",
			reason: "threshold",
			compactionId: "compact-post-terminal",
		});
		manager.handleAgentLifecycle(session, compactionEnd("threshold", {
			compactionId: "compact-post-terminal",
			willRetry: false,
		}));
		await flushMicrotasks();
		expect(session.isCompacting).toBe(false);
		expect(prompt, "POST_COMPACTION_PROMPT_DISPATCHED_BEFORE_PI_SETTLED").not.toHaveBeenCalled();

		manager.handleAgentLifecycle(session, { type: "agent_settled" });
		await promptRpc.entered;
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(session.status).toBe("streaming");
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(session.inFlightSteerTexts).toMatchObject([{ intentId: "prompt-after-turn", state: "dispatching" }]);

		// The next real Pi turn correlates and settles the exact occurrence normally.
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		const piPromptText = (prompt.mock.calls as any[][])[0]![0];
		for (const type of ["message_start", "message_end"] as const) {
			const event = manager.prepareVisibleAgentEvent(session, {
				type,
				message: { id: "pi-user-prompt-after-turn", role: "user", content: piPromptText, timestamp: 1_700_000_000_020 },
			});
			manager.handleAgentLifecycle(session, event);
		}
		promptRpc.release({ success: true });
		await flushMicrotasks();
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(readAuthorSidecar(session.id).find((row) => row.intentId === "prompt-after-turn")?.settlement?.outcome)
			.toBe("echoed");
	});

	it.each([
		{ label: "stable occurrence", intentId: "post-error-follow-up" },
		{ label: "legacy occurrence", intentId: undefined },
	])("fences a $label accepted after error agent_end until agent_settled", async ({ intentId }) => {
		const prompt = vi.fn(async () => ({ success: true }));
		const { manager, session } = useHarness({
			id: `post-error-settlement-${intentId ?? "legacy"}`,
			status: "streaming",
			prompt,
		});
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "assistant-error", role: "assistant", stopReason: "error", errorMessage: "terminal model failure" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });

		await manager.enqueuePrompt(session.id, "recover after error", intentId ? { intentId } : undefined);
		await flushMicrotasks();
		expect(prompt, "POST_ERROR_PROMPT_DISPATCHED_BEFORE_PI_SETTLED").not.toHaveBeenCalled();
		expect(session.promptQueue.toArray()).toHaveLength(1);
		expect(session.promptQueue.peek()?.text).toContain("recover after error");
		expect(session.lastTurnErrored).toBe(false);

		manager.handleAgentLifecycle(session, { type: "agent_settled" });
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(session.promptQueue.toArray()).toEqual([]);
	});

	it("rolls every status plane back to idle after a definite no-start rejection", async () => {
		const prompt = vi.fn(async () => ({ success: false, error: "Agent is already processing." }));
		const { manager, session, storeUpdates } = useHarness({
			id: "definite-prompt-rejection-rollback",
			status: "idle",
			prompt,
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await manager.enqueuePrompt(session.id, "rejected occurrence", { intentId: "rejected-prompt" });
		await flushMicrotasks();

		expect(session.promptQueue.toArray()).toMatchObject([{
			id: "rejected-prompt",
			deliveryState: "failed",
			retryable: true,
			deliveryError: "bridge-rejected",
		}]);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(readAuthorSidecar(session.id).find((row) => row.intentId === "rejected-prompt")?.settlement?.outcome)
			.toBe("cancelled");
		expect(session.status, "POST_TERMINAL_REJECTION_LEFT_FALSE_STREAMING_STATUS").toBe("idle");
		expect(session.streamingStartedAt).toBeUndefined();
		expect(storeUpdates.filter((update) => update.wasStreaming === false).at(-1))
			.toMatchObject({ wasStreaming: false, streamingStartedAt: undefined });
	});
});

describe("failed automatic compaction release", () => {
	it.each([
		{ reason: "threshold" as const, willRetry: false, failure: { error: "fixture threshold failure", result: undefined } },
		{ reason: "overflow" as const, willRetry: true, failure: { success: false, errorMessage: "fixture overflow failure", result: undefined } },
	])("retains a $reason continuation until the final safe turn boundary", async ({ reason, willRetry, failure }) => {
		const { manager, session, prompt, steer } = useHarness({ status: "streaming" });
		manager.handleAgentLifecycle(session, { type: "compaction_start", reason });
		const compactionId = session._pendingCompactionStart?.compactionId;
		await manager.deliverLiveSteer(session.id, `${reason} continuation`, { intentId: `S-failed-${reason}` });

		const end: any = compactionEnd(reason, { ...failure, willRetry });
		manager.handleAgentLifecycle(session, end);
		manager.handleAgentLifecycle(session, { ...end });
		await flushMicrotasks();

		expect(session._reliableFinishedCompactionIds).toContain(compactionId);
		expect(steer, "failed compaction must not release continuation back into the interrupted turn").not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(session.isCompacting).toBe(false);
		expect(session.promptQueue.toArray()).toMatchObject([{
			id: `S-failed-${reason}`,
			kind: "steer",
			targetTurn: "continuation",
			deliveryState: "queued",
		}]);

		successfulTerminal(manager, session);
		await flushMicrotasks();
		expect(steer).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe(`${reason} continuation`);
		expect(session.promptQueue.toArray()).toEqual([]);
	});
});

describe("Pi compaction-active proven-no-start restoration", () => {
	const rejection = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

	it.each([
		{ kind: "prompt" as const, mode: "response" as const, reason: "manual" as const },
		{ kind: "prompt" as const, mode: "throw" as const, reason: "manual" as const },
		{ kind: "steer" as const, mode: "response" as const, reason: "threshold" as const },
		{ kind: "steer" as const, mode: "throw" as const, reason: "threshold" as const },
	])("restores a $kind after canonical $mode rejection and releases it only at $reason end", async ({ kind, mode, reason }) => {
		const rpc = vi.fn();
		if (mode === "response") rpc.mockResolvedValueOnce({ success: false, error: rejection });
		else rpc.mockRejectedValueOnce(new Error(rejection));
		rpc.mockResolvedValue({ success: true });
		const { manager, session } = useHarness({
			status: kind === "prompt" ? "idle" : "streaming",
			...(kind === "prompt" ? { prompt: rpc } : { steer: rpc }),
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const id = `compaction-race-${kind}-${mode}`;

		const admission = kind === "prompt"
			? manager.enqueuePrompt(session.id, "restore after compaction race", { intentId: id })
			: manager.deliverLiveSteer(session.id, "restore after compaction race", { intentId: id });
		if (kind === "prompt") await expect(admission).resolves.toEqual({ status: "dispatched" });
		else await expect(admission).resolves.toBeUndefined();
		expect(rpc).toHaveBeenCalledTimes(1);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(session.promptQueue.toArray()).toEqual([
			expect.objectContaining({
				id,
				kind,
				deliveryState: "queued",
				deliveryReason: "compaction-active",
				retryable: false,
				attemptId: expect.stringMatching(/^attempt:/),
				dispatchEpoch: expect.any(Number),
			}),
		]);

		manager.handleAgentLifecycle(session, { type: "compaction_start", reason, compactionId: `compact-${id}` });
		await flushMicrotasks();
		expect(rpc, "the restored occurrence must remain fenced until compaction_end").toHaveBeenCalledTimes(1);

		manager.handleAgentLifecycle(session, compactionEnd(reason));
		await flushMicrotasks();
		expect(rpc).toHaveBeenCalledTimes(2);
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(session.inFlightSteerTexts).toEqual([
			expect.objectContaining({ intentId: id, state: "dispatching" }),
		]);
	});
});

describe("single compaction release boundary", () => {
	it.each([
		{ reason: "manual" as const, failed: false },
		{ reason: "threshold" as const, failed: false },
		{ reason: "overflow" as const, failed: false },
		{ reason: "threshold" as const, failed: true },
	])("releases exactly once for $reason compaction (failed=$failed), including duplicate end", async ({ reason, failed }) => {
		const { manager, session, prompt } = useHarness({ status: "idle" });
		manager.handleAgentLifecycle(session, { type: "compaction_start", reason });
		await manager.enqueuePrompt(session.id, "release once", { intentId: `intent-${reason}-${failed}` });
		expect(prompt).not.toHaveBeenCalled();

		const end = failed
			? compactionEnd(reason, { result: undefined, errorMessage: "fixture compaction failed", willRetry: false })
			: compactionEnd(reason, { willRetry: false });
		manager.handleAgentLifecycle(session, end);
		manager.handleAgentLifecycle(session, { ...end });
		await flushMicrotasks();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("release once");
		expect(session.promptQueue.toArray()).toEqual([]);
	});

	it("defers compaction end and tool end while aborting, then retargets and drains once", async () => {
		const { manager, session, prompt, steer } = useHarness({ status: "streaming" });
		manager.handleAgentLifecycle(session, { type: "compaction_start", reason: "overflow" });
		await manager.deliverLiveSteer(session.id, "accepted before Stop", { intentId: "S-stop" });
		await manager.enqueuePrompt(session.id, "later prompt", { intentId: "P-after-stop" });
		session.status = "aborting";

		const end = compactionEnd("overflow", { aborted: true, result: undefined, willRetry: false });
		manager.handleAgentLifecycle(session, end);
		manager.handleAgentLifecycle(session, { type: "tool_execution_end", toolName: "bash", result: "stopped" });
		await flushMicrotasks();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();

		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });
		session.status = "streaming";
		successfulTerminal(manager, session);
		await flushMicrotasks();

		expect(steer).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("accepted before Stop");
		expect(session.promptQueue.toArray().map((row: any) => row.id)).toEqual(["P-after-stop"]);

		manager.handleAgentLifecycle(session, { ...end });
		manager.handleAgentLifecycle(session, { type: "tool_execution_end", toolName: "bash", result: "late duplicate" });
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(steer).not.toHaveBeenCalled();
	});

	it("preserves restored lane identity while compacting and releases from persisted state once", async () => {
		const { manager, session, prompt, steer } = useHarness({ status: "streaming" });
		session.promptQueue = new (session.promptQueue.constructor)([
			{
				id: "restored-P", text: "restored prompt", isSteered: false, createdAt: 1,
				kind: "prompt", targetTurn: "next-turn", sequence: 1, deliveryState: "queued",
			},
			{
				id: "restored-S", text: "restored steer", isSteered: true, createdAt: 2,
				kind: "steer", targetTurn: "continuation", sequence: 1, deliveryState: "queued",
			},
		]);
		manager.handleAgentLifecycle(session, { type: "compaction_start", reason: "overflow" });

		manager.handleAgentLifecycle(session, compactionEnd("overflow"));
		await flushMicrotasks();

		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer.mock.calls[0]?.[0]).toBe("restored steer");
		expect(prompt).not.toHaveBeenCalled();
		expect(session.promptQueue.toArray()).toMatchObject([{
			id: "restored-P", targetTurn: "next-turn", sequence: 1,
		}]);
	});
});
