// Source: tests/session-git-status-publication-policy.test.ts
// Legacy publication-policy coverage is retained as a removal regression.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(new URL("../../src/server/server.ts", import.meta.url), "utf8");

describe("removed session git-status publication policy", () => {
	it("does not expose or invoke legacy auto-publication policy helpers", () => {
		expect(serverSource).not.toMatch(/__resolveSessionGitStatusPublicationForTests/);
		expect(serverSource).not.toMatch(/__resolveSessionGitStatusPublicationPolicyForTests/);
		expect(serverSource).not.toMatch(/sessionGitStatusAutoPublishDecision/);
		expect(serverSource).not.toMatch(/sessionGitStatusRemotePublication/);
	});
});
