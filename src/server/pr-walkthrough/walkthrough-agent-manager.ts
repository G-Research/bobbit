import { createHash, randomUUID } from "node:crypto";

import yaml from "yaml";

import { bobbitStateDir } from "../bobbit-dir.js";
import { saveWalkthrough, type WalkthroughStorePayload } from "./walkthrough-store.js";
import {
	WalkthroughAgentStore,
	type PrWalkthroughJobError,
	type PrWalkthroughJobRecord,
	type PrWalkthroughTarget,
	type PrWalkthroughValidationIssue,
	type PrWalkthroughValidationSummary,
	type WalkthroughWarning,
} from "./walkthrough-agent-store.js";

type RpcLike = {
	prompt?: (text: string, images?: unknown) => Promise<unknown> | unknown;
	onEvent?: (handler: (event: unknown) => void) => (() => void);
};

type SessionLike = {
	id: string;
	title?: string;
	cwd?: string;
	worktreePath?: string;
	status?: string;
	projectId?: string;
	sandboxed?: boolean;
	rpcClient?: RpcLike;
	allowedTools?: string[];
	[key: string]: unknown;
};

type PersistedSessionLike = {
	id: string;
	cwd?: string;
	worktreePath?: string;
	status?: string;
	archived?: boolean;
	projectId?: string;
	sandboxed?: boolean;
	modelProvider?: string;
	modelId?: string;
	[key: string]: unknown;
};

export type WalkthroughSessionManagerLike = {
	createSession: (
		cwd: string,
		agentArgs?: string[],
		goalId?: string,
		assistantType?: string,
		opts?: Record<string, unknown>,
	) => Promise<SessionLike>;
	getSession?: (sessionId: string) => SessionLike | undefined;
	getPersistedSession?: (sessionId: string) => PersistedSessionLike | undefined;
	updateSessionMeta?: (sessionId: string, updates: Record<string, unknown>) => boolean;
	setTitle?: (sessionId: string, title: string, opts?: Record<string, unknown>) => void;
	enqueuePrompt?: (sessionId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type WalkthroughAgentManagerDeps = {
	stateDir?: string;
	defaultCwd: string;
	sessionManager?: WalkthroughSessionManagerLike;
	resolveSessionCwd?: (sessionId: string) => string | undefined | Promise<string | undefined>;
	resolveSessionModel?: (sessionId: string) => string | { provider?: string; id?: string; modelId?: string } | undefined | Promise<string | { provider?: string; id?: string; modelId?: string } | undefined>;
	store?: WalkthroughAgentStore;
	broadcast?: (event: Record<string, unknown>) => void;
	validateYaml?: (yamlText: string, job: PrWalkthroughJobRecord) => Promise<WalkthroughYamlValidationResult> | WalkthroughYamlValidationResult;
	mapYamlToPayload?: (document: Record<string, unknown>, job: PrWalkthroughJobRecord) => Promise<WalkthroughStorePayload> | WalkthroughStorePayload;
};

export type LaunchWalkthroughRequest = {
	sessionId?: string;
	parentSessionId?: string;
	prUrl?: string;
	prNumber?: string | number;
	owner?: string;
	repo?: string;
	baseSha?: string;
	headSha?: string;
	cwd?: string;
	projectId?: string;
};

export type LaunchWalkthroughResponse = {
	jobId: string;
	childSessionId: string;
	changesetId: string;
	tabId: string;
	status: PrWalkthroughJobRecord["status"];
	title: string;
	created: boolean;
	job: PrWalkthroughJobRecord;
};

export type SubmitWalkthroughYamlRequest = {
	sessionId: string;
	jobId: string;
	yaml: string;
};

export type SubmitWalkthroughYamlResponse =
	| { ok: true; status: "ready"; job: PrWalkthroughJobRecord; changesetId: string; message: string; warnings: WalkthroughWarning[] }
	| { ok: false; status: "validation_failed"; job: PrWalkthroughJobRecord; retryable: true; validation: PrWalkthroughValidationSummary };

export type WalkthroughYamlValidationResult =
	| { ok: true; document: Record<string, unknown>; warnings?: WalkthroughWarning[]; payload?: WalkthroughStorePayload }
	| { ok: false; summary: PrWalkthroughValidationSummary };

const WALKTHROUGH_ALLOWED_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"readonly_bash",
	"submit_pr_walkthrough_yaml",
];

export class WalkthroughAgentManager {
	private readonly stateDir: string;
	private readonly store: WalkthroughAgentStore;
	private readonly reminderUnsubscribers = new Map<string, () => void>();

	constructor(private readonly deps: WalkthroughAgentManagerDeps) {
		this.stateDir = deps.stateDir ?? bobbitStateDir();
		this.store = deps.store ?? new WalkthroughAgentStore(this.stateDir);
	}

	async launch(input: LaunchWalkthroughRequest): Promise<LaunchWalkthroughResponse> {
		const parentSessionId = stringValue(input.sessionId) ?? stringValue(input.parentSessionId);
		if (!parentSessionId) throw routeError(400, "sessionId is required", { code: "INVALID_LAUNCH_REQUEST" });

		const parent = this.getSession(parentSessionId);
		const target = canonicalizeTarget(input);
		const existing = this.store.findByParentAndTarget(parentSessionId, target.canonicalKey);
		if (existing && this.shouldReuse(existing)) {
			return { ...responseFromJob(existing), created: false };
		}

		const cwd = await this.resolveCwd(input, parentSessionId, parent);
		const projectId = stringValue(input.projectId) ?? stringValue(parent?.projectId);
		const jobId = `prw-${randomUUID()}`;
		const childSessionId = `prw-session-${randomUUID()}`;
		const changesetId = changesetIdForTarget(target);
		const title = titleForTarget(target);
		let job = this.store.create({
			jobId,
			parentSessionId,
			childSessionId,
			projectId,
			cwd,
			target,
			changesetId,
			tabId: `walkthrough:${changesetId}`,
			status: "starting",
			title,
		});
		this.broadcastJob(job);

		if (!this.deps.sessionManager) {
			job = this.store.update(jobId, {
				status: "error",
				error: {
					code: "AGENT_CREATE_FAILED",
					message: "PR walkthrough launch is waiting for SessionManager integration. routes.ts accepts a walkthroughAgentManager dependency for this seam.",
					retryable: true,
				},
			}) ?? job;
			this.broadcastJob(job);
			return { ...responseFromJob(job), created: true };
		}

		let child: SessionLike;
		try {
			child = await this.deps.sessionManager.createSession(
				cwd,
				undefined,
				undefined,
				undefined,
				{
					sessionId: childSessionId,
					rolePrompt: buildRolePrompt(target),
					roleName: "pr-walkthrough",
					role: "pr-walkthrough",
					accessory: "review",
					allowedTools: WALKTHROUGH_ALLOWED_TOOLS,
					projectId,
					sandboxed: parent?.sandboxed,
					env: {
						BOBBIT_SESSION_ID: childSessionId,
						BOBBIT_WALKTHROUGH_JOB_ID: jobId,
					},
				},
			);
		} catch (error) {
			const typed = classifyAgentError(error, "AGENT_CREATE_FAILED");
			job = this.store.update(jobId, { status: "error", error: typed }) ?? job;
			this.broadcastJob(job);
			throw routeError(502, typed.message, { code: typed.code, retryable: typed.retryable, job });
		}

		this.applySessionMetadata(child, job);
		this.deps.sessionManager.setTitle?.(childSessionId, title, { markGenerated: true });
		job = this.store.update(jobId, { status: "waiting_for_yaml" }) ?? job;
		this.broadcastJob(job);
		this.attachIdleReminder(childSessionId, jobId, child.rpcClient);

		try {
			const result = child.rpcClient?.prompt
				? await child.rpcClient.prompt(buildKickoffPrompt(job))
				: await this.deps.sessionManager.enqueuePrompt?.(childSessionId, buildKickoffPrompt(job), { source: "system" });
			if (isFailureResult(result)) throw new Error(result.error);
		} catch (error) {
			const typed = classifyAgentError(error, "PROMPT_DISPATCH_FAILED");
			job = this.store.update(jobId, { status: "error", error: typed }) ?? job;
			this.broadcastJob(job);
		}

		return { ...responseFromJob(job), created: true };
	}

	getJob(jobId: string): PrWalkthroughJobRecord | null {
		return this.store.get(jobId);
	}

	getJobForSession(childSessionId: string): PrWalkthroughJobRecord | null {
		return this.store.getByChildSession(childSessionId);
	}

	async submitYaml(input: SubmitWalkthroughYamlRequest): Promise<SubmitWalkthroughYamlResponse> {
		if (!input.sessionId || !input.jobId || typeof input.yaml !== "string") {
			throw routeError(400, "Missing required fields: sessionId, jobId, yaml", { code: "INVALID_SUBMIT_REQUEST" });
		}
		const job = this.store.get(input.jobId);
		if (!job) throw routeError(404, "No PR walkthrough job found for this jobId", { code: "JOB_NOT_FOUND" });
		if (job.childSessionId !== input.sessionId) {
			throw routeError(403, "Session is not allowed to submit YAML for this walkthrough job", { code: "WALKTHROUGH_JOB_SESSION_MISMATCH" });
		}

		const validation = await this.validateYaml(input.yaml, job);
		if (!validation.ok) {
			const updated = this.store.update(job.jobId, {
				status: "validation_failed",
				lastValidationError: validation.summary,
				error: { code: "YAML_SCHEMA_INVALID", message: validation.summary.message, retryable: true },
			}) ?? job;
			this.broadcastJob(updated);
			return { ok: false, status: "validation_failed", retryable: true, validation: validation.summary, job: updated };
		}

		const payload = validation.payload ?? await this.mapYamlToPayload(validation.document, job);
		const stored = saveWalkthrough(payload, this.stateDir);
		const warnings = [...(validation.warnings ?? []), ...(payload.warnings ?? [])];
		const updated = this.store.update(job.jobId, {
			status: "ready",
			lastValidationError: undefined,
			error: undefined,
			submittedAt: new Date().toISOString(),
			payloadUpdatedAt: stored.updatedAt,
			warnings,
		}) ?? job;
		this.broadcastJob(updated);
		return {
			ok: true,
			status: "ready",
			job: updated,
			changesetId: updated.changesetId,
			warnings,
			message: "PR walkthrough YAML accepted and published. Stay available for follow-up questions in this session.",
		};
	}

	restore(): void {
		for (const job of this.store.list()) {
			if (job.status === "ready" || job.status === "error") continue;
			const session = this.deps.sessionManager?.getSession?.(job.childSessionId);
			if (session) this.attachIdleReminder(job.childSessionId, job.jobId, session.rpcClient);
		}
	}

	private async validateYaml(yamlText: string, job: PrWalkthroughJobRecord): Promise<WalkthroughYamlValidationResult> {
		if (this.deps.validateYaml) return this.deps.validateYaml(yamlText, job);
		const schemaValidation = await tryExternalSchemaValidation(yamlText, job);
		if (schemaValidation) return schemaValidation;
		return fallbackValidateYaml(yamlText, job);
	}

	private async mapYamlToPayload(document: Record<string, unknown>, job: PrWalkthroughJobRecord): Promise<WalkthroughStorePayload> {
		if (this.deps.mapYamlToPayload) return this.deps.mapYamlToPayload(document, job);
		return fallbackMapYamlToPayload(document, job);
	}

	private getSession(sessionId: string): SessionLike | PersistedSessionLike | undefined {
		return this.deps.sessionManager?.getSession?.(sessionId) ?? this.deps.sessionManager?.getPersistedSession?.(sessionId);
	}

	private async resolveCwd(input: LaunchWalkthroughRequest, parentSessionId: string, parent: SessionLike | PersistedSessionLike | undefined): Promise<string> {
		const explicit = stringValue(input.cwd);
		if (explicit) return explicit;
		const resolved = await this.deps.resolveSessionCwd?.(parentSessionId);
		if (resolved) return resolved;
		return stringValue(parent?.worktreePath) ?? stringValue(parent?.cwd) ?? this.deps.defaultCwd;
	}

	private shouldReuse(job: PrWalkthroughJobRecord): boolean {
		if (job.status === "ready" || job.status === "error") return true;
		const session = this.getSession(job.childSessionId);
		return !session || (session.status !== "terminated" && session.status !== "archived" && session.archived !== true);
	}

	private applySessionMetadata(session: SessionLike, job: PrWalkthroughJobRecord): void {
		const updates = {
			role: "pr-walkthrough",
			accessory: "review",
			parentSessionId: job.parentSessionId,
			childKind: "pr-walkthrough",
			walkthroughJobId: job.jobId,
			walkthroughChangesetId: job.changesetId,
			walkthroughTargetKey: job.target.canonicalKey,
			readOnly: true,
		};
		Object.assign(session, updates, { allowedTools: WALKTHROUGH_ALLOWED_TOOLS });
		// TODO(pr-walkthrough integration): session-manager.ts currently types only legacy
		// metadata. The store accepts unknown fields at runtime; the dedicated session
		// metadata task should add first-class types/serialization for these fields.
		this.deps.sessionManager?.updateSessionMeta?.(job.childSessionId, updates);
	}

	private attachIdleReminder(sessionId: string, jobId: string, rpcClient: RpcLike | undefined): void {
		if (!rpcClient?.onEvent || this.reminderUnsubscribers.has(jobId)) return;
		const unsubscribe = rpcClient.onEvent((event) => {
			if (!isRecord(event) || event.type !== "agent_end") return;
			void this.remindIfNeeded(sessionId, jobId);
		});
		this.reminderUnsubscribers.set(jobId, unsubscribe);
	}

	private async remindIfNeeded(sessionId: string, jobId: string): Promise<void> {
		const job = this.store.get(jobId);
		if (!job || job.status === "ready" || job.status === "error" || (job.reminderCount ?? 0) >= 2) return;
		const prompt = job.lastValidationError
			? `Your last PR walkthrough YAML submission was invalid. Retry by calling submit_pr_walkthrough_yaml with corrected YAML. Errors:\n${job.lastValidationError.errors.map(error => `- ${error.path}: ${error.message}`).join("\n")}`
			: "You went idle without publishing the walkthrough. Call submit_pr_walkthrough_yaml with valid YAML; the panel only populates through that tool.";
		this.store.update(jobId, { reminderCount: (job.reminderCount ?? 0) + 1 });
		await this.deps.sessionManager?.enqueuePrompt?.(sessionId, prompt, { isSteered: true, source: "system" });
	}

	private broadcastJob(job: PrWalkthroughJobRecord): void {
		this.deps.broadcast?.({ type: "pr_walkthrough_job_updated", job });
	}
}

export function canonicalizeTarget(input: LaunchWalkthroughRequest): PrWalkthroughTarget {
	const prUrl = stringValue(input.prUrl);
	const parsed = prUrl ? parseGithubPrUrl(prUrl) : undefined;
	const owner = stringValue(input.owner) ?? parsed?.owner;
	const repo = stringValue(input.repo) ?? parsed?.repo;
	const number = numberValue(input.prNumber) ?? parsed?.number;
	const baseSha = stringValue(input.baseSha);
	const headSha = stringValue(input.headSha);
	if (owner && repo && number !== undefined) {
		const url = prUrl ?? `https://github.com/${owner}/${repo}/pull/${number}`;
		return { provider: "github", prUrl: url, owner, repo, number, baseSha, headSha, canonicalKey: `github:${owner}/${repo}#${number}` };
	}
	if (number !== undefined) {
		return { provider: "github", prUrl, number, baseSha, headSha, canonicalKey: `github:unknown/unknown#${number}` };
	}
	if (baseSha && headSha) {
		return { provider: "local", baseSha, headSha, canonicalKey: `local:${baseSha}..${headSha}` };
	}
	throw routeError(400, "A GitHub PR URL/number or local baseSha/headSha is required", { code: "INVALID_TARGET" });
}

function changesetIdForTarget(target: PrWalkthroughTarget): string {
	if (target.provider === "github") {
		const repo = target.owner && target.repo ? `${target.owner}/${target.repo}` : "unknown/unknown";
		return `github:${repo}#${target.number ?? "unknown"}`;
	}
	return `${shortSha(target.baseSha ?? "unknown")}..${shortSha(target.headSha ?? "unknown")}`;
}

function titleForTarget(target: PrWalkthroughTarget): string {
	return target.provider === "github" && target.number !== undefined ? `PR #${target.number} Walkthrough` : "Changeset Walkthrough";
}

function responseFromJob(job: PrWalkthroughJobRecord): Omit<LaunchWalkthroughResponse, "created"> {
	return {
		jobId: job.jobId,
		childSessionId: job.childSessionId,
		changesetId: job.changesetId,
		tabId: job.tabId,
		status: job.status,
		title: job.title,
		job,
	};
}

function buildRolePrompt(target: PrWalkthroughTarget): string {
	return [
		"You are a read-only PR walkthrough agent.",
		"Investigate the PR using only read-only tools and report rough percentage progress in chat.",
		"Do not edit files, run tests/builds, install dependencies, push, commit, or submit GitHub reviews/comments.",
		"When complete, call submit_pr_walkthrough_yaml with exactly one YAML document matching the PR walkthrough schema. The panel will remain empty until that tool succeeds.",
		`Target: ${target.canonicalKey}`,
	].join("\n");
}

function buildKickoffPrompt(job: PrWalkthroughJobRecord): string {
	return [
		`Review target: ${job.target.canonicalKey}`,
		job.target.prUrl ? `PR URL: ${job.target.prUrl}` : undefined,
		job.target.baseSha && job.target.headSha ? `Range: ${job.target.baseSha}..${job.target.headSha}` : undefined,
		"Start by saying you are beginning the investigation with an approximate progress percentage.",
		"Populate the panel only by calling submit_pr_walkthrough_yaml with valid YAML. Stay available after success.",
	].filter(Boolean).join("\n");
}

async function tryExternalSchemaValidation(yamlText: string, job: PrWalkthroughJobRecord): Promise<WalkthroughYamlValidationResult | null> {
	try {
		const modulePath = "./walkthrough-yaml-schema.js";
		const mod = await import(modulePath) as Record<string, unknown>;
		const fn = mod.validatePrWalkthroughYaml ?? mod.validateWalkthroughYaml ?? mod.parsePrWalkthroughYaml;
		if (typeof fn !== "function") return null;
		const result = await (fn as (text: string, job: PrWalkthroughJobRecord) => unknown)(yamlText, job);
		if (!isRecord(result)) return null;
		if (result.ok === false) {
			return { ok: false, summary: normalizeValidationSummary(result.summary ?? result.error ?? result, yamlText) };
		}
		const document = isRecord(result.document) ? result.document : isRecord(result.value) ? result.value : undefined;
		if (!document) return null;
		return {
			ok: true,
			document,
			warnings: Array.isArray(result.warnings) ? result.warnings as WalkthroughWarning[] : undefined,
			payload: isRecord(result.payload) ? result.payload as unknown as WalkthroughStorePayload : undefined,
		};
	} catch {
		return null;
	}
}

function fallbackValidateYaml(yamlText: string, job: PrWalkthroughJobRecord): WalkthroughYamlValidationResult {
	const yamlHash = createHash("sha256").update(yamlText).digest("hex").slice(0, 16);
	if (Buffer.byteLength(yamlText, "utf-8") > 512_000) {
		return invalid([{ path: "$", message: "YAML exceeds the 512KB limit; prioritize the most important review chunks." }], yamlHash);
	}
	let docs: yaml.Document.Parsed[];
	try {
		docs = yaml.parseAllDocuments(yamlText);
	} catch (error) {
		return invalid([{ path: "$", message: error instanceof Error ? error.message : String(error) }], yamlHash);
	}
	if (docs.length !== 1) return invalid([{ path: "$", message: "Submit exactly one YAML document." }], yamlHash);
	const doc = docs[0];
	if (doc.errors.length > 0) return invalid(doc.errors.map((error, index) => ({ path: `$[parseError${index}]`, message: error.message })), yamlHash);
	const value = doc.toJSON();
	if (!isRecord(value)) return invalid([{ path: "$", message: "YAML root must be an object." }], yamlHash);
	const errors: PrWalkthroughValidationIssue[] = [];
	if (value.schema_version !== 1) errors.push({ path: "schema_version", message: "schema_version must be 1." });
	const pr = value.pr;
	if (!isRecord(pr)) errors.push({ path: "pr", message: "pr object is required." });
	else {
		if (pr.provider !== "github") errors.push({ path: "pr.provider", message: "Only provider: github is supported for PR walkthrough agent submissions." });
		if (job.target.owner && pr.owner !== job.target.owner) errors.push({ path: "pr.owner", message: `Must match launch target owner ${job.target.owner}.` });
		if (job.target.repo && pr.repo !== job.target.repo) errors.push({ path: "pr.repo", message: `Must match launch target repo ${job.target.repo}.` });
		if (job.target.number !== undefined && pr.number !== job.target.number) errors.push({ path: "pr.number", message: `Must match launch target PR #${job.target.number}.` });
		for (const field of ["title", "url", "base_sha", "head_sha"] as const) {
			if (typeof pr[field] !== "string" || !pr[field]) errors.push({ path: `pr.${field}`, message: `${field} is required.` });
		}
	}
	const walkthrough = value.walkthrough;
	if (!isRecord(walkthrough)) errors.push({ path: "walkthrough", message: "walkthrough object is required." });
	else {
		for (const field of ["context", "merge_assessment", "audit", "display"] as const) {
			if (!isRecord(walkthrough[field])) errors.push({ path: `walkthrough.${field}`, message: `${field} object is required.` });
		}
		for (const field of ["design_decisions", "review_chunks", "omissions_and_followups"] as const) {
			if (!Array.isArray(walkthrough[field])) errors.push({ path: `walkthrough.${field}`, message: `${field} array is required.` });
		}
	}
	if (errors.length > 0) return invalid(errors, yamlHash);
	return { ok: true, document: value };
}

function invalid(errors: PrWalkthroughValidationIssue[], yamlHash: string): WalkthroughYamlValidationResult {
	return { ok: false, summary: validationSummary(errors, yamlHash) };
}

function validationSummary(errors: PrWalkthroughValidationIssue[], yamlHash: string): PrWalkthroughValidationSummary {
	return { code: "YAML_SCHEMA_INVALID", message: "PR walkthrough YAML failed validation.", errors, retryable: true, yamlHash };
}

function fallbackMapYamlToPayload(document: Record<string, unknown>, job: PrWalkthroughJobRecord): WalkthroughStorePayload {
	const pr = isRecord(document.pr) ? document.pr : {};
	const walkthrough = isRecord(document.walkthrough) ? document.walkthrough : {};
	const context = isRecord(walkthrough.context) ? walkthrough.context : {};
	const merge = isRecord(walkthrough.merge_assessment) ? walkthrough.merge_assessment : {};
	const audit = isRecord(walkthrough.audit) ? walkthrough.audit : {};
	const chunks = Array.isArray(walkthrough.review_chunks) ? walkthrough.review_chunks.filter(isRecord) : [];
	const decisions = Array.isArray(walkthrough.design_decisions) ? walkthrough.design_decisions.filter(isRecord) : [];
	const omissions = Array.isArray(walkthrough.omissions_and_followups) ? walkthrough.omissions_and_followups.filter(isRecord) : [];
	return {
		changesetId: job.changesetId,
		changeset: {
			provider: "github",
			baseSha: stringValue(pr.base_sha) ?? "unknown",
			headSha: stringValue(pr.head_sha) ?? "unknown",
			prUrl: stringValue(pr.url) ?? job.target.prUrl,
			prNumber: numberValue(pr.number) ?? job.target.number,
			prTitle: stringValue(pr.title),
			prBody: isRecord(pr.original_description) ? stringValue(pr.original_description.body) : undefined,
			title: stringValue(pr.title) ?? job.title,
			filesChanged: numberValue(isRecord(pr.stats) ? pr.stats.files_changed : undefined),
			additions: numberValue(isRecord(pr.stats) ? pr.stats.additions : undefined),
			deletions: numberValue(isRecord(pr.stats) ? pr.stats.deletions : undefined),
		},
		cards: [
			{
				id: "orientation",
				phaseId: "orientation",
				title: "Orientation",
				summary: stringValue(context.problem_solved) ?? stringValue(merge.summary) ?? "Review the PR context and author intent.",
				rationale: Object.entries(context).map(([key, value]) => `${key}: ${String(value)}`).join("\n"),
				diffBlocks: [],
				checklist: arrayOfStrings(isRecord(audit) ? audit.reviewer_checklist : undefined),
			},
			...decisions.map((decision, index) => ({
				id: stringValue(decision.id) ?? `design-${index + 1}`,
				phaseId: "design" as const,
				title: stringValue(decision.title) ?? `Design decision ${index + 1}`,
				summary: stringValue(decision.explanation) ?? "Design decision from submitted walkthrough YAML.",
				rationale: stringValue(decision.chosen_approach),
				diffBlocks: [],
				cardSuggestions: arrayOfStrings(decision.suggested_reviewer_concerns),
			})),
			...chunks.map((chunk, index) => ({
				id: stringValue(chunk.id) ?? `chunk-${index + 1}`,
				phaseId: phaseForChunk(stringValue(chunk.phase)),
				title: stringValue(chunk.title) ?? `Review chunk ${index + 1}`,
				summary: stringValue(chunk.explanation) ?? stringValue(chunk.reviewer_goal) ?? "Review chunk from submitted walkthrough YAML.",
				rationale: stringValue(chunk.reviewer_goal),
				diffBlocks: [],
				cardSuggestions: arrayOfStrings(chunk.positive_notes),
			})),
			{
				id: "omissions-and-followups",
				phaseId: "other",
				title: "Omissions and follow-ups",
				summary: omissions.map(item => stringValue(item.concern)).filter(Boolean).join("\n") || "No omissions listed.",
				diffBlocks: [],
				cardSuggestions: omissions.map(item => stringValue(item.suggested_comment)).filter((item): item is string => Boolean(item)),
			},
			{
				id: "audit",
				phaseId: "audit",
				title: "Audit",
				summary: arrayOfStrings(audit.remaining_changed_areas).join("\n") || "Final audit checklist.",
				diffBlocks: [],
				checklist: arrayOfStrings(audit.reviewer_checklist),
			},
		],
		warnings: [{ code: "yaml-fallback-mapper", severity: "warning", message: "Walkthrough YAML was accepted with the fallback mapper; diff hunk anchors will be enriched when the YAML schema mapper is integrated." }],
		export: { provider: "github", available: false, previewOnly: true, reason: "GitHub submission remains explicit and is handled by the existing export flow." },
	};
}

function normalizeValidationSummary(value: unknown, yamlText: string): PrWalkthroughValidationSummary {
	if (isRecord(value) && Array.isArray(value.errors)) {
		return {
			code: stringValue(value.code) ?? "YAML_SCHEMA_INVALID",
			message: stringValue(value.message) ?? "PR walkthrough YAML failed validation.",
			errors: value.errors.filter(isRecord).map(error => ({ path: stringValue(error.path) ?? "$", message: stringValue(error.message) ?? "Invalid value." })),
			retryable: value.retryable !== false,
			yamlHash: stringValue(value.yamlHash) ?? createHash("sha256").update(yamlText).digest("hex").slice(0, 16),
		};
	}
	return validationSummary([{ path: "$", message: stringValue(value) ?? "Invalid YAML." }], createHash("sha256").update(yamlText).digest("hex").slice(0, 16));
}

function classifyAgentError(error: unknown, fallbackCode: string): PrWalkthroughJobError {
	const message = error instanceof Error ? error.message : String(error);
	const code = /model|api key|provider|unavailable/i.test(message) ? "MODEL_UNAVAILABLE" : fallbackCode;
	return { code, message, retryable: true };
}

function routeError(status: number, message: string, extra?: Record<string, unknown>): Error & { status?: number; extra?: Record<string, unknown> } {
	const error = new Error(message) as Error & { status?: number; extra?: Record<string, unknown> };
	error.status = status;
	error.extra = extra;
	return error;
}

function parseGithubPrUrl(input: string): { owner: string; repo: string; number: number } | undefined {
	try {
		const url = new URL(input);
		if (url.hostname !== "github.com") return undefined;
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length >= 4 && parts[2] === "pull") {
			const number = Number(parts[3]);
			if (Number.isInteger(number) && number > 0) return { owner: parts[0], repo: parts[1], number };
		}
	} catch { /* not a URL */ }
	return undefined;
}

function phaseForChunk(phase: string | undefined): "significant" | "other" | "audit" {
	return phase === "audit" ? "audit" : phase === "other" ? "other" : "significant";
}

function arrayOfStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortSha(value: string): string {
	return value.length > 7 ? value.slice(0, 7) : value;
}

function isFailureResult(value: unknown): value is { success: false; error: string } {
	return isRecord(value) && value.success === false && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
