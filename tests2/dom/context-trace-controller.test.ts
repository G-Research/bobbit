import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetContextTraceForTests,
	contextTraceStateFor,
	loadEarlierContextTrace,
	normalizeContextTracePayload,
	notifyContextTraceUpdated,
	openContextTraceInspector,
	stopContextTraceInspector,
	syncContextTraceInspector,
} from "../../src/app/context-trace.js";
import { setRenderApp, state } from "../../src/app/state.js";
import "../../src/ui/components/ContextTraceInspector.js";
import type { ContextTraceInspector } from "../../src/ui/components/ContextTraceInspector.js";

const SESSION_A = "a / trace";
const SESSION_B = "b";

function entry(index = 0) {
	return {
		ts: 1_700_000_000_000 + index,
		hook: "afterTurn",
		sessionId: "never rendered",
		providers: [{ id: "first.provider", ms: 12, blocks: 4, omitted: 1 }],
	};
}

function response(entries: unknown[]): Response {
	return new Response(JSON.stringify({ entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function activate(sessionId: string): void {
	state.selectedSessionId = sessionId;
	state.connectingSessionId = null;
	state.remoteAgent = { gatewaySessionId: sessionId } as any;
}

beforeEach(() => {
	__resetContextTraceForTests();
	setRenderApp(() => {});
	activate(SESSION_A);
	vi.stubGlobal("fetch", vi.fn(async () => response([])));
});

afterEach(() => {
	stopContextTraceInspector();
	state.selectedSessionId = null;
	state.remoteAgent = null;
	state.sidePanelWorkspaceBySession = {};
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("context trace controller", () => {
	it("normalizes only allow-listed display data and preserves provider order", () => {
		const items = normalizeContextTracePayload({
			entries: [{
				ts: Infinity,
				hook: "untrusted-hook",
				sessionId: "/private/token",
				providers: [
					{ id: "second", ms: -10, blocks: Infinity, omitted: 3.7, error: "stack /secret" },
					{ id: "../../path", ms: 4, blocks: 2, omitted: 0, error: "timeout" },
					{ id: "malformed", ms: 5, blocks: 1, omitted: 1, error: "malformed block(s) dropped" },
				],
			}],
		});
		expect(items).toEqual([{
			kind: "trace",
			entry: {
				hook: "Unknown event",
				ts: 0,
				providers: [
					{ id: "second", latencyMs: 0, keptBlocks: 0, omittedBlocks: 3, error: "Provider error" },
					{ id: "Unknown provider", latencyMs: 4, keptBlocks: 2, omittedBlocks: 0, error: "Timed out" },
					{ id: "malformed", latencyMs: 5, keptBlocks: 1, omittedBlocks: 1, error: "Malformed blocks omitted" },
				],
			},
		}]);
	});

	it("keeps only safe nested outcome fields with their lifecycle event", () => {
		const secret = "RAW_OUTCOME_TOKEN /private/decision-stack";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1,
				hook: "beforePrompt",
				providers: [],
				outcomes: [
					{ kind: "decision", hookId: "grant-check", event: "beforePrompt", outcome: "denied", reason: "Grant required", value: secret, ms: 5 },
					{ kind: "advisory", hookId: "proposal", event: "beforePrompt", outcome: "dropped", reason: "Malformed result", value: "safe-but-dropped", ms: 6 },
					{ kind: "audit", hookId: "selected-model", event: "beforePrompt", outcome: "applied", reason: secret, value: "model-safe.1", ms: 7 },
					{ kind: "decision", hookId: "prototype-reason", event: "beforePrompt", outcome: "denied", reason: "toString" },
					{ kind: "decision", hookId: "constructor-reason", event: "beforePrompt", outcome: "denied", reason: "constructor" },
					{ kind: "decision", hookId: "../../unsafe", event: "beforePrompt", outcome: "denied", reason: "User pin" },
				],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "beforePrompt",
				ts: 1,
				providers: [],
				outcomes: [
					{ kind: "decision", hookId: "grant-check", event: "beforePrompt", outcome: "denied", reason: "Grant required", latencyMs: 5 },
					{ kind: "advisory", hookId: "proposal", event: "beforePrompt", outcome: "dropped", reason: "Malformed result", latencyMs: 6 },
					{ kind: "audit", hookId: "selected-model", event: "beforePrompt", outcome: "applied", value: "model-safe.1", latencyMs: 7 },
					{ kind: "decision", hookId: "prototype-reason", event: "beforePrompt", outcome: "denied" },
					{ kind: "decision", hookId: "constructor-reason", event: "beforePrompt", outcome: "denied" },
				],
			},
		});
	});

	it("normalizes only fixed safe selection metadata", () => {
		const secret = "raw proposal usage pin snapshot and extension failure";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1,
				hook: "afterTurn",
				providers: [],
				outcomes: [
					{ kind: "advisory", packId: "extension-pack", hookId: "choose-model", event: "afterTurn", outcome: "advised", selectionKind: "model", selectionValue: "provider/model-id" },
					{ kind: "advisory", packId: "extension-pack", hookId: "choose-thinking", event: "afterTurn", outcome: "applied", selectionKind: "thinking", selectionValue: "high" },
					{ kind: "advisory", packId: "extension-pack", hookId: "lower-priority", event: "afterTurn", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "thinking", selectionValue: "private-low" },
					{ kind: "decision", hookId: "pinned-role", event: "beforePrompt", outcome: "denied", reason: "User pin", selectionKind: "role", selectionValue: "private-role" },
					{ kind: "advisory", packId: "extension-pack", hookId: "bad-model", event: "afterTurn", outcome: "advised", selectionKind: "model", selectionValue: "not-a-model-tuple" },
					{ kind: "audit", hookId: "audit-row", event: "beforePrompt", outcome: "applied", selectionKind: "workflow", selectionValue: "workflow-id" },
					{ kind: "advisory", packId: "extension-pack", hookId: "raw-payload", event: "afterTurn", outcome: "error", selectionKind: "workflow", selectionValue: "private-workflow", proposal: secret, usage: { cost: secret }, error: secret, pin: secret, snapshot: { value: secret } },
				],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "afterTurn", ts: 1, providers: [],
				outcomes: [
					{ kind: "advisory", packId: "extension-pack", hookId: "choose-model", event: "afterTurn", outcome: "advised", selectionKind: "model", selectionValue: "provider/model-id" },
					{ kind: "advisory", packId: "extension-pack", hookId: "choose-thinking", event: "afterTurn", outcome: "applied", selectionKind: "thinking", selectionValue: "high" },
					{ kind: "advisory", packId: "extension-pack", hookId: "lower-priority", event: "afterTurn", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "thinking" },
					{ kind: "decision", hookId: "pinned-role", event: "beforePrompt", outcome: "denied", reason: "User pin", selectionKind: "role" },
					{ kind: "advisory", packId: "extension-pack", hookId: "bad-model", event: "afterTurn", outcome: "advised", selectionKind: "model" },
					{ kind: "audit", hookId: "audit-row", event: "beforePrompt", outcome: "applied" },
					{ kind: "advisory", packId: "extension-pack", hookId: "raw-payload", event: "afterTurn", outcome: "error", selectionKind: "workflow" },
				],
			},
		});
		expect(JSON.stringify(item)).not.toContain(secret);
	});

	it("normalizes only aggregate dynamic capability selection telemetry", () => {
		const secret = "query proposal reason candidate-id denied-id /private/config token";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1, hook: "sessionSetup", providers: [],
				outcomes: [
					{
						kind: "decision", packId: "extension-pack", hookId: "select-mcp", event: "sessionSetup", outcome: "applied",
						capabilityStage: "mcp", selectionFingerprint: "a".repeat(64),
						candidateCount: 8, selectedCount: 2, selectorCount: 3, contextBytesSaved: 512,
						query: secret, proposal: { reason: secret, add: [secret] }, deniedIds: [secret], config: { secret },
					},
					{
						kind: "decision", hookId: "bad-stage", event: "sessionSetup", outcome: "error",
						capabilityStage: "tools", selectionFingerprint: secret, candidateCount: -1, selectedCount: Infinity, selectorCount: -1, contextBytesSaved: -1,
					},
					{
						kind: "decision", hookId: "late", event: "beforePrompt", outcome: "applied",
						capabilityStage: "skills", selectionFingerprint: secret, candidateCount: 1, selectedCount: 1, selectorCount: 1, contextBytesSaved: 1,
					},
				],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "sessionSetup", ts: 1, providers: [],
				outcomes: [
					{
						kind: "decision", packId: "extension-pack", hookId: "select-mcp", event: "sessionSetup", outcome: "applied",
						capabilityStage: "mcp", selectionFingerprint: "a".repeat(64),
						candidateCount: 8, selectedCount: 2, selectorCount: 3, contextBytesSaved: 512,
					},
					{ kind: "decision", hookId: "bad-stage", event: "sessionSetup", outcome: "error" },
					{ kind: "decision", hookId: "late", event: "beforePrompt", outcome: "applied" },
				],
			},
		});
		expect(JSON.stringify(item)).not.toContain(secret);
	});

	it("normalizes and presents only safe scheduled-advisor attribution", async () => {
		const secret = "RAW_ADVISOR_RESULT /private/secret";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1,
				hook: "afterTurn",
				providers: [],
				outcomes: [
					{ kind: "advisory", packId: "trusted-pack.1", hookId: "every-two-turns", event: "afterTurn", outcome: "dropped", reason: "Disabled or revoked", value: secret, ms: 12 },
					{ kind: "advisory", hookId: "missing-pack", event: "afterTurn", outcome: "advised", value: secret, ms: 5 },
					{ kind: "advisory", packId: "../../unsafe", hookId: "unsafe-pack", event: "afterTurn", outcome: "advised", value: secret, ms: 6 },
				],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "afterTurn",
				ts: 1,
				providers: [],
				outcomes: [{ kind: "advisory", packId: "trusted-pack.1", hookId: "every-two-turns", event: "afterTurn", outcome: "dropped", reason: "Disabled or revoked", latencyMs: 12 }],
			},
		});

		const inspector = document.createElement("context-trace-inspector") as ContextTraceInspector;
		inspector.state = { status: "ready", items: [item!], limit: 100, hasEarlier: false, isRefreshing: false, refreshError: false };
		document.body.appendChild(inspector);
		await inspector.updateComplete;
		expect(inspector.textContent).toContain("Pack");
		expect(inspector.textContent).toContain("trusted-pack.1");
		expect(inspector.textContent).toContain("Disabled or revoked");
		expect(inspector.textContent).not.toContain(secret);
	});

	it("normalizes only redacted decision-resolution metadata", () => {
		const secret = "question prose / Other answer / proposal args / prompt / token / credential / error";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1,
				hook: "decisionResolved",
				providers: [],
				outcomes: [{
					kind: "decision",
					packId: "extension-pack",
					hookId: "model-choice",
					event: "decisionResolved",
					outcome: "applied",
					requestId: "request-1",
					questionId: "a".repeat(64),
					answer: "other",
					defaultApplied: true,
					actor: "headless",
					reason: "Headless default",
					question: secret,
					otherText: secret,
					proposal: { args: secret },
					error: secret,
				}, {
					kind: "decision",
					packId: "../../unsafe",
					hookId: "unsafe-choice",
					event: "decisionResolved",
					outcome: "applied",
					questionId: secret,
					answer: secret,
					actor: secret,
				}],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "decisionResolved",
				ts: 1,
				providers: [],
				outcomes: [
					{ kind: "decision", packId: "extension-pack", hookId: "model-choice", event: "decisionResolved", outcome: "applied", requestId: "request-1", questionId: "a".repeat(64), answer: "other", defaultApplied: true, actor: "headless", reason: "Headless default" },
					{ kind: "decision", hookId: "unsafe-choice", event: "decisionResolved", outcome: "applied" },
				],
			},
		});
		expect(JSON.stringify(item)).not.toContain(secret);
	});

	it("projects only fixed consent audit metadata", () => {
		const secret = "raw question answer operation tool capability configuration payload";
		const [item] = normalizeContextTracePayload({
			entries: [{
				ts: 1,
				hook: "decisionResolved",
				providers: [],
				...({ question: secret, answer: secret, operation: { id: secret }, tool: { input: secret }, capability: secret, configuration: { value: secret } } as object),
				outcomes: [{
					kind: "decision", packId: "extension-pack", hookId: "protected-change", event: "decisionResolved", outcome: "denied",
					decisionClass: "consent-required", decisionStatus: "paused-awaiting-consent", classificationReason: "core-configuration-change",
					timeoutAction: "pause-goal", resumeStatus: "claimed",
					question: secret, answer: secret, otherText: secret, operation: { id: secret }, tool: { args: secret }, capability: secret, config: { value: secret },
				}, {
					kind: "decision", hookId: "invalid-consent", event: "decisionResolved", outcome: "denied",
					decisionClass: secret, decisionStatus: secret, classificationReason: secret, timeoutAction: secret, resumeStatus: secret,
				}],
			}],
		});
		expect(item).toEqual({
			kind: "trace",
			entry: {
				hook: "decisionResolved", ts: 1, providers: [],
				outcomes: [
					{ kind: "decision", packId: "extension-pack", hookId: "protected-change", event: "decisionResolved", outcome: "denied", decisionClass: "consent-required", decisionStatus: "paused-awaiting-consent", classificationReason: "core-configuration-change", timeoutAction: "pause-goal", resumeStatus: "claimed" },
					{ kind: "decision", hookId: "invalid-consent", event: "decisionResolved", outcome: "denied" },
				],
			},
		});
		expect(JSON.stringify(item)).not.toContain(secret);
	});

	it("uses only the active encoded session endpoint and grows bounded pages", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const limit = Number(new URL(url).searchParams.get("limit"));
			return response(Array.from({ length: limit }, (_, index) => entry(index)));
		});
		vi.stubGlobal("fetch", fetch);

		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		expect(String(fetch.mock.calls[0]?.[0])).toContain(`/api/sessions/${encodeURIComponent(SESSION_A)}/context-trace?limit=100`);
		expect(contextTraceStateFor(SESSION_A).hasEarlier).toBe(true);
		await loadEarlierContextTrace(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(String(fetch.mock.calls[1]?.[0])).toContain("limit=200");
		expect(contextTraceStateFor(SESSION_A).items).toHaveLength(200);
	});

	it("fences an A → B → A stale response and refreshes only matching invalidations", async () => {
		let resolveA!: (value: Response) => void;
		const delayedA = new Promise<Response>((resolve) => { resolveA = resolve; });
		let aRequests = 0;
		const fetch = vi.fn((input: RequestInfo | URL) => {
			if (String(input).includes(encodeURIComponent(SESSION_A))) {
				aRequests++;
				return aRequests === 1 ? delayedA : Promise.resolve(response([entry(3)]));
			}
			return Promise.resolve(response([entry(2)]));
		});
		vi.stubGlobal("fetch", fetch);

		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		activate(SESSION_B);
		openContextTraceInspector(SESSION_B);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		activate(SESSION_A);
		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		resolveA(response([entry(99)]));
		await Promise.resolve();
		await Promise.resolve();
		// The A request that started before the session round-trip must not win.
		expect(contextTraceStateFor(SESSION_A).items).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ entry: expect.objectContaining({ ts: 1_700_000_000_099 }) }),
		]));

		const before = fetch.mock.calls.length;
		notifyContextTraceUpdated(SESSION_B);
		expect(fetch).toHaveBeenCalledTimes(before);
		notifyContextTraceUpdated(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(before + 1));
	});

	it("keeps cached rows and fixed local copy when a refresh fails", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([entry(1)]))
			.mockRejectedValueOnce(new Error("raw gateway token and stack"));
		vi.stubGlobal("fetch", fetch);
		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).items).toHaveLength(1));
		notifyContextTraceUpdated(SESSION_A);
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).refreshError).toBe(true));
		expect(contextTraceStateFor(SESSION_A)).toMatchObject({
			status: "ready",
			error: "Unable to load context trace.",
			refreshError: true,
		});
	});

	it("passes actual controller state through the inspector for paging and cached refresh failures", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, index) => entry(index))))
			.mockRejectedValueOnce(new Error("raw stack and token"))
			.mockResolvedValueOnce(response(Array.from({ length: 200 }, (_, index) => entry(index))));
		vi.stubGlobal("fetch", fetch);

		const inspector = document.createElement("context-trace-inspector") as ContextTraceInspector;
		inspector.addEventListener("context-trace-load-earlier", () => { void loadEarlierContextTrace(SESSION_A); });
		document.body.appendChild(inspector);
		setRenderApp(() => { inspector.state = contextTraceStateFor(SESSION_A); });

		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).hasEarlier).toBe(true));
		await vi.waitFor(() => expect(inspector.querySelector("button[aria-label='Load 100 earlier context trace events']")).not.toBeNull());

		notifyContextTraceUpdated(SESSION_A);
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).refreshError).toBe(true));
		await vi.waitFor(() => expect(inspector.querySelector("[role='alert']")?.textContent).toContain("Showing the most recently loaded activity."));
		expect(inspector.querySelector("[role='alert'] button")?.textContent).toBe("Retry");
		expect(inspector.querySelectorAll("[data-testid='context-trace-event']")).toHaveLength(100);

		(inspector.querySelector("button[aria-label='Load 100 earlier context trace events']") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(String(fetch.mock.calls[2]?.[0])).toContain("limit=200");
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).items).toHaveLength(200));
		document.body.innerHTML = "";
	});

	it("ignores non-active opens and revalidates one inactive invalidation on sync", async () => {
		let resolveActive!: (value: Response) => void;
		let activeSignal: AbortSignal | undefined;
		const activeRequest = new Promise<Response>((resolve) => { resolveActive = resolve; });
		const fetch = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
			if (!activeSignal) {
				activeSignal = init?.signal as AbortSignal | undefined;
				return activeRequest;
			}
			return Promise.resolve(response([entry(2)]));
		});
		vi.stubGlobal("fetch", fetch);
		state.sidePanelWorkspaceBySession[SESSION_A] = {
			version: 1,
			sessionId: SESSION_A,
			revision: 1,
			tabs: [{ id: "context", kind: "context", title: "Context", label: "Context", source: { type: "context", sessionId: SESSION_A }, updatedAt: 1 }],
			activeTabId: "context",
			sizeMode: "split",
			updatedAt: 1,
		};

		openContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		const activeState = contextTraceStateFor(SESSION_A);
		openContextTraceInspector(SESSION_B);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(activeSignal?.aborted).toBe(false);
		expect(contextTraceStateFor(SESSION_A)).toBe(activeState);
		expect(activeState.status).toBe("loading");
		resolveActive(response([entry(1)]));
		await vi.waitFor(() => expect(contextTraceStateFor(SESSION_A).items).toHaveLength(1));

		activate(SESSION_B);
		notifyContextTraceUpdated(SESSION_A);
		activate(SESSION_A);
		syncContextTraceInspector(SESSION_A);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		syncContextTraceInspector(SESSION_A);
		await Promise.resolve();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
