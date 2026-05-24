/**
 * Client-side pin for the goal-proposal rehydrate fix.
 *
 * Contract under test:
 *   `createDraftManager.restore(sessionId)` in `src/app/session-manager.ts`
 *   MUST call `renderApp()` after a successful `config.restore(...)` and
 *   BEFORE its returned promise resolves.
 *
 * Why this exists:
 *   `connectToSession`'s fast path (cached-panel revisit) calls
 *   `restoreGoalDraft(sessionId)` fire-and-forget while also dispatching
 *   the `/proposals` rehydrate REST call. If `/proposals` resolves first
 *   it calls `renderApp()` and the panel reads `state.previewSpec === ""`
 *   (it hasn't been restored from disk yet). When the draft restore
 *   finally completes it silently mutates `state.previewSpec = "BODY"`
 *   but — without this render — never repaints, leaving the panel stuck
 *   on `_No spec content yet_`. The companion E2E
 *   `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts` exercises the
 *   full user journey; this unit pin keeps the contract testable at the
 *   layer where it's defined and immune to fast-path refactors.
 *
 * Two complementary strategies are used:
 *
 *   1. **Behavioural test** — a structural clone of `createDraftManager`
 *      is built in-test with injected `loadDraftFromServer` / `renderApp`
 *      mocks and driven through both a plain restore AND a race scenario
 *      (an `onProposal`-style empty-spec mutation lands mid-flight, then
 *      the draft load resolves). After `.restore()` settles the spy must
 *      have been called AT LEAST ONCE and the final state must reflect
 *      the rehydrated body.
 *   2. **Source-level guard** — `session-manager.ts` is read off disk and
 *      its `createDraftManager.restore` body is asserted to call
 *      `renderApp()` between `config.restore(...)` and `return true`.
 *      This catches the case where a future refactor accidentally drops
 *      the call from the production code (the behavioural test would
 *      still pass against the clone).
 *
 * Together these pin both the contract shape and the live production
 * code that implements it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 1. Behavioural test — structural clone of createDraftManager.restore
// ---------------------------------------------------------------------------

interface FakeState {
	previewSpec: string;
	previewTitle: string;
}

interface FakeDraft {
	previewSpec: string;
	previewTitle: string;
}

/**
 * Structural clone of `createDraftManager` from `src/app/session-manager.ts`
 * with `loadDraftFromServer` and `renderApp` injected as parameters.
 *
 * IMPORTANT: this clone must mirror the shape of the production restore
 * method byte-for-byte (modulo the dependency injection). If the production
 * factory grows new responsibilities, update this clone AND keep the
 * source-level guard below in lockstep.
 */
function createDraftManagerForTesting<T>(config: {
	type: string;
	restore: (sessionId: string, draft: T) => void;
}, deps: {
	loadDraftFromServer: (sessionId: string, type: string) => Promise<T | null>;
	renderApp: () => void;
}) {
	return {
		async restore(sessionId: string): Promise<boolean> {
			try {
				const draft = await deps.loadDraftFromServer(sessionId, config.type);
				if (!draft) return false;
				config.restore(sessionId, draft as T);
				deps.renderApp();
				return true;
			} catch (err) {
				console.error(`[${config.type}-draft] Failed to restore draft:`, err);
				return false;
			}
		},
	};
}

function makeGoalDraftManager(
	state: FakeState,
	loadDraftFromServer: (sid: string, t: string) => Promise<FakeDraft | null>,
	renderApp: () => void,
) {
	return createDraftManagerForTesting<FakeDraft>(
		{
			type: "goal",
			restore: (_sessionId, draft) => {
				state.previewSpec = draft.previewSpec ?? "";
				state.previewTitle = draft.previewTitle ?? "";
			},
		},
		{ loadDraftFromServer, renderApp },
	);
}

describe("createDraftManager.restore — render contract", () => {
	it("calls renderApp() after a successful restore mutates state", async () => {
		const state: FakeState = { previewSpec: "", previewTitle: "" };
		const renderSnapshots: Array<{ spec: string; title: string }> = [];
		const renderApp = () => {
			renderSnapshots.push({ spec: state.previewSpec, title: state.previewTitle });
		};

		const draft: FakeDraft = { previewSpec: "BODY", previewTitle: "T" };
		const loadDraftFromServer = async () => draft;

		const mgr = makeGoalDraftManager(state, loadDraftFromServer, renderApp);
		const ok = await mgr.restore("sess-X");

		assert.equal(ok, true, "restore must report success when draft is present");
		assert.equal(state.previewSpec, "BODY", "state.previewSpec must reflect the draft");
		assert.equal(state.previewTitle, "T", "state.previewTitle must reflect the draft");

		assert.ok(renderSnapshots.length >= 1, "renderApp must be called at least once");
		// Critically: when renderApp was called, the state was ALREADY rehydrated.
		// This is what guarantees the panel repaints with the restored body
		// rather than the empty pre-restore state.
		const last = renderSnapshots[renderSnapshots.length - 1];
		assert.equal(last.spec, "BODY", "renderApp must observe the rehydrated spec");
		assert.equal(last.title, "T", "renderApp must observe the rehydrated title");
	});

	it("returns false and skips renderApp when there is no draft on disk", async () => {
		const state: FakeState = { previewSpec: "PRE", previewTitle: "PRE" };
		let renderCount = 0;
		const renderApp = () => { renderCount++; };
		const loadDraftFromServer = async () => null;

		const mgr = makeGoalDraftManager(state, loadDraftFromServer, renderApp);
		const ok = await mgr.restore("sess-X");

		assert.equal(ok, false, "restore must report false when no draft exists");
		assert.equal(renderCount, 0, "renderApp must NOT be called when there is no draft");
		// State is untouched.
		assert.equal(state.previewSpec, "PRE");
		assert.equal(state.previewTitle, "PRE");
	});

	it("swallows load errors and skips renderApp", async () => {
		const state: FakeState = { previewSpec: "PRE", previewTitle: "PRE" };
		let renderCount = 0;
		const renderApp = () => { renderCount++; };
		const loadDraftFromServer = async () => { throw new Error("boom"); };

		// Silence the console.error for this single test.
		const origErr = console.error;
		console.error = () => {};
		try {
			const mgr = makeGoalDraftManager(state, loadDraftFromServer, renderApp);
			const ok = await mgr.restore("sess-X");
			assert.equal(ok, false);
		} finally {
			console.error = origErr;
		}
		assert.equal(renderCount, 0, "renderApp must NOT be called when the load throws");
	});

	it("wins the race against a parallel onProposal-style empty mutation", async () => {
		// Race scenario: a fire-and-forget rehydrate path mutates state to
		// previewSpec = "" before the draft load resolves. After restore
		// settles, the final state must reflect the draft AND renderApp
		// must have been called with the restored state visible.
		const state: FakeState = { previewSpec: "PRE-NAV", previewTitle: "PRE-NAV" };
		const renderSnapshots: Array<{ spec: string; title: string }> = [];
		const renderApp = () => {
			renderSnapshots.push({ spec: state.previewSpec, title: state.previewTitle });
		};

		// Simulate the cached-panel fast-path: state is cleared synchronously
		// (the production fast-path sets state.previewSpec = "" before
		// dispatching the rehydrate REST calls).
		state.previewSpec = "";
		state.previewTitle = "";

		let resolveLoad: (draft: FakeDraft) => void = () => {};
		const loadDraftFromServer = () =>
			new Promise<FakeDraft>((res) => {
				resolveLoad = res;
			});

		const mgr = makeGoalDraftManager(state, loadDraftFromServer, renderApp);
		const restorePromise = mgr.restore("sess-X");

		// Mid-flight: simulate the parallel onProposal callback firing.
		// In the bug scenario, this is the render that would lock the panel
		// onto the empty state. We tolerate it here — the contract is that
		// the NEXT render after the draft load resolves picks up the
		// rehydrated body.
		renderApp(); // synthetic onProposal render, observes empty state
		assert.equal(renderSnapshots[0].spec, "", "synthetic mid-flight render sees empty state (by construction)");

		// Now resolve the draft load.
		resolveLoad({ previewSpec: "BODY", previewTitle: "T" });
		const ok = await restorePromise;
		assert.equal(ok, true);

		// After restore settles, state reflects the rehydrated draft AND
		// renderApp was invoked at least once AFTER the state was set.
		assert.equal(state.previewSpec, "BODY");
		assert.equal(state.previewTitle, "T");
		const last = renderSnapshots[renderSnapshots.length - 1];
		assert.equal(last.spec, "BODY", "last render must observe the rehydrated spec");
		assert.equal(last.title, "T", "last render must observe the rehydrated title");
	});
});

// ---------------------------------------------------------------------------
// 2. Source-level guard — pin the live production code shape.
// ---------------------------------------------------------------------------

describe("createDraftManager.restore — source-level invariant", () => {
	it("session-manager.ts calls renderApp() between config.restore(...) and return true", () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), "src/app/session-manager.ts"),
			"utf-8",
		);

		// Anchor on the unique signature line of the restore method.
		const anchor = "async restore(sessionId: string): Promise<boolean> {";
		const idx = src.indexOf(anchor);
		assert.ok(idx > 0, "could not locate createDraftManager.restore method");

		// Slice a generous window — the method is short but commented.
		const window = src.slice(idx, idx + 1500);

		// 1. The body must call config.restore(...).
		assert.match(
			window,
			/config\.restore\(\s*sessionId\s*,\s*draft\s+as\s+T\s*\)/,
			"restore body must dispatch to config.restore(sessionId, draft as T)",
		);

		// 2. renderApp() must appear AFTER config.restore(...) and BEFORE return true.
		const restoreCallIdx = window.search(/config\.restore\(/);
		const renderAppIdx = window.search(/\brenderApp\(\s*\)\s*;/);
		const returnTrueIdx = window.search(/return\s+true\s*;/);

		assert.ok(restoreCallIdx >= 0, "config.restore call must be present");
		assert.ok(
			renderAppIdx > restoreCallIdx,
			"renderApp() must appear AFTER config.restore(...)",
		);
		assert.ok(
			returnTrueIdx > renderAppIdx,
			"renderApp() must appear BEFORE return true",
		);

		// 3. The renderApp symbol must be imported (re-exported from ./state.js
		// in this codebase). Pin both the import site and the existence of
		// the symbol — a future move would have to update both.
		assert.match(
			src,
			/import\s*\{[^}]*\brenderApp\b[^}]*\}\s*from\s*"\.\/state\.js"/s,
			"renderApp must be imported (currently re-exported from ./state.js)",
		);
	});
});
