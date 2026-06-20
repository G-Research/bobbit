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

	describe("google-code-assist runtime token endpoint", () => {
		it("allows a sandboxed session to GET its OWN token endpoint", () => {
			assert.equal(
				isSandboxAllowed("/api/sessions/session-1/google-code-assist/token", "GET", scope()),
				true,
			);
		});

		it("denies reading ANOTHER session's token endpoint (cross-session)", () => {
			assert.equal(
				isSandboxAllowed("/api/sessions/session-2/google-code-assist/token", "GET", scope()),
				false,
			);
		});

		it("denies non-GET methods on the token endpoint", () => {
			assert.equal(
				isSandboxAllowed("/api/sessions/session-1/google-code-assist/token", "POST", scope()),
				false,
			);
			assert.equal(
				isSandboxAllowed("/api/sessions/session-1/google-code-assist/token", "DELETE", scope()),
				false,
			);
		});
	});
});
