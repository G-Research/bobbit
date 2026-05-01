/**
 * Unit tests for the per-type `mergeFields` plugins in
 * `src/app/proposal-registry.ts`. These guard the streaming-partial
 * carry-forward behaviour that Slice E will lean on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PROPOSAL_TYPE_REGISTRY,
	isProposalType,
	type ProposalType,
} from "../src/app/proposal-registry.ts";

describe("PROPOSAL_TYPE_REGISTRY.mergeFields", () => {
	describe("project", () => {
		const merge = PROPOSAL_TYPE_REGISTRY.project.mergeFields;

		it("carries prior `components` forward when partial omits it", () => {
			const prev = {
				name: "myapp",
				components: [{ name: "a", repo: "." }],
				workflows: { feature: { name: "Feature" } },
			};
			const incoming = { name: "myapp", buildCommand: "npm run build" };
			const out = merge(prev, incoming);
			assert.equal(out.name, "myapp");
			assert.equal(out.buildCommand, "npm run build");
			assert.deepEqual(out.components, prev.components);
			assert.deepEqual(out.workflows, prev.workflows);
		});

		it("carries prior `workflows` forward when partial omits it", () => {
			const prev = { workflows: { feature: { name: "Feature" } } };
			const incoming = { components: [{ name: "x", repo: "." }] };
			const out = merge(prev, incoming);
			assert.deepEqual(out.workflows, prev.workflows);
			assert.deepEqual(out.components, incoming.components);
		});

		it("clears components when incoming explicitly sets `components: []`", () => {
			const prev = { components: [{ name: "a", repo: "." }] };
			const incoming = { components: [] };
			const out = merge(prev, incoming);
			assert.deepEqual(out.components, []);
		});

		it("incoming flat fields win over prior", () => {
			const prev = { name: "old", buildCommand: "old-build" };
			const incoming = { name: "new" };
			const out = merge(prev, incoming);
			assert.equal(out.name, "new");
			assert.equal(out.buildCommand, "old-build");
		});
	});

	describe("goal", () => {
		const merge = PROPOSAL_TYPE_REGISTRY.goal.mergeFields;

		it("preserves prior `spec` when incoming partial only updates frontmatter", () => {
			const prev = { title: "Old", spec: "## Detailed body\n\nLots of text." };
			const incoming = { title: "New" };
			const out = merge(prev, incoming);
			assert.equal(out.title, "New");
			assert.equal(out.spec, prev.spec);
		});

		it("preserves prior non-empty spec when incoming spec is empty string", () => {
			const prev = { title: "T", spec: "body" };
			const incoming = { title: "T", spec: "" };
			const out = merge(prev, incoming);
			assert.equal(out.spec, "body");
		});

		it("incoming non-empty spec replaces prior", () => {
			const prev = { spec: "old body" };
			const incoming = { spec: "new body" };
			const out = merge(prev, incoming);
			assert.equal(out.spec, "new body");
		});

		it("plain spread for non-spec fields", () => {
			const prev = { title: "Old", workflow: "feature" };
			const incoming = { title: "New" };
			const out = merge(prev, incoming);
			assert.equal(out.title, "New");
			assert.equal(out.workflow, "feature");
		});
	});

	describe("plain-spread types (role/tool/staff)", () => {
		for (const type of ["role", "tool", "staff"] as ProposalType[]) {
			it(`${type}: incoming fields shallow-spread over prior`, () => {
				const merge = PROPOSAL_TYPE_REGISTRY[type].mergeFields;
				const prev = { a: 1, b: 2 };
				const incoming = { b: 3, c: 4 };
				const out = merge(prev, incoming);
				assert.deepEqual(out, { a: 1, b: 3, c: 4 });
			});

			it(`${type}: empty incoming yields a copy of prior`, () => {
				const merge = PROPOSAL_TYPE_REGISTRY[type].mergeFields;
				const prev = { a: 1 };
				const out = merge(prev, {});
				assert.deepEqual(out, { a: 1 });
				// non-aliasing: out should be a fresh object
				assert.notEqual(out, prev);
			});
		}
	});
});

describe("isProposalType", () => {
	it("accepts the five known types", () => {
		for (const t of ["goal", "project", "role", "tool", "staff"]) {
			assert.equal(isProposalType(t), true);
		}
	});

	it("rejects unknown values", () => {
		for (const t of ["setup", "", "Goal", null, undefined, 42]) {
			assert.equal(isProposalType(t), false);
		}
	});
});
