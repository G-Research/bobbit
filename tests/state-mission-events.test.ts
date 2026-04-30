/**
 * Tests for client-side handling of mission_* WebSocket events.
 *
 * Bug: the server broadcasts mission_created / mission_updated / mission_deleted
 * / mission_plan_proposed / mission_plan_frozen / mission_plan_reset /
 * mission_child_spawned / mission_child_state_changed / mission_child_merged /
 * mission_child_merge_conflict / mission_paused / mission_resumed /
 * mission_execution_ready / mission_spawn_failed — but the client had zero
 * handlers, so the sidebar never updated until F5.
 *
 * Fix: src/app/remote-agent.ts now dispatches each mission_* event:
 *   - calls refreshMissions() (state.missions reload)
 *   - for child-affecting events, also calls refreshSessions() (state.goals reload)
 *   - emits a `mission-event` CustomEvent on document so the mission-dashboard
 *     can react without coupling.
 *
 * This file feeds mock WS frames into the dispatch path and asserts the
 * expected refresh + DOM event side effects.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Browser-API shims (must run before importing the SUT) ───────────────────
const g = globalThis as any;
if (typeof g.localStorage === "undefined" || typeof g.localStorage?.getItem !== "function") {
	const store = new Map<string, string>();
	g.localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => store.set(k, String(v)),
		removeItem: (k: string) => store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() { return store.size; },
	};
}
if (typeof g.window === "undefined") {
	g.window = {
		innerWidth: 1024,
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
		location: { hash: "" },
	};
}
// `document` shim with proper addEventListener / dispatchEvent / removeEventListener,
// since the SUT now dispatches a `mission-event` CustomEvent.
const dispatchedEvents: { type: string; detail: any }[] = [];
const docListeners = new Map<string, Set<(e: any) => void>>();
if (typeof g.document === "undefined") {
	g.document = new Proxy({
		addEventListener: (type: string, fn: (e: any) => void) => {
			if (!docListeners.has(type)) docListeners.set(type, new Set());
			docListeners.get(type)!.add(fn);
		},
		removeEventListener: (type: string, fn: (e: any) => void) => {
			docListeners.get(type)?.delete(fn);
		},
		dispatchEvent: (e: any) => {
			dispatchedEvents.push({ type: e.type, detail: e.detail });
			const ls = docListeners.get(e.type);
			if (ls) for (const fn of ls) fn(e);
			return true;
		},
		visibilityState: "visible",
		documentElement: { style: { setProperty: () => {} } },
		createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
		createElement: () => ({ setAttribute: () => {}, append: () => {}, appendChild: () => {} }),
		createElementNS: () => ({ setAttribute: () => {}, append: () => {}, appendChild: () => {} }),
		createTextNode: () => ({}),
		createDocumentFragment: () => ({ appendChild: () => {}, append: () => {} }),
		createComment: () => ({}),
		body: null,
		head: null,
	}, {
		get(target, prop) {
			if (prop in target) return (target as any)[prop];
			return () => undefined;
		},
	});
}
if (typeof g.Node === "undefined") {
	g.Node = class {} as any;
	(g.Node as any).ELEMENT_NODE = 1;
	(g.Node as any).TEXT_NODE = 3;
	(g.Node as any).COMMENT_NODE = 8;
}
if (typeof g.HTMLElement === "undefined") g.HTMLElement = class {};
if (typeof g.Element === "undefined") g.Element = class {};
if (typeof g.WebSocket === "undefined") {
	g.WebSocket = class { static OPEN = 1; readyState = 0; };
}
// fetch is what refreshMissions / refreshSessions hit. Capture call URLs so
// the test can assert which endpoints were prodded.
const fetchCalls: string[] = [];
g.fetch = async (url: string, _init?: any) => {
	fetchCalls.push(typeof url === "string" ? url : String(url));
	// Return an empty-but-shaped payload so the refresh paths short-circuit
	// gracefully without throwing.
	return {
		ok: true,
		status: 200,
		json: async () => {
			if (url.includes("/api/missions")) return { missions: [] };
			if (url.includes("/api/goals")) return { goals: [], generation: 0, changed: false };
			if (url.includes("/api/sessions")) return { sessions: [], generation: 0, changed: false };
			return {};
		},
	};
};
if (typeof g.HashChangeEvent === "undefined") {
	g.HashChangeEvent = class { constructor(_: string) {} };
}
if (typeof g.CustomEvent === "undefined") {
	g.CustomEvent = class {
		type: string;
		detail: any;
		constructor(type: string, init?: { detail?: any }) {
			this.type = type;
			this.detail = init?.detail;
		}
	};
}

// Dynamic import — must come AFTER the shims above are in place.
let RemoteAgentCtor: any;
before(async () => {
	const mod = await import("../src/app/remote-agent.ts");
	RemoteAgentCtor = mod.RemoteAgent;
});

beforeEach(() => {
	dispatchedEvents.length = 0;
	docListeners.clear();
	fetchCalls.length = 0;
});

function dispatch(remote: any, frame: any): Promise<void> {
	return remote.handleServerMessage(frame);
}

// Helper — wait one microtask tick so the .catch() promise chain attached to
// refreshMissions/refreshSessions has a chance to settle before assertions.
function tick(): Promise<void> {
	return new Promise(r => setImmediate(r));
}

describe("RemoteAgent — mission_* WS event handlers", () => {
	it("mission_created triggers refreshMissions and a mission-event dispatch", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, { type: "mission_created", mission: { id: "m1", title: "test" } });
		await tick();

		assert.ok(
			fetchCalls.some(u => u.includes("/api/missions")),
			`expected refreshMissions to fetch /api/missions; got: ${JSON.stringify(fetchCalls)}`,
		);
		assert.ok(
			dispatchedEvents.some(e => e.type === "mission-event" && e.detail?.type === "mission_created"),
			`expected a mission-event CustomEvent with type mission_created; got: ${JSON.stringify(dispatchedEvents)}`,
		);
	});

	const missionOnlyEvents = [
		"mission_updated",
		"mission_deleted",
		"mission_plan_proposed",
		"mission_plan_frozen",
		"mission_plan_reset",
		"mission_paused",
		"mission_resumed",
		"mission_execution_ready",
	];
	for (const type of missionOnlyEvents) {
		it(`${type} triggers refreshMissions only (no goals refresh)`, async () => {
			const remote: any = new RemoteAgentCtor();
			await dispatch(remote, { type, missionId: "m1" });
			await tick();

			const missionsHit = fetchCalls.some(u => u.includes("/api/missions"));
			const goalsHit = fetchCalls.some(u => u.includes("/api/goals"));
			assert.ok(missionsHit, `${type} should refresh missions; got: ${JSON.stringify(fetchCalls)}`);
			assert.ok(!goalsHit, `${type} should NOT refresh goals; got: ${JSON.stringify(fetchCalls)}`);
			assert.ok(
				dispatchedEvents.some(e => e.type === "mission-event" && e.detail?.type === type),
				`expected mission-event for ${type}; got: ${JSON.stringify(dispatchedEvents)}`,
			);
		});
	}

	it("mission_child_spawned triggers BOTH refreshMissions and refreshSessions (goals)", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, {
			type: "mission_child_spawned",
			missionId: "m1",
			planId: "p1",
			goalId: "g1",
		});
		await tick();

		assert.ok(
			fetchCalls.some(u => u.includes("/api/missions")),
			`expected /api/missions hit; got: ${JSON.stringify(fetchCalls)}`,
		);
		assert.ok(
			fetchCalls.some(u => u.includes("/api/goals")),
			`expected /api/goals hit (goal row appeared); got: ${JSON.stringify(fetchCalls)}`,
		);
		assert.ok(
			dispatchedEvents.some(e => e.type === "mission-event" && e.detail?.type === "mission_child_spawned"),
		);
	});

	it("mission_child_merged triggers BOTH refreshMissions and refreshSessions", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, {
			type: "mission_child_merged",
			missionId: "m1",
			planId: "p1",
			status: "merged",
			mergeSha: "abc123",
		});
		await tick();

		assert.ok(fetchCalls.some(u => u.includes("/api/missions")));
		assert.ok(fetchCalls.some(u => u.includes("/api/goals")));
	});

	it("mission_child_state_changed triggers refreshSessions but skips refreshMissions", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, {
			type: "mission_child_state_changed",
			missionId: "m1",
			goalId: "g1",
			state: "in-progress",
		});
		await tick();

		assert.ok(
			fetchCalls.some(u => u.includes("/api/goals")),
			`expected /api/goals hit; got: ${JSON.stringify(fetchCalls)}`,
		);
		assert.ok(
			!fetchCalls.some(u => u.includes("/api/missions")),
			`mission_child_state_changed should not refresh missions list; got: ${JSON.stringify(fetchCalls)}`,
		);
	});

	it("mission_child_merge_conflict refreshes missions and pushes an error notification", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, {
			type: "mission_child_merge_conflict",
			missionId: "m1",
			planId: "p1",
		});
		await tick();

		assert.ok(fetchCalls.some(u => u.includes("/api/missions")));
		const msgs = remote.state.messages as any[];
		assert.ok(
			msgs.some((m: any) => m.role === "system-notification" && m.category === "error" && /merge conflict/i.test(m.message ?? "")),
			`expected merge-conflict system-notification; got: ${JSON.stringify(msgs)}`,
		);
	});

	it("mission_spawn_failed refreshes missions and pushes an error notification", async () => {
		const remote: any = new RemoteAgentCtor();
		await dispatch(remote, {
			type: "mission_spawn_failed",
			missionId: "m1",
			planId: "p1",
			error: "git checkout failed",
		});
		await tick();

		assert.ok(fetchCalls.some(u => u.includes("/api/missions")));
		const msgs = remote.state.messages as any[];
		assert.ok(
			msgs.some((m: any) => m.role === "system-notification" && m.category === "error" && /spawn failed/i.test(m.message ?? "")),
			`expected spawn-failed system-notification; got: ${JSON.stringify(msgs)}`,
		);
	});

	it("unknown mission_* event types do not throw and do not refresh", async () => {
		const remote: any = new RemoteAgentCtor();
		await assert.doesNotReject(async () => {
			await dispatch(remote, { type: "unknown_event_xyz" });
		});
		await tick();
		assert.deepStrictEqual(fetchCalls, [], "unknown events must not trigger refreshes");
	});
});
