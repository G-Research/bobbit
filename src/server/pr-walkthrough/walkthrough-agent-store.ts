import type { PrWalkthroughAnalysisBundleMetadata } from "./walkthrough-analysis-bundle.js";

// ── Surviving TYPES only ─────────────────────────────────────────────────────
// The legacy `WalkthroughAgentStore` fs job store and the per-job submit-secret
// machinery were deleted in the host.agents reviewer migration (design §6 /
// Decision F Phase 3). Routing now lives in the pack-store binding keyed by the
// verified caller session id — no secret, no fs job store. These TYPE definitions
// survive only because `walkthrough-analysis-bundle.ts` + `routes.ts` describe the
// analysis-bundle job shape with them; they carry no runtime behaviour.

export const PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION = 1;

export type PrWalkthroughJobStatus = "starting" | "waiting_for_yaml" | "validation_failed" | "ready" | "error";

export type PrWalkthroughTarget = {
	provider: "github" | "local" | string;
	prUrl?: string;
	owner?: string;
	repo?: string;
	number?: number;
	baseSha?: string;
	headSha?: string;
	/**
	 * Normalized GitHub host for github-provider targets ("github.com" for
	 * github.com/www.github.com, the real host otherwise). Used to host-qualify
	 * changeset ids so two enterprise hosts sharing owner/repo/number do not
	 * collide on the same tabId / stored-payload path / export lookup.
	 */
	host?: string;
	canonicalKey: string;
};

export type PrWalkthroughValidationIssue = {
	path: string;
	message: string;
};

export type PrWalkthroughValidationSummary = {
	code: "YAML_SCHEMA_INVALID" | string;
	message: string;
	errors: PrWalkthroughValidationIssue[];
	retryable: boolean;
	yamlHash?: string;
};

export type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
};

export type PrWalkthroughJobError = {
	code: string;
	message: string;
	retryable?: boolean;
	host?: string;
};

export interface PrWalkthroughJobRecord {
	schemaVersion: typeof PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION;
	jobId: string;
	parentSessionId: string;
	childSessionId: string;
	projectId?: string;
	cwd: string;
	target: PrWalkthroughTarget;
	changesetId: string;
	tabId: string;
	status: PrWalkthroughJobStatus;
	title: string;
	createdAt: string;
	updatedAt: string;
	lastValidationError?: PrWalkthroughValidationSummary;
	submittedAt?: string;
	payloadUpdatedAt?: string;
	warnings?: WalkthroughWarning[];
	error?: PrWalkthroughJobError;
	reminderCount?: number;
	analysisBundle?: PrWalkthroughAnalysisBundleMetadata;
}
