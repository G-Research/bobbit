import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { apiCall, readGatewayCreds } from "../_shared/gateway.js";

function result(data: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
		details: undefined,
		...(isError ? { isError: true } : {}),
	};
}

async function call(path: string, body: unknown): Promise<unknown> {
	const creds = readGatewayCreds();
	if ("error" in creds) throw new Error(creds.error);
	const sessionId = process.env.BOBBIT_SESSION_ID;
	if (!sessionId) throw new Error("Systems review tool unavailable: missing BOBBIT_SESSION_ID");
	return apiCall(creds, "POST", path, body, {
		extraHeaders: {
			"X-Bobbit-Session-Id": sessionId,
			...(process.env.BOBBIT_SESSION_SECRET
				? { "X-Bobbit-Session-Secret": process.env.BOBBIT_SESSION_SECRET }
				: {}),
		},
	});
}

const Side = Type.Union([Type.Literal("base"), Type.Literal("head")]);
const ReceiptLocation = Type.Object({
	repoId: Type.String(),
	path: Type.String(),
	lineStart: Type.Optional(Type.Number()),
	lineEnd: Type.Optional(Type.Number()),
	kind: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
	receipts: Type.Array(Type.String()),
});
const TraceLayer = Type.Object({
	layer: Type.String(),
	description: Type.String(),
	locations: Type.Array(ReceiptLocation),
});
const TestInvariant = Type.Object({
	invariant: Type.String(),
	failureLayer: Type.String(),
	locations: Type.Array(ReceiptLocation),
	exactTargetAssertionId: Type.Optional(Type.String()),
});
const Behavior = Type.Union([
	Type.Object({
		kind: Type.Literal("state"),
		id: Type.String(),
		title: Type.String(),
		coverageItemIds: Type.Array(Type.String()),
		layers: Type.Array(TraceLayer),
		mixedStateMatrix: Type.Array(Type.Object({
			state: Type.Union([Type.Literal("empty"), Type.Literal("complete"), Type.Literal("partial"), Type.Literal("failed"), Type.Literal("stale"), Type.Literal("mixed-success")]),
			expected: Type.String(),
			observed: Type.String(),
			locations: Type.Array(ReceiptLocation),
		})),
		conservativeAggregateInvariant: Type.String(),
		tests: Type.Array(TestInvariant),
	}),
	Type.Object({
		kind: Type.Literal("action"),
		id: Type.String(),
		title: Type.String(),
		coverageItemIds: Type.Array(Type.String()),
		layers: Type.Array(TraceLayer),
		change: Type.Union([Type.Literal("introduced"), Type.Literal("modified"), Type.Literal("unchanged")]),
		mutation: Type.Union([Type.Literal("none"), Type.Literal("local"), Type.Literal("destructive"), Type.Literal("remote")]),
		aggregate: Type.Boolean(),
		targetInvariant: Type.String(),
		tests: Type.Array(TestInvariant),
	}),
]);
const Finding = Type.Object({
	id: Type.String(),
	severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium")]),
	category: Type.Union([Type.Literal("wrong-target"), Type.Literal("hidden-or-misstated-work"), Type.Literal("incomplete-authoritative"), Type.Literal("untested-destructive-aggregate-target"), Type.Literal("other")]),
	title: Type.String(),
	trigger: Type.String(),
	consequence: Type.String(),
	violatedInvariant: Type.String(),
	behaviorIds: Type.Array(Type.String()),
	locations: Type.Array(ReceiptLocation),
});

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "read_branch_diff",
		label: "Read Branch Diff",
		description: "Read a bounded, receipt-bearing page from the immutable Systems review snapshot.",
		parameters: Type.Union([
			Type.Object({ operation: Type.Union([Type.Literal("repos"), Type.Literal("manifest"), Type.Literal("coverage")]), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
			Type.Object({ operation: Type.Literal("patch"), change_id: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
			Type.Object({ operation: Type.Literal("file"), repo_id: Type.String(), side: Side, path: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
			Type.Object({ operation: Type.Literal("list"), repo_id: Type.String(), side: Side, path: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
			Type.Object({ operation: Type.Literal("search"), repo_id: Type.String(), side: Side, paths: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }), query: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
		]),
		async execute(_toolCallId, params) {
			try {
				const { repo_id, change_id, ...rest } = params as Record<string, unknown>;
				return result(await call("/api/internal/systems-review/read-branch-diff", {
					...rest,
					...(repo_id !== undefined ? { repoId: repo_id } : {}),
					...(change_id !== undefined ? { changeId: change_id } : {}),
				}));
			} catch (error) {
				return result(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	pi.registerTool({
		name: "systems_review_result",
		label: "Systems Review Result",
		description: "Submit a receipt-bound checkpoint or final Systems review synthesis. The server derives the verdict.",
		parameters: Type.Union([
			Type.Object({
				operation: Type.Literal("checkpoint"),
				execution_id: Type.String(),
				snapshot_digest: Type.String(),
				contract_digest: Type.String(),
				previous_checkpoint_digest: Type.Optional(Type.String()),
				chunk_id: Type.String(),
				coverage_cursor: Type.String(),
				processed_change_ids: Type.Array(Type.String()),
				receipt_tokens: Type.Array(Type.String()),
				behaviors: Type.Array(Behavior),
				coverage_mappings: Type.Array(Type.Object({
					coverageItemId: Type.String(),
					behaviorIds: Type.Array(Type.String()),
					nonBehavioralReason: Type.Optional(Type.Union([Type.Literal("test-only"), Type.Literal("docs-only"), Type.Literal("passive-asset"), Type.Literal("dependency-lockfile")])),
				})),
				findings: Type.Array(Finding),
				unresolved_links: Type.Array(Type.String()),
			}),
			Type.Object({
				operation: Type.Literal("final"),
				execution_id: Type.String(),
				snapshot_digest: Type.String(),
				contract_digest: Type.String(),
				final_checkpoint_digest: Type.String(),
				resolved_links: Type.Array(Type.String()),
			}),
		]),
		async execute(_toolCallId, params) {
			try {
				const aliases: Record<string, string> = {
					execution_id: "executionId", snapshot_digest: "snapshotDigest", contract_digest: "contractDigest",
					previous_checkpoint_digest: "previousCheckpointDigest", chunk_id: "chunkId", coverage_cursor: "coverageCursor",
					processed_change_ids: "processedChangeIds", receipt_tokens: "receiptTokens", coverage_mappings: "coverageMappings",
					unresolved_links: "unresolvedLinks", resolved_links: "resolvedLinks", final_checkpoint_digest: "finalCheckpointDigest",
				};
				const body: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(params as Record<string, unknown>)) body[aliases[key] ?? key] = value;
				return result(await call("/api/internal/systems-review/result", body));
			} catch (error) {
				return result(error instanceof Error ? error.message : String(error), true);
			}
		},
	});
};

export default extension;
