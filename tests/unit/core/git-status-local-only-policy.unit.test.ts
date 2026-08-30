import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(new URL("../../../src/server/server.ts", import.meta.url), "utf8");
const envelopeSource = readFileSync(new URL("../../../src/server/skills/git-status-envelope.ts", import.meta.url), "utf8");

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
	expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
	return source.slice(start, end);
}

function routeSource(startMarker: string, endMarker: string): string {
	return sourceBetween(serverSource, startMarker, endMarker);
}

describe("session git-status read-only contract", () => {
	it("delegates collection and response classification without publishing", () => {
		const route = routeSource(
			"// GET /api/sessions/:id/git-status",
			"// GET /api/sessions/:id/tool-content",
		);

		expect(route).not.toMatch(/publishCurrentBranchToOrigin|sessionGitStatusAutoPublishDecision|remotePublication/);
		expect(route).toContain("configuredBaseRef: sessionBaseRef");
		expect(route).toMatch(/const collectStatus = \(untracked: boolean\) => collectGitStatusEnvelope\(\{/);
		expect(route).toContain("const collected = await collectStatus(sessUntracked)");
		expect(route).toMatch(/collected\.kind === "success"[\s\S]*publicGitSnapshot\(remoteSnapshots\)/);
		expect(route).toMatch(/const data = \{ \.\.\.collected\.envelope \};[\s\S]*Object\.assign\(collected\.envelope, snapshot, \{ data \}\)[\s\S]*json\(collected\.envelope\)/);
		expect(route).toMatch(/collected\.kind === "not-repository"[\s\S]*"Not a git repository"/);
		expect(route).not.toMatch(/hasUpstream:\s*base\.hasUpstream|target\.repo === "\."|aggregate:\s*result/);
	});

	it("keeps identity, aggregation, and envelope compatibility in the shared helper", () => {
		const aggregateSource = sourceBetween(
			envelopeSource,
			"export function aggregateGitStatusProbes(",
			"/** Collect, classify, and aggregate one root plus zero or more components. */",
		);

		expect(envelopeSource).not.toMatch(/publishCurrentBranchToOrigin|sessionGitStatusAutoPublishDecision|remotePublication/);
		expect(aggregateSource).toContain("const aggregate: GitStatusResult");
		for (const field of ["branch", "primaryBranch", "primaryRef", "isOnPrimary", "hasUpstream"]) {
			expect(aggregateSource).toMatch(new RegExp(`${field}:\\s*base\\.${field}`));
		}
		expect(aggregateSource).toMatch(
			/mergedIntoPrimary:\s*!partial\s*&&\s*results\.every\(\s*\(result\)\s*=>\s*result\.mergedIntoPrimary\s*\)/,
		);
		expect(aggregateSource).not.toMatch(/mergedIntoPrimary:\s*base\.mergedIntoPrimary/);
		expect(aggregateSource).toMatch(/components\.length === 1[\s\S]*target\.repo === "\."/);
		expect(aggregateSource).toMatch(/envelope:\s*\{\s*\.\.\.result,\s*aggregate:\s*result,\s*repos\s*\}/);
		expect(aggregateSource).toMatch(/envelope:\s*\{\s*\.\.\.aggregate,\s*aggregate,\s*repos\s*\}/);
		expect(envelopeSource).toMatch(/return aggregateGitStatusProbes\(root, componentProbes\);/);
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
