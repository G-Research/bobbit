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

	it("defaults to false when dataset is unset", () => {
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

	it("returns true when dataset value is the string 'true'", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "true";
		assert.equal(isSubgoalsEnabled(), true);
	});

	it("test override wins over dataset", () => {
		const root = (globalThis as { document?: { documentElement: { dataset: Record<string, string> } } })
			.document!.documentElement;
		root.dataset.subgoalsEnabled = "true";
		_setSubgoalsEnabledForTesting(false);
		assert.equal(isSubgoalsEnabled(), false);
		_setSubgoalsEnabledForTesting(true);
		root.dataset.subgoalsEnabled = "false";
		assert.equal(isSubgoalsEnabled(), true);
	});

	it("returns false in non-DOM environments when no test override is set", () => {
		delete (globalThis as { document?: unknown }).document;
		assert.equal(isSubgoalsEnabled(), false);
	});
});
