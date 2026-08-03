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
} from "../../src/app/context-trace.js";
import { setRenderApp, state } from "../../src/app/state.js";

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
				],
			},
		}]);
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
});
