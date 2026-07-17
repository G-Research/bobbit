import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(new URL("../../src/server/server.ts", import.meta.url), "utf8");

function routeSource(startMarker: string, endMarker: string): string {
	const start = serverSource.indexOf(startMarker);
	const end = serverSource.indexOf(endMarker, start + startMarker.length);
	expect(start, `missing route marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
	expect(end, `missing route marker: ${endMarker}`).toBeGreaterThan(start);
	return serverSource.slice(start, end);
}

describe("session git-status read-only contract", () => {
	it("keeps the status route free of publication policy and publisher calls", () => {
		const route = routeSource(
			"// GET /api/sessions/:id/git-status",
			"// GET /api/sessions/:id/tool-content",
		);

		expect(route).not.toMatch(/publishCurrentBranchToOrigin|sessionGitStatusAutoPublishDecision|remotePublication/);
		expect(route).toContain("configuredBaseRef: sessionBaseRef");
		expect(route).toContain("hasUpstream: base.hasUpstream");
		expect(route).toContain("json({ ...result, aggregate: result");
		expect(route).toContain("json({ ...aggregate, aggregate, repos })");
	});

	it("retains publication only in the explicit session push route", () => {
		const route = routeSource(
			"// POST /api/sessions/:id/git-push",
			"// POST /api/sessions/:id/git-squash-push",
		);

		expect(route).toContain("publishCurrentBranchToOrigin(cwd, branch");
		expect(route).toContain("setUpstream: !upstream");
	});
});
