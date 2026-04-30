/**
 * Unit tests for `isMultiPhaseSpec` (multi-phase suggestion heuristic).
 *
 * See `docs/design/nested-goals.md` §10.4 + §14.2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isMultiPhaseSpec } from "../src/app/dialog-helpers.ts";

describe("isMultiPhaseSpec", () => {
	it("returns false on empty / non-string input", () => {
		assert.equal(isMultiPhaseSpec(""), false);
		assert.equal(isMultiPhaseSpec(undefined as unknown as string), false);
		assert.equal(isMultiPhaseSpec(null as unknown as string), false);
	});

	it("returns false for a short single-feature spec", () => {
		const spec = `# Add dark mode toggle\n\n## Acceptance criteria\n- The toggle persists across reloads.\n- The system theme is honoured by default.`;
		assert.equal(isMultiPhaseSpec(spec), false);
	});

	// Branch 1 — length > 5000
	describe("length branch", () => {
		it("fires when length > 5000", () => {
			const spec = "x".repeat(5001);
			assert.equal(isMultiPhaseSpec(spec), true);
		});

		it("does not fire when length is exactly 5000", () => {
			const spec = "x".repeat(5000);
			assert.equal(isMultiPhaseSpec(spec), false);
		});

		it("does not fire when length is just below threshold", () => {
			const spec = "x".repeat(4999);
			assert.equal(isMultiPhaseSpec(spec), false);
		});
	});

	// Branch 2 — version / phase / milestone regex
	describe("version/phase/milestone branch", () => {
		it("fires on v0.1", () => {
			assert.equal(isMultiPhaseSpec("Build agent-memory v0.1 with API stub"), true);
		});

		it("fires on v1.0", () => {
			assert.equal(isMultiPhaseSpec("Ship the v1.0 release after stabilising"), true);
		});

		it("fires on v2.5 (any v\\d.\\d)", () => {
			assert.equal(isMultiPhaseSpec("Plan for v2.5"), true);
		});

		it("fires on 'phase 1'", () => {
			assert.equal(isMultiPhaseSpec("This is phase 1 of the migration"), true);
		});

		it("fires on 'Phase 2' (case-insensitive)", () => {
			assert.equal(isMultiPhaseSpec("Now Phase 2 begins"), true);
		});

		it("fires on 'phase  3' (multiple spaces)", () => {
			assert.equal(isMultiPhaseSpec("In phase  3 we ship"), true);
		});

		it("fires on 'milestone'", () => {
			assert.equal(isMultiPhaseSpec("First milestone is the API"), true);
		});

		it("fires on 'Milestone' (case-insensitive)", () => {
			assert.equal(isMultiPhaseSpec("Milestone three: docs"), true);
		});

		it("does not fire on 'phaser' (no digit after phase)", () => {
			// /phase\s*\d/ requires a digit
			assert.equal(isMultiPhaseSpec("phaser library"), false);
		});

		it("does not fire on 'v.1' (regex requires v0-9)", () => {
			assert.equal(isMultiPhaseSpec("version v.1 only"), false);
		});

		it("does not fire on plain 'version 1'", () => {
			assert.equal(isMultiPhaseSpec("version 1 of this thing"), false);
		});
	});

	// Branch 3 — acceptance-criteria count >= 5
	describe("acceptance-criteria count branch", () => {
		it("fires when >= 5 criteria", () => {
			const spec = `# T\n\n## Acceptance criteria\n- one\n- two\n- three\n- four\n- five`;
			assert.equal(isMultiPhaseSpec(spec), true);
		});

		it("fires when > 5 criteria", () => {
			const spec = `## Acceptance criteria\n- a\n- b\n- c\n- d\n- e\n- f\n- g`;
			assert.equal(isMultiPhaseSpec(spec), true);
		});

		it("does not fire at exactly 4 criteria", () => {
			const spec = `## Acceptance criteria\n- one\n- two\n- three\n- four`;
			assert.equal(isMultiPhaseSpec(spec), false);
		});

		it("does not fire with no criteria heading", () => {
			const spec = `# Just a title and prose paragraph with no list at all.`;
			assert.equal(isMultiPhaseSpec(spec), false);
		});
	});

	describe("combined / interaction", () => {
		it("returns true if any branch fires (length only)", () => {
			const spec = "x".repeat(5001);
			assert.equal(isMultiPhaseSpec(spec), true);
		});

		it("returns true if any branch fires (version + criteria)", () => {
			const spec = `# v0.1 plan\n\n## Acceptance criteria\n- a\n- b`;
			assert.equal(isMultiPhaseSpec(spec), true);
		});

		it("returns true for an agent-memory-style spec", () => {
			const spec = `# Build agent-memory v0.1 \u2192 v1.0\n\n` +
				`## Background\n\nWe need persistent memory across sessions.\n\n` +
				`## Phase 1: API stub (v0.1)\n\nBasic CRUD.\n\n` +
				`## Phase 2: vector backend (v0.5)\n\nUpgrade to embeddings.\n\n` +
				`## Phase 3: production (v1.0)\n\nHardening + metrics.\n\n` +
				`## Acceptance criteria\n` +
				`- Memory survives session restart.\n` +
				`- API exposes search / write / forget.\n` +
				`- Vector backend swappable.\n` +
				`- Latency under 200ms p95.\n` +
				`- Metrics dashboards land in v1.0.\n` +
				`- Migration path documented.\n`;
			assert.equal(isMultiPhaseSpec(spec), true);
		});
	});
});
