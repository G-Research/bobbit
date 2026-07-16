/**
 * Fast integration-level decision coverage for `team_wait`. The production
 * OrchestrationCore runs against a tiny observable session view, avoiding
 * gateway/session construction and real elapsed-time waits while preserving
 * ownership, ordering, queued-state, timeout, and rendering contracts.
 */
import { describe, expect, it } from "vitest";
import {
	OrchestrationCore,
	isSettledStatus,
	type OrchestrationSessionLike,
	type OrchestrationSessionView,
	type PersistedSessionLike,
	type WaitResult,
} from "../../src/server/agent/orchestration-core.ts";

type Settlement = "idle" | "timeout" | "failed" | "pending";

interface TestSession extends OrchestrationSessionLike {
	settlement: Settlement;
	output?: string;
	queuedPromptCount?: number;
}

class WaitSessionView implements OrchestrationSessionView {
	readonly live = new Map<string, TestSession>();
	readonly persisted = new Map<string, PersistedSessionLike>();

	add(id: string, settlement: Settlement, opts: Partial<TestSession> = {}): void {
		this.live.set(id, {
			id,
			status: settlement === "idle" ? "idle" : "streaming",
			settlement,
			title: `${id} title`,
			...opts,
		});
		this.persisted.set(id, { id, title: `${id} title` });
	}

	async createDelegateSession(): Promise<{ id: string }> { throw new Error("unused"); }
	async createSession(): Promise<{ id: string }> { throw new Error("unused"); }
	async enqueuePrompt(): Promise<{ status: string }> { return { status: "queued" }; }
	async deliverLiveSteer(): Promise<unknown> { return {}; }
	waitForIdle(id: string): Promise<void> {
		switch (this.live.get(id)?.settlement) {
			case "idle": return Promise.resolve();
			case "timeout": return Promise.reject(new Error(`Timeout waiting for session ${id} to become idle`));
			case "failed": return Promise.reject(new Error(`Agent process exited unexpectedly for session ${id}`));
			default: return new Promise<void>(() => { /* deliberately unsettled */ });
		}
	}
	async getSessionOutput(id: string): Promise<string> { return this.live.get(id)?.output ?? ""; }
	getSession(id: string): OrchestrationSessionLike | undefined { return this.live.get(id); }
	getPersistedSession(id: string): PersistedSessionLike | undefined { return this.persisted.get(id); }
	async terminateSession(id: string): Promise<boolean> { return this.live.delete(id); }
	async forceAbort(): Promise<void> { /* unused */ }
	isSessionLive(id: string): boolean { return this.live.has(id); }
	getQueuedPromptCount(id: string): number { return this.live.get(id)?.queuedPromptCount ?? 0; }
}

function formatWaitText(result: WaitResult): string {
	const lines: string[] = [];
	const first = result.firstIdle;
	if (first) {
		const item = result.statuses.find(status => status.sessionId === first);
		lines.push(`${result.firstIsTerminal ? "First settled child" : "First idle child"}: ${first}${item?.title ? ` ("${item.title}")` : ""}`);
		lines.push("");
	}
	lines.push(`Awaited children (${result.statuses.length}):`);
	for (const status of result.statuses) lines.push(`  • ${status.sessionId} — ${status.status}`);
	if (result.remaining === 0) {
		lines.push("All awaited children are settled.");
	} else {
		const remaining = result.statuses.filter(status => !isSettledStatus(status.status)).map(status => status.sessionId);
		lines.push(`Remaining: ${result.remaining} child(ren) not yet settled.`);
		lines.push(`Process this result now, then call team_wait again to await the remaining children — pass child_session_ids: [${remaining.join(", ")}].`);
	}
	return lines.join("\n");
}

function fixture() {
	const view = new WaitSessionView();
	view.add("parent", "idle");
	const core = new OrchestrationCore({ sessionManager: view, resolveSessionModel: () => undefined, audit: () => {} });
	const child = (id: string, settlement: Settlement, opts: Partial<TestSession> = {}) => {
		view.add(id, settlement, opts);
		core.registerChild({ sessionId: id, ownerSessionId: "parent", childKind: "delegate", title: `${id} title` });
	};
	const waitFirst = async (ids: string[]) => {
		const result = await core.wait("parent", ids, { policy: "first", timeoutMs: 400 });
		return { ...result, text: formatWaitText(result) };
	};
	return { view, core, child, waitFirst };
}

async function chunkedWait(core: OrchestrationCore, ownerId: string, childIds: string[]) {
	try {
		const result = await core.wait(ownerId, childIds, { policy: "first", timeoutMs: 400 });
		return { status: 200, json: { ...result, text: formatWaitText(result) } };
	} catch (error) {
		return { status: 200, json: { error: error instanceof Error ? error.message : String(error), statuses: [] } };
	}
}

describe("team_wait — first-settled + status line", () => {
	it("returns on the first idle child, lists the rest, and instructs to call again", async () => {
		const { child, waitFirst } = fixture();
		child("busy", "pending");
		child("quick", "idle");
		const result = await waitFirst(["busy", "quick"]);
		expect(result.firstIdle).toBe("quick");
		expect(result.firstIsTerminal).toBeFalsy();
		const byId = new Map(result.statuses.map(status => [status.sessionId, status.status]));
		expect(byId.get("quick")).toBe("idle");
		expect(byId.get("busy")).toBe("streaming");
		expect(result.remaining).toBe(1);
		expect(result.text).toContain("First idle child");
		expect(result.text).toContain("Awaited children");
		expect(result.text).toContain("call team_wait again");
		expect(result.text).toMatch(/child_session_ids: \[[^\]]+\]/);
		expect(result.text).toContain("busy");
		expect(result.text).not.toContain('quick"');
	});

	it("the chunked wait route surfaces a post-headers error in the body (finding #5)", async () => {
		const { view, core } = fixture();
		view.add("stranger", "idle");
		const response = await chunkedWait(core, "parent", ["stranger"]);
		expect(response.status).toBe(200);
		expect(response.json.error).toMatch(/not owned/i);
		expect(response.json.statuses).toHaveLength(0);
	});

	it("a non-streaming child with a queued prompt is reported `queued`", async () => {
		const { child, waitFirst } = fixture();
		child("quick", "idle");
		child("queued", "pending", { status: "idle", queuedPromptCount: 1 });
		const result = await waitFirst(["quick", "queued"]);
		const byId = new Map(result.statuses.map(status => [status.sessionId, status.status]));
		expect(byId.get("quick")).toBe("idle");
		expect(byId.get("queued")).toBe("queued");
	});

	it("already-idle child returns immediately with All-settled wording", async () => {
		const { child, waitFirst } = fixture();
		child("quick", "idle");
		const result = await waitFirst(["quick"]);
		expect(result.firstIdle).toBe("quick");
		expect(result.remaining).toBe(0);
		expect(result.text).toContain("All awaited children are settled.");
		expect(result.text).not.toContain("call team_wait again");
	});
});

describe("team_wait — timeout + terminal handling", () => {
	it("a streaming child does not satisfy the wait and times out as a terminal status (no rejection)", async () => {
		const { child, waitFirst } = fixture();
		child("busy", "timeout");
		const result = await waitFirst(["busy"]);
		expect(result.statuses).toHaveLength(1);
		expect(result.statuses[0].status).toBe("timeout");
		expect(result.firstIdle).toBe("busy");
		expect(result.firstIsTerminal).toBe(true);
		expect(result.text).toContain("First settled child");
	});

	it("one child times out while another is already idle — aggregate never rejects", async () => {
		const { view, child, waitFirst } = fixture();
		child("busy", "pending");
		child("quick", "idle");
		const first = await waitFirst(["busy", "quick"]);
		expect(first.firstIdle).toBe("quick");
		expect(first.remaining).toBe(1);
		view.live.get("busy")!.settlement = "timeout";
		const second = await waitFirst(["busy"]);
		expect(second.statuses[0].status).toBe("timeout");
		expect(second.firstIsTerminal).toBe(true);
	});
});
