// Objective compact-first replay of the audited bug-discovery comparison.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import registerAgentExtension from "../../defaults/tools/agent/extension.ts";
import { generateToolResultErrorBridgeExtension } from "../../src/server/agent/tool-result-error-bridge-extension.ts";
import { readTranscript, type ReadTranscriptParams } from "../../src/server/agent/transcript-reader.ts";
import { withEnv } from "../harness/with-env.js";
import { loadBobbitTools } from "./helpers/bobbit-harness.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/read-session/original-question-replay/", import.meta.url));
const FINAL_PI_LIMIT = 50 * 1024;
const CUMULATIVE_LIMIT = 200 * 1024;
const AUDITED_COMPARISON_SESSION = "3e541ac7-83f4-48e6-a408-d5ea41b902f5";
const CANDIDATE_IDS = [
	"e6717bf3-5768-4b09-9bdb-f7c26cc4fd49",
	"llm-review-889950f7-e15",
	"llm-review-0072b056-b90",
	"llm-review-624e3bde-d6a",
	"llm-review-464b420c-062",
	"llm-review-8f4ea9b6-da3",
] as const;

const EXPECTED_FINDINGS = [
	{
		id: "two-cross-layer-misses",
		claim: "The standalone review alone formally found (a) aggregate Git actions/history omitted a repository key and therefore targeted session.cwd/the wrong or non-Git root, and (b) aggregate mergedIntoPrimary came from the first component and could display Merged while another component was ahead/unmerged.",
		citations: [
			"standalone-finding-action-routing",
			"standalone-finding-merged-aggregate",
			"workflow-bug-verdict-independent",
			"workflow-quality-verdict-independent",
			"workflow-regression-verdict-independent",
			"workflow-security-verdict-independent",
			"workflow-gap-verdict-independent",
		],
	},
	{
		id: "coordination-primary-cause",
		claim: "The main advantage was an open-ended coordinated adversarial audit with overlapping cross-layer traces and parent severity synthesis, versus independent gate-specific verdicts with no cross-gate synthesis.",
		citations: [
			"standalone-prompt-open-audit",
			"standalone-verdict-synthesis",
			"workflow-bug-verdict-independent",
			"workflow-quality-verdict-independent",
			"workflow-regression-verdict-independent",
			"workflow-security-verdict-independent",
			"workflow-gap-verdict-independent",
		],
	},
	{
		id: "prompt-contributed-not-sufficient",
		claim: "The broad “any verifiable bugs or malicious code” prompt encouraged exploration; narrow gate objectives, reassuring-but-incomplete tests, and design text encoding the faulty rule mattered more than the bug-hunt high-severity threshold alone.",
		citations: [
			"standalone-prompt-open-audit",
			"workflow-bug-prompt-threshold",
			"workflow-regression-prompt-gate",
			"workflow-regression-verdict-independent",
			"workflow-gap-prompt-gate",
		],
	},
	{
		id: "github-not-decisive",
		claim: "GitHub improved navigation, but the relevant production code was identical at the two captured SHAs, so GitHub access does not explain the misses.",
		citations: [
			"standalone-meta-model-github",
			"workflow-gap-finding-identical-production",
		],
	},
	{
		id: "snapshot-not-decisive",
		claim: "The relevant production code was identical at the two captured SHAs, so snapshot timing does not explain the misses.",
		citations: ["workflow-gap-finding-identical-production"],
	},
	{
		id: "model-cause-unknown",
		claim: "Standalone model/reasoning is known, comparable workflow model metadata is absent, so model quality is not a supported causal finding.",
		citations: [
			"standalone-meta-model-github",
			"workflow-bug-meta-model",
			"workflow-quality-meta-model",
			"workflow-regression-meta-model",
			"workflow-security-meta-model",
			"workflow-gap-meta-model",
		],
	},
	{
		id: "not-uniformly-superior",
		claim: "Workflow reviewers found other stale-component, sole-root partial-result, and diagnostic-disclosure issues; the standalone advantage was specifically cross-layer semantic/action-routing defects.",
		citations: [
			"standalone-finding-action-routing",
			"standalone-finding-merged-aggregate",
			"workflow-quality-finding-stale-component",
			"workflow-gap-finding-sole-root",
			"workflow-security-finding-disclosure",
		],
	},
] as const;

interface FixtureRow {
	rowId: string;
	kind: "metadata" | "prompt" | "tool_call" | "tool_result" | "finding" | "verdict";
	entry: Record<string, unknown>;
}

interface CandidateFixture {
	fixtureRevision: number;
	candidateId: string;
	candidateKind: string;
	provenance: string;
	metadata: Record<string, any>;
	rows: FixtureRow[];
}

interface ManifestCandidate {
	id: string;
	kind: string;
	file: string;
	metadataRowId: string;
	sha256: string;
}

interface ReplayLedgerEntry {
	order: number;
	tool: "bobbit_read" | "read_session";
	candidateId: string;
	params: Record<string, unknown>;
	returnedRange: [number, number] | null;
	finalPiBytes: number;
	cumulativePiBytes: number;
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function resultJson(result: any): any {
	assert.notEqual(result?.isError, true, result?.content?.[0]?.text ?? "tool returned an error");
	assert.equal(result?.content?.length, 1);
	return JSON.parse(result.content[0].text);
}

async function loadBoundReadSessionExecute(): Promise<(id: string, params: any) => Promise<any>> {
	const generated = generateToolResultErrorBridgeExtension();
	const boundary = (await import(`data:text/javascript,${encodeURIComponent(generated)}`)).default as (pi: any) => void;
	let execute: ((id: string, params: any) => Promise<any>) | undefined;
	const pi: any = {
		registerTool(spec: any) {
			if (spec?.name === "read_session") execute = spec.execute.bind(spec);
		},
	};
	boundary(pi);
	registerAgentExtension(pi);
	assert.ok(execute, "real read_session extension did not register behind the immutable result boundary");
	return execute;
}

function transcriptParams(url: URL): ReadTranscriptParams {
	const integer = (name: string): number | undefined => {
		const value = url.searchParams.get(name);
		return value === null ? undefined : Number(value);
	};
	return {
		offset: integer("offset"),
		limit: integer("limit"),
		pattern: url.searchParams.get("pattern") ?? undefined,
		caseSensitive: url.searchParams.get("case_sensitive") === "1",
		context: integer("context"),
		verbose: url.searchParams.get("verbose") === "1",
		includeToolResults: url.searchParams.get("include_tool_results") === "1",
		resultHandle: url.searchParams.get("result_handle") ?? undefined,
		resultCursor: integer("result_cursor"),
		resultLimit: integer("result_limit"),
	};
}

function response(body: unknown): any {
	const text = JSON.stringify(body);
	return {
		ok: true,
		status: 200,
		async text() { return text; },
		async json() { return body; },
	};
}

function assertEvidence(evidence: Map<string, any>, rowId: string, patterns: RegExp[]): void {
	const row = evidence.get(rowId);
	assert.ok(row, `cited fixture row ${rowId} was not returned by compact projection`);
	for (const pattern of patterns) assert.match(String(row.text ?? ""), pattern, `${rowId} lost required evidence`);
}

function buildFindings(evidence: Map<string, any>): typeof EXPECTED_FINDINGS {
	assertEvidence(evidence, "standalone-finding-action-routing", [/aggregate Git actions/i, /session\.cwd/i, /non-Git/i]);
	assertEvidence(evidence, "standalone-finding-merged-aggregate", [/mergedIntoPrimary/, /first component/i, /another component.*unmerged/i]);
	assertEvidence(evidence, "standalone-verdict-synthesis", [/overlapping/i, /cross-layer/i, /severity/i]);
	assertEvidence(evidence, "standalone-prompt-open-audit", [/any verifiable bugs or malicious code/i, /across layers/i]);
	assertEvidence(evidence, "workflow-bug-prompt-threshold", [/high-severity/i, /gate scope/i]);
	assertEvidence(evidence, "workflow-regression-verdict-independent", [/tests were incomplete/i, /design text encoded the faulty/i]);
	assertEvidence(evidence, "standalone-meta-model-github", [/known standalone model/i, /GitHub.*navigation/i]);
	assertEvidence(evidence, "workflow-gap-finding-identical-production", [/identical SHA-256 digests/i, /only workflow configuration and design documentation differ/i]);
	for (const rowId of [
		"workflow-bug-meta-model",
		"workflow-quality-meta-model",
		"workflow-regression-meta-model",
		"workflow-security-meta-model",
		"workflow-gap-meta-model",
	]) assertEvidence(evidence, rowId, [/explicitly unknown/i]);
	assertEvidence(evidence, "workflow-quality-finding-stale-component", [/stale-component/i]);
	assertEvidence(evidence, "workflow-gap-finding-sole-root", [/sole-root/i, /partial-result/i]);
	assertEvidence(evidence, "workflow-security-finding-disclosure", [/diagnostic-disclosure/i]);
	for (const finding of EXPECTED_FINDINGS) {
		for (const citation of finding.citations) assert.ok(evidence.has(citation), `${finding.id} cites missing row ${citation}`);
	}
	return EXPECTED_FINDINGS;
}

function assertNonOverlapping(ledger: ReplayLedgerEntry[]): void {
	for (const candidateId of CANDIDATE_IDS) {
		const intervals = ledger
			.filter((entry) => entry.tool === "read_session" && entry.candidateId === candidateId && entry.returnedRange)
			.map((entry) => entry.returnedRange!)
			.sort((left, right) => left[0] - right[0]);
		for (let index = 1; index < intervals.length; index += 1) {
			assert.ok(intervals[index - 1][1] < intervals[index][0], `${candidateId} replay windows overlap`);
		}
	}
}

describe("original comparison compact-first replay", () => {
	it("reaches exactly the seven audited findings within the fixed call and byte ledger", async () => {
		const manifestPath = path.join(FIXTURE_DIR, "manifest.json");
		const manifest = readJson<any>(manifestPath);
		assert.equal(manifest.fixtureRevision, 1);
		assert.deepEqual(manifest.candidates.map((candidate: ManifestCandidate) => candidate.id), CANDIDATE_IDS);
		assert.deepEqual(manifest.reviewedRevisions, {
			workflow: "62d3ca6d4feaa3849a1830ad39ff3bf97cfcd8fd",
			standalonePrHead: "62e12dfd04e2673063cf219da991878f7ce23207",
		});
		assert.deepEqual(manifest.productionIdentity, {
			identicalAt: [
				"62d3ca6d4feaa3849a1830ad39ff3bf97cfcd8fd",
				"62e12dfd04e2673063cf219da991878f7ce23207",
			],
			paths: [
				{ path: "src/server/server.ts", sha256: "b67caed47f33743d47fc6db02a6784720efb1e3cee32f4df95348703cd34c0ec" },
				{ path: "src/server/skills/git-status-envelope.ts", sha256: "3aa4b39a195c25a1b4fa6f0f67e64d31b95875e0e2283d99095794dc798e1e1e" },
				{ path: "src/ui/components/GitStatusWidget.ts", sha256: "c824aed18371275197c18610e120997397b93c6a97cc437a6efb476e207f28a9" },
				{ path: "src/app/api.ts", sha256: "ed711c590f48b74edf285fdcc86d4d6ca09118e139e305be2d40ab696efddba0" },
			],
			nonProductionDifferences: [
				".github/workflows/build-unit-gate.yml",
				".github/workflows/codeql.yml",
				"docs/design/multi-repo-components.md",
			],
		});
		assert.equal(manifest.standaloneModel.availability, "known");
		assert.equal(manifest.workflowModel, "unknown");

		const expectedFiles = ["manifest.json", ...manifest.candidates.map((candidate: ManifestCandidate) => candidate.file)].sort();
		assert.deepEqual(fs.readdirSync(FIXTURE_DIR).sort(), expectedFiles);
		const fixtures = new Map<string, CandidateFixture>();
		const allRowIds = new Set<string>();
		for (const candidate of manifest.candidates as ManifestCandidate[]) {
			const fixturePath = path.join(FIXTURE_DIR, candidate.file);
			const bytes = fs.readFileSync(fixturePath);
			assert.equal(sha256(bytes), candidate.sha256, `${candidate.file} failed manifest hash integrity`);
			const raw = bytes.toString("utf8");
			assert.equal(raw.includes(AUDITED_COMPARISON_SESSION), false, `${candidate.file} imports the mutable comparison session`);
			assert.equal(raw.includes("comparisonAnswer"), false);
			for (const finding of EXPECTED_FINDINGS) {
				assert.equal(raw.includes(finding.id), false, `${candidate.file} embeds comparison answer ${finding.id}`);
			}
			const fixture = JSON.parse(raw) as CandidateFixture;
			assert.equal(fixture.fixtureRevision, 1);
			assert.equal(fixture.candidateId, candidate.id);
			assert.deepEqual(Object.keys(fixture).sort(), ["candidateId", "candidateKind", "fixtureRevision", "metadata", "provenance", "rows"]);
			assert.equal(fixture.metadata.id, candidate.id);
			assert.ok(fixture.rows.length <= 10, `${candidate.id} is not a minimal compact page`);
			assert.equal(fixture.rows[0].rowId, candidate.metadataRowId);
			assert.ok(fixture.rows.some((row) => row.kind === "prompt"));
			assert.ok(fixture.rows.some((row) => row.kind === "tool_call"));
			assert.ok(fixture.rows.some((row) => row.kind === "tool_result"));
			assert.ok(fixture.rows.some((row) => row.kind === "finding" || row.kind === "verdict"));
			for (const row of fixture.rows) {
				assert.deepEqual(Object.keys(row).sort(), ["entry", "kind", "rowId"]);
				assert.equal(allRowIds.has(row.rowId), false, `duplicate fixture row ID ${row.rowId}`);
				allRowIds.add(row.rowId);
			}
			if (candidate.kind === "standalone-pr-review") assert.equal(fixture.metadata.model.availability, "known");
			else assert.deepEqual(fixture.metadata.model, { availability: "unknown", value: "unknown" });
			fixtures.set(candidate.id, fixture);
		}

		const originalFetch = globalThis.fetch;
		const ledger: ReplayLedgerEntry[] = [];
		const evidence = new Map<string, any>();
		let cumulativePiBytes = 0;
		const record = (tool: ReplayLedgerEntry["tool"], candidateId: string, params: Record<string, unknown>, value: any, range: [number, number] | null) => {
			const finalPiBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
			cumulativePiBytes += finalPiBytes;
			ledger.push({
				order: ledger.length + 1,
				tool,
				candidateId,
				params: structuredClone(params),
				returnedRange: range,
				finalPiBytes,
				cumulativePiBytes,
			});
		};

		await withEnv({
			BOBBIT_TOKEN: "original-question-replay-token",
			BOBBIT_GATEWAY_URL: "https://original-question-replay.test",
			BOBBIT_SESSION_ID: "objective-replay-caller",
		}, async () => {
			globalThis.fetch = (async (input: any) => {
				const url = new URL(String(input));
				const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
				if (transcriptMatch) {
					const candidateId = decodeURIComponent(transcriptMatch[1]);
					const fixture = fixtures.get(candidateId);
					assert.ok(fixture, `unexpected live transcript request for ${candidateId}`);
					const jsonl = `${fixture.rows.map((row) => JSON.stringify(row.entry)).join("\n")}\n`;
					const envelope = await readTranscript(transcriptParams(url), {
						readContent: async () => jsonl,
						projection: "agent",
						sessionId: candidateId,
					});
					return response(envelope);
				}
				const metadataMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
				if (metadataMatch) {
					const candidateId = decodeURIComponent(metadataMatch[1]);
					const fixture = fixtures.get(candidateId);
					assert.ok(fixture, `unexpected live metadata request for ${candidateId}`);
					return response(fixture.metadata);
				}
				assert.fail(`unexpected gateway request ${url.pathname}`);
			}) as any;

			try {
				const bobbitRead = loadBobbitTools().get("bobbit_read")!;
				const readSession = await loadBoundReadSessionExecute();
				for (const candidate of manifest.candidates as ManifestCandidate[]) {
					const fixture = fixtures.get(candidate.id)!;
					const metadataParams = { operation: "get_session", sessionId: candidate.id };
					const metadataValue = await bobbitRead.execute(`metadata-${candidate.id}`, metadataParams);
					const projectedMetadata = resultJson(metadataValue);
					assert.deepEqual(projectedMetadata, {
						id: fixture.metadata.id,
						title: fixture.metadata.title,
						status: fixture.metadata.status,
						role: fixture.metadata.role,
						projectId: fixture.metadata.projectId,
						createdAt: fixture.metadata.createdAt,
						lastActivity: fixture.metadata.lastActivity,
						completedTurnCount: 1,
						lastTurnErrored: false,
						consecutiveErrorTurns: 0,
					});
					assert.equal((projectedMetadata as any).model, undefined, "compact metadata must not expand model/runtime bookkeeping");
					record("bobbit_read", candidate.id, metadataParams, metadataValue, null);

					const readParams = { session_id: candidate.id, offset: -10, limit: 10 };
					const readValue = await readSession(`read-${candidate.id}`, readParams);
					const envelope = resultJson(readValue);
					assert.equal(envelope.returned, fixture.rows.length);
					assert.equal(envelope.offsetStart, 0);
					assert.equal(envelope.offsetEnd, fixture.rows.length - 1);
					assert.equal(envelope.nextOffset, undefined);
					assert.ok(envelope.messages.some((message: any) => message.toolCalls?.length === 1));
					const result = envelope.messages.flatMap((message: any) => message.toolResults ?? [])[0];
					assert.equal(result.status, "ok");
					assert.equal(result.omitted, true);
					assert.ok(result.size.chars > 0 && result.size.bytes > 0);
					assert.equal(result.excerpt, undefined, "compact replay must not pull result bodies implicitly");
					for (const message of envelope.messages) {
						const fixtureRow = fixture.rows[message.index];
						assert.ok(fixtureRow, `projection returned unknown index ${message.index}`);
						evidence.set(fixtureRow.rowId, message);
					}
					record("read_session", candidate.id, readParams, readValue, [envelope.offsetStart, envelope.offsetEnd]);
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		const findings = buildFindings(evidence);
		const report = {
			findings,
			ledger,
			cumulativePiBytes,
			citations: findings.map((finding) => ({ id: finding.id, rowIds: [...finding.citations] })),
			stopReason: "all-seven-findings-evidenced",
			stoppedAfterCall: ledger.length,
		};

		assert.deepEqual(report.findings, EXPECTED_FINDINGS);
		assert.deepEqual(report.findings.map((finding) => finding.id), [
			"two-cross-layer-misses",
			"coordination-primary-cause",
			"prompt-contributed-not-sufficient",
			"github-not-decisive",
			"snapshot-not-decisive",
			"model-cause-unknown",
			"not-uniformly-superior",
		]);
		assert.deepEqual(report.citations, EXPECTED_FINDINGS.map((finding) => ({ id: finding.id, rowIds: [...finding.citations] })));
		assert.equal(report.stopReason, "all-seven-findings-evidenced");
		assert.equal(report.stoppedAfterCall, 12);

		const metadataCalls = ledger.filter((entry) => entry.tool === "bobbit_read");
		const readCalls = ledger.filter((entry) => entry.tool === "read_session");
		assert.equal(metadataCalls.length, 6);
		assert.equal(readCalls.length, 6);
		assert.ok(readCalls.length <= 7);
		assert.ok(ledger.length <= 13);
		assert.deepEqual(metadataCalls.map((entry) => entry.candidateId), CANDIDATE_IDS);
		assert.deepEqual(readCalls.map((entry) => entry.candidateId), CANDIDATE_IDS);
		assert.deepEqual(ledger.map((entry) => entry.order), Array.from({ length: 12 }, (_, index) => index + 1));
		assert.deepEqual(ledger.map((entry) => entry.tool), CANDIDATE_IDS.flatMap(() => ["bobbit_read", "read_session"]));
		assert.equal(readCalls.filter((entry) => "result_handle" in entry.params).length, 0);
		assert.ok(readCalls.every((entry) => !("result_cursor" in entry.params) && !("result_limit" in entry.params)));
		assert.ok(readCalls.filter((entry) => entry.params.verbose === true).length === 0);
		assert.ok(readCalls.filter((entry) => entry.params.include_tool_results === true).length === 0);
		assert.ok(readCalls.every((entry) => Number.isInteger(entry.params.limit) && Number(entry.params.limit) <= 10));
		assert.ok(readCalls.every((entry) => entry.params.offset === -10), "every candidate must use one compact tail");
		assertNonOverlapping(ledger);
		let measuredCumulative = 0;
		for (const entry of ledger) {
			assert.ok(entry.finalPiBytes <= FINAL_PI_LIMIT);
			measuredCumulative += entry.finalPiBytes;
			assert.equal(entry.cumulativePiBytes, measuredCumulative);
		}
		assert.ok(cumulativePiBytes <= CUMULATIVE_LIMIT);
		assert.equal(ledger.at(-1)?.cumulativePiBytes, cumulativePiBytes);
	});
});
