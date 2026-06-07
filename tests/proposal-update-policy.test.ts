/**
 * Unit tests for `src/app/proposal-update-policy.ts`.
 *
 * Pins the apply-or-drop decision used by the unified `remote.onProposal`
 * callback in session-manager.ts. The HIGH finding this guards against:
 * a stale out-of-order SERVER event (`serverRev < prevRev`) must NOT be
 * applied, or the panel regresses to superseded content while the rev clamp
 * keeps the displayed rev high. A browser E2E can't deterministically
 * reproduce the race, so the logic lives in this pure function + test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldApplyProposalUpdate } from "../src/app/proposal-update-policy.ts";

describe("proposal-update-policy — shouldApplyProposalUpdate", () => {
	it("first-emit applies (no slot yet)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: false, serverRev: undefined, prevRev: 0, streaming: false, isFirstEmit: true }),
			true,
		);
	});

	it("live streaming partial applies even when prevRev > 0", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: false, serverRev: undefined, prevRev: 3, streaming: true, isFirstEmit: false }),
			true,
		);
	});

	it("non-streaming no-rev rescan drops once a server rev exists (prevRev > 0)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: false, serverRev: undefined, prevRev: 2, streaming: false, isFirstEmit: false }),
			false,
		);
	});

	it("non-streaming no-rev scan applies when prevRev === 0 (pre-server state)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: false, serverRev: undefined, prevRev: 0, streaming: false, isFirstEmit: false }),
			true,
		);
	});

	it("server event with serverRev > prevRev applies (newer revision)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: true, serverRev: 5, prevRev: 3, streaming: false, isFirstEmit: false }),
			true,
		);
	});

	it("server event with serverRev === prevRev applies (idempotent re-emit)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: true, serverRev: 4, prevRev: 4, streaming: false, isFirstEmit: false }),
			true,
		);
	});

	it("server event with serverRev < prevRev DROPS (stale out-of-order — the HIGH finding)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: true, serverRev: 2, prevRev: 5, streaming: false, isFirstEmit: false }),
			false,
		);
	});

	it("stale older server event drops even while streaming (rev wins over preview)", () => {
		assert.equal(
			shouldApplyProposalUpdate({ hasServerRev: true, serverRev: 1, prevRev: 4, streaming: true, isFirstEmit: false }),
			false,
		);
	});
});
