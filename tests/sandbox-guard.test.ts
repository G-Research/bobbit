import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isSandboxAllowed } from "../src/server/auth/sandbox-guard.ts";
import type { SandboxScope } from "../src/server/auth/sandbox-token.ts";

function scope(): SandboxScope {
	return { projectId: "project-1", sessionIds: new Set(["session-1"]), goalIds: new Set() };
}

describe("sandbox route guard", () => {
	it("allows scoped PR walkthrough YAML submissions so the manager can validate session/job ownership", () => {
		assert.equal(isSandboxAllowed("/api/internal/pr-walkthrough/submit-yaml", "POST", scope()), true);
		assert.equal(isSandboxAllowed("/api/internal/pr-walkthrough/submit-yaml", "GET", scope()), false);
	});
});
