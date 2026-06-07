/**
 * Unit tests for the client-side Subgoals (Experimental) flag helper.
 * See docs/nested-goals.md.
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

	it("defaults to false when dataset is unset (default-off)", () => {
		// With no stored preference the goal-proposal modal must hide the
		// Allow-subgoals toggle + Max-depth control. The user opts in via
		// Settings → System → General → Subgoals.
		assert.equal(isSubgoalsEnabled(), false);
	});

	it("returns false when dataset value is anything other than 'true'", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "false";
		assert.equal(isSubgoalsEnabled(), false);
		root.dataset.subgoalsEnabled = "1";
		assert.equal(isSubgoalsEnabled(), false);
		root.dataset.subgoalsEnabled = "";
		assert.equal(isSubgoalsEnabled(), false);
	});

	it("returns true only when dataset value is the explicit string 'true'", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "true";
		assert.equal(isSubgoalsEnabled(), true);
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

	it("returns false in non-DOM environments when no test override is set", () => {
		delete (globalThis as { document?: unknown }).document;
		assert.equal(isSubgoalsEnabled(), false);
	});
});
