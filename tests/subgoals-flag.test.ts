/**
 * Unit tests for the client-side Subgoals (Experimental) flag helper.
 * See docs/design/subgoals-experimental-toggle.md.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	isSubgoalsEnabled,
	_setSubgoalsEnabledForTesting,
} from "../src/app/subgoals-flag.ts";

describe("isSubgoalsEnabled", () => {
	beforeEach(() => {
		// Ensure no test override is leaking in.
		_setSubgoalsEnabledForTesting(undefined);
		// Stand up a minimal `document.documentElement.dataset` stub so the
		// helper's dataset-read path is covered without a real DOM.
		const root = { dataset: {} as Record<string, string | undefined> };
		(globalThis as { document?: { documentElement: typeof root } }).document = {
			documentElement: root,
		};
	});

	afterEach(() => {
		_setSubgoalsEnabledForTesting(undefined);
		delete (globalThis as { document?: unknown }).document;
	});

	it("defaults to true when dataset is unset (default-on)", () => {
		// This is the path the goal-proposal modal relies on: with no stored
		// preference the Allow-subgoals toggle + Max-depth control must render.
		// See src/app/proposal-panels.ts goalProposalPanel() and the G1 fix.
		assert.equal(isSubgoalsEnabled(), true);
	});

	it("returns true when dataset value is anything other than 'false'", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "true";
		assert.equal(isSubgoalsEnabled(), true);
		root.dataset.subgoalsEnabled = "1";
		assert.equal(isSubgoalsEnabled(), true);
		root.dataset.subgoalsEnabled = "";
		assert.equal(isSubgoalsEnabled(), true);
	});

	it("returns false only when dataset value is the explicit string 'false'", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "false";
		assert.equal(isSubgoalsEnabled(), false);
	});

	it("test override wins over dataset", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "false";
		_setSubgoalsEnabledForTesting(true);
		assert.equal(isSubgoalsEnabled(), true);
		_setSubgoalsEnabledForTesting(false);
		root.dataset.subgoalsEnabled = "true";
		assert.equal(isSubgoalsEnabled(), false);
	});

	it("returns true in non-DOM environments when no test override is set", () => {
		delete (globalThis as { document?: unknown }).document;
		assert.equal(isSubgoalsEnabled(), true);
	});
});
