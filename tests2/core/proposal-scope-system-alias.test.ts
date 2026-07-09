// Ported from tests/proposal-scope-system-alias.test.ts (straggler-coverage-triage
// GENUINE-LOSS: scopeProposalProjectId). Faithful port — same assertions, vitest.
//
// Code-quality review finding — role/tool config created from server-scope
// assistant proposals must NOT persist to the hidden internal `system` project.
//
// Layer 1 (proposal draft scoping): `defaults/tools/proposals/extension.ts`
// stamps proposal args with the session's projectId. Server-scope role/tool
// assistant sessions resolve to the hidden `system` project, which is never a
// user-facing config scope. `scopeProposalProjectId()` must map `system` to the
// user-facing Headquarters (server/global) scope so accepted role/tool config
// lands in the visible Headquarters store, not the hidden system store.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { scopeProposalProjectId } from "../../defaults/tools/proposals/extension.ts";

describe("scopeProposalProjectId — hidden system project never becomes a proposal scope", () => {
	it("maps the hidden `system` project to Headquarters/server scope", () => {
		assert.equal(scopeProposalProjectId("system"), "headquarters");
	});

	it("passes Headquarters through unchanged", () => {
		assert.equal(scopeProposalProjectId("headquarters"), "headquarters");
	});

	it("passes an explicit normal project id through unchanged", () => {
		assert.equal(scopeProposalProjectId("my-project-1234"), "my-project-1234");
	});

	it("returns undefined when there is no session projectId", () => {
		assert.equal(scopeProposalProjectId(undefined), undefined);
	});
});
