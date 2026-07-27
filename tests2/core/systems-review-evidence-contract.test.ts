// v2-native — bounded evidence-reader and structured-result surface coverage.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TOOL_DIR = path.join(ROOT, "defaults", "tools", "systems-review");
const TYPES_FILE = path.join(ROOT, "src", "server", "agent", "systems-review-types.ts");
const EXTENSION_FILE = path.join(TOOL_DIR, "extension.ts");

type ToolYaml = {
	name?: string;
	group?: string;
	grantPolicy?: string;
	params?: string[];
	docs?: string;
	detail_docs?: string;
};

function tool(name: string): ToolYaml {
	return YAML.parse(fs.readFileSync(path.join(TOOL_DIR, `${name}.yaml`), "utf8")) as ToolYaml;
}

function source(file: string): string {
	return fs.readFileSync(file, "utf8");
}

function declarationBody(text: string, typeName: string): string {
	const start = text.indexOf(`export type ${typeName} =`);
	expect(start, `missing ${typeName}`).toBeGreaterThanOrEqual(0);
	const end = text.indexOf(";", start);
	expect(end, `unterminated ${typeName}`).toBeGreaterThan(start);
	return text.slice(start, end + 1);
}

describe("Systems review evidence/result contract", () => {
	it("ships only two default-denied tools in the dedicated group", () => {
		const files = fs.readdirSync(TOOL_DIR).filter((file) => /\.ya?ml$/.test(file)).sort();
		expect(files).toEqual(["read_branch_diff.yaml", "systems_review_result.yaml"]);
		for (const name of ["read_branch_diff", "systems_review_result"]) {
			const definition = tool(name);
			expect(definition.name).toBe(name);
			expect(definition.group).toBe("Systems Review");
			expect(definition.grantPolicy).toBe("never");
		}
	});

	it("exposes the closed paginated reader operations and bounded-page guidance", () => {
		const reader = tool("read_branch_diff");
		expect(reader.params).toEqual(expect.arrayContaining([
			"operation", "repo_id?", "change_id?", "side?", "path?", "paths?", "query?", "cursor?", "limit?",
		]));
		const docs = `${reader.docs ?? ""}\n${reader.detail_docs ?? ""}`;
		for (const operation of ["repos", "manifest", "patch", "file", "list", "search", "coverage"])
			expect(docs).toMatch(new RegExp(`\\b${operation}\\b`));
		expect(docs).toMatch(/200 records/i);
		expect(docs).toMatch(/48 KiB/i);
		expect(docs).toMatch(/opaque/i);
		expect(docs).toMatch(/cannot be reused across operations, objects, sessions, or signals/i);
	});

	it("defines closed manifest, coverage, finding, and mixed-state vocabularies", () => {
		const types = source(TYPES_FILE);
		const expected: Record<string, string[]> = {
			SystemsReviewPathClass: ["production-executable", "test", "docs", "config-schema", "asset", "unknown"],
			SystemsReviewRiskSignal: ["control", "route", "mutation", "target", "aggregation", "transport", "persistence", "state"],
			SystemsReviewChangeKind: ["add", "modify", "delete", "rename", "copy", "type-change"],
			SystemsReviewFindingSeverity: ["critical", "high", "medium"],
			SystemsReviewFindingCategory: ["wrong-target", "hidden-or-misstated-work", "incomplete-authoritative", "untested-destructive-aggregate-target", "other"],
			SystemsReviewReadOperation: ["repos", "manifest", "patch", "file", "list", "search", "coverage"],
		};
		for (const [typeName, values] of Object.entries(expected)) {
			const body = declarationBody(types, typeName);
			const literals = [...body.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
			expect(literals, typeName).toEqual(values);
		}
		for (const state of ["empty", "complete", "partial", "failed", "stale", "mixed-success"])
			expect(types).toMatch(new RegExp(`state:\\s*[\\s\\S]{0,160}\\b${state}\\b`));
	});

	it("models receipt-bound state/action traces and exact-target evidence without a caller verdict", () => {
		const types = source(TYPES_FILE);
		for (const layer of [
			"producer", "aggregation", "transport", "persistence", "consumer",
			"control", "payload", "handler", "target-resolver", "final-side-effect",
		]) expect(types).toContain(`"${layer}"`);
		for (const field of [
			"coverageItemIds", "mixedStateMatrix", "conservativeAggregateInvariant", "targetInvariant",
			"exactTargetAssertionId", "receiptTokens", "processedChangeIds", "unresolvedLinks",
		]) expect(types).toContain(field);
		expect(types).not.toMatch(/SystemsReview(?:Checkpoint|Final)Submission[\s\S]{0,1200}\bverdict\??:/);
		expect(types).not.toMatch(/SystemsReview(?:Checkpoint|Final)Submission[\s\S]{0,1200}\bsummary\??:/);
	});

	it("keeps checkpoint/final submissions discriminated and server-rendered", () => {
		const result = tool("systems_review_result");
		expect(result.params).toEqual(expect.arrayContaining([
			"operation", "execution_id", "snapshot_digest", "contract_digest",
			"previous_checkpoint_digest?", "chunk_id?", "coverage_cursor?",
			"processed_change_ids?", "receipt_tokens?", "behaviors?", "coverage_mappings?",
			"findings?", "unresolved_links?", "resolved_links?", "final_checkpoint_digest?",
		]));
		expect(result.params).not.toEqual(expect.arrayContaining(["verdict", "summary", "report"]));
		expect(result.docs).toMatch(/checkpoint[\s\S]*cannot pass/i);
		expect(result.docs).toMatch(/final[\s\S]*gap-free checkpoint chain/i);
		expect(result.docs).toMatch(/server derives the report and verdict/i);

		const types = source(TYPES_FILE);
		expect(types).toMatch(/operation:\s*"checkpoint"/);
		expect(types).toMatch(/operation:\s*"final"/);
		expect(types).toMatch(/SystemsReviewResultSubmission\s*=\s*SystemsReviewCheckpointSubmission\s*\|\s*SystemsReviewFinalSubmission/);
	});

	it("binds tool calls to the verifier session instead of exposing filesystem or Git execution", () => {
		const extension = source(EXTENSION_FILE);
		expect(extension).toMatch(/BOBBIT_SESSION_ID/);
		expect(extension).toMatch(/X-Bobbit-Session-Id/);
		expect(extension).toMatch(/X-Bobbit-Session-Secret/);
		expect(extension).toContain("/api/internal/systems-review/read-branch-diff");
		expect(extension).toContain("/api/internal/systems-review/result");
		expect(extension).not.toMatch(/node:(?:fs|child_process)|\bexecFile\b|\bspawn\s*\(/);
	});
});
