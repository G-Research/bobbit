import { createHash, randomUUID } from "node:crypto";

import { bobbitStateDir } from "../bobbit-dir.js";
import { execFileSafe } from "../exec-file-safe.js";
import { isTrustedExternalHost, normalizeTrustedHosts } from "../../shared/pr-walkthrough/url-safety.js";
import { resolveGithubPr, GithubPrAdapterError, parseGithubRemoteUrl } from "./github-adapter.js";
import { resolveLocalChangeset } from "./git-changeset.js";
import {
	WalkthroughAnalysisBundleStore,
	analysisBundleToParsedDiff,
	createAnalysisBundleFromParsedDiff,
	missingBundleError,
	type ReadPrWalkthroughBundleRequest,
} from "./walkthrough-analysis-bundle.js";
import { saveWalkthrough, type WalkthroughStorePayload } from "./walkthrough-store.js";
import {
	mapYamlToWalkthroughPayload as defaultMapYamlToWalkthroughPayload,
	validatePrWalkthroughYaml as defaultValidatePrWalkthroughYaml,
	type PrWalkthroughYamlDocument,
	type WalkthroughParsedDiffForYamlMapping,
} from "./walkthrough-yaml-schema.js";
import {
	WalkthroughAgentStore,
	createSubmissionProof,
	hashSubmissionProof,
	verifySubmissionProof,
	walkthroughTargetEnvForJob,
	type PrWalkthroughJobError,
	type PrWalkthroughJobRecord,
	type PrWalkthroughTarget,
	type PrWalkthroughValidationIssue,
	type PrWalkthroughValidationSummary,
	type WalkthroughWarning,
} from "./walkthrough-agent-store.js";

type RpcLike = {
	prompt?: (text: string, images?: any) => Promise<unknown> | unknown;
	onEvent?: (handler: (event: unknown) => void) => (() => void);
};

type SessionLike = {
	id: string;
	title?: string;
	cwd?: string;
	worktreePath?: string;
	status?: string;
	archived?: boolean;
	projectId?: string;
	sandboxed?: boolean;
	rpcClient?: RpcLike;
	allowedTools?: string[];
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
};

export type WalkthroughSessionManagerLike = {
	createSession: (
		cwd: string,
		agentArgs?: string[],
		goalId?: string,
		assistantType?: string,
		opts?: any,
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
	preferencesStore?: { get(key: string): unknown };
	broadcast?: (event: Record<string, unknown>) => void;
	preflightGithubLaunch?: boolean | ((job: PrWalkthroughJobRecord) => Promise<void> | void);
	validateYaml?: (yamlText: string, job: PrWalkthroughJobRecord) => Promise<WalkthroughYamlValidationResult> | WalkthroughYamlValidationResult;
	mapYamlToPayload?: (document: Record<string, unknown>, job: PrWalkthroughJobRecord) => Promise<WalkthroughStorePayload> | WalkthroughStorePayload;
	resolveDiffForYamlMapping?: (document: Record<string, unknown>, job: PrWalkthroughJobRecord) => Promise<WalkthroughParsedDiffForYamlMapping> | WalkthroughParsedDiffForYamlMapping;
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
	submissionProof?: string;
};

export type SubmitWalkthroughYamlResponse =
	| { ok: true; status: "ready"; job: PrWalkthroughJobRecord; changesetId: string; message: string; warnings: WalkthroughWarning[] }
	| { ok: false; status: "validation_failed"; job: PrWalkthroughJobRecord; retryable: true; validation: PrWalkthroughValidationSummary };

export type WalkthroughYamlValidationResult =
	| { ok: true; document: Record<string, unknown>; warnings?: WalkthroughWarning[]; payload?: WalkthroughStorePayload }
	| { ok: false; summary: PrWalkthroughValidationSummary };

class WalkthroughYamlValidationFailure extends Error {
	constructor(readonly summary: PrWalkthroughValidationSummary) {
		super(summary.message);
	}
}

export const WALKTHROUGH_ALLOWED_TOOLS = [
	"readonly_bash",
	"read_pr_walkthrough_bundle",
	"submit_pr_walkthrough_yaml",
];

export class WalkthroughAgentManager {
	private readonly stateDir: string;
	private readonly store: WalkthroughAgentStore;
	private readonly bundleStore: WalkthroughAnalysisBundleStore;
	private readonly reminderUnsubscribers = new Map<string, () => void>();
	private readonly launchInFlight = new Map<string, Promise<LaunchWalkthroughResponse>>();

	constructor(private readonly deps: WalkthroughAgentManagerDeps) {
		this.stateDir = deps.stateDir ?? bobbitStateDir();
		this.store = deps.store ?? new WalkthroughAgentStore(this.stateDir);
		this.bundleStore = new WalkthroughAnalysisBundleStore(this.stateDir);
	}

	async launch(input: LaunchWalkthroughRequest): Promise<LaunchWalkthroughResponse> {
		const parentSessionId = stringValue(input.sessionId) ?? stringValue(input.parentSessionId);
		if (!parentSessionId) throw routeError(400, "sessionId is required", { code: "INVALID_LAUNCH_REQUEST" });

		const parent = this.getSession(parentSessionId);
		this.assertLaunchableParent(parentSessionId, parent);
		const cwd = await this.resolveCwd(input, parentSessionId, parent);
		const target = await this.resolveLaunchTarget(input, cwd);
		const existing = this.store.findByParentAndTarget(parentSessionId, target.canonicalKey);
		if (existing && this.shouldReuse(existing)) {
			return { ...responseFromJob(existing), created: false };
		}

		const launchKey = `${parentSessionId}\0${target.canonicalKey}`;
		const inFlight = this.launchInFlight.get(launchKey);
		if (inFlight) {
			const result = await inFlight;
			return { ...result, created: false };
		}

		const promise = this.launchNew(input, parentSessionId, parent, target, cwd);
		this.launchInFlight.set(launchKey, promise);
		try {
			return await promise;
		} finally {
			this.launchInFlight.delete(launchKey);
		}
	}

	private async launchNew(input: LaunchWalkthroughRequest, parentSessionId: string, parent: SessionLike | PersistedSessionLike, target: PrWalkthroughTarget, cwd: string): Promise<LaunchWalkthroughResponse> {
		const projectId = stringValue(input.projectId) ?? stringValue(parent.projectId);
		const jobId = `prw-${randomUUID()}`;
		const childSessionId = `prw-session-${randomUUID()}`;
		const changesetId = changesetIdForTarget(target);
		const title = titleForTarget(target);
		const submissionProof = createSubmissionProof();
		let job = this.store.create({
			jobId,
			parentSessionId,
			childSessionId,
			projectId,
			cwd,
			target,
			changesetId,
			tabId: `walkthrough:${encodeURIComponent(changesetId)}`,
			status: "starting",
			title,
			submissionProofHash: hashSubmissionProof(jobId, childSessionId, submissionProof),
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

		try {
			job = await this.resolveAndPersistLaunchBundle(job);
		} catch (error) {
			const typed = classifyDiffResolutionError(error);
			job = this.store.update(jobId, { status: "error", error: typed }) ?? job;
			this.broadcastJob(job);
			return { ...responseFromJob(job), created: true };
		}

		const targetEnv = walkthroughTargetEnvForJob(job);
		const initialModel = await this.resolveParentInitialModel(parentSessionId, parent);
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
					parentSessionId,
					childKind: "pr-walkthrough",
					readOnly: true,
					walkthroughJobId: jobId,
					walkthroughChangesetId: changesetId,
					walkthroughTargetKey: target.canonicalKey,
					initialModel,
					env: {
						BOBBIT_SESSION_ID: childSessionId,
						BOBBIT_WALKTHROUGH_JOB_ID: jobId,
						BOBBIT_WALKTHROUGH_SUBMIT_PROOF: submissionProof,
						...targetEnv,
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
		this.attachRuntimeListeners(childSessionId, jobId, child.rpcClient);

		try {
			const prompt = buildKickoffPrompt(job);
			const result = this.deps.sessionManager.enqueuePrompt
				? await this.deps.sessionManager.enqueuePrompt(childSessionId, prompt, { source: "system" })
				: await child.rpcClient?.prompt?.(prompt);
			if (isFailureResult(result)) throw new Error(result.error);
		} catch (error) {
			if (isRecoverablePromptDispatchError(error)) {
				// SessionManager re-enqueues transient bridge rejections (most commonly
				// "Agent is already processing") and drains them on the next tick. Keep
				// the child in the waiting state rather than showing a terminal launch
				// error while the kickoff prompt is still queued for delivery.
				job = this.store.update(jobId, { status: "waiting_for_yaml" }) ?? job;
				this.broadcastJob(job);
			} else {
				const typed = classifyAgentError(error, "PROMPT_DISPATCH_FAILED");
				job = this.store.update(jobId, { status: "error", error: typed }) ?? job;
				this.broadcastJob(job);
				await this.notifyChildOfError(child, typed, "kickoff prompt dispatch");
			}
		}

		return { ...responseFromJob(job), created: true };
	}

	getJob(jobId: string): PrWalkthroughJobRecord | null {
		return publicJob(this.store.get(jobId));
	}

	getJobForSession(childSessionId: string): PrWalkthroughJobRecord | null {
		return publicJob(this.store.getByChildSession(childSessionId));
	}

	readBundle(input: ReadPrWalkthroughBundleRequest): Record<string, unknown> {
		if (!input.sessionId || !input.jobId) {
			throw routeError(400, "Missing required fields: sessionId and jobId", { code: "INVALID_BUNDLE_READ_REQUEST", retryable: false });
		}
		const job = this.store.get(input.jobId);
		if (!job) throw routeError(404, "No PR walkthrough job found for this jobId", { code: "JOB_NOT_FOUND", retryable: false });
		if (job.childSessionId !== input.sessionId) {
			throw routeError(403, "Session is not allowed to read the analysis bundle for this walkthrough job", { code: "WALKTHROUGH_JOB_SESSION_MISMATCH", retryable: false });
		}
		return this.bundleStore.read(job, input);
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
		if (!verifySubmissionProof(input.submissionProof, job)) {
			throw routeError(403, "PR walkthrough YAML submissions must come from the scoped walkthrough tool runtime.", { code: "WALKTHROUGH_SUBMIT_PROOF_REQUIRED", retryable: false });
		}
		if (job.status === "ready") {
			throw routeError(409, "This PR walkthrough has already accepted a YAML submission. The published payload will not be mutated by follow-up tool calls.", {
				code: "WALKTHROUGH_ALREADY_READY",
				retryable: false,
				job: publicJob(job),
			});
		}

		const validation = await this.validateYaml(input.yaml, job);
		if (!validation.ok) {
			const updated = this.store.update(job.jobId, {
				status: "validation_failed",
				lastValidationError: validation.summary,
				error: { code: "YAML_SCHEMA_INVALID", message: validation.summary.message, retryable: true },
			}) ?? job;
			this.broadcastJob(updated);
			return { ok: false, status: "validation_failed", retryable: true, validation: validation.summary, job: publicJob(updated) ?? updated };
		}

		let payload: WalkthroughStorePayload;
		try {
			payload = validation.payload ?? await this.mapYamlToPayload(validation.document, job, input.yaml);
		} catch (error) {
			if (error instanceof WalkthroughYamlValidationFailure) {
				const updated = this.store.update(job.jobId, {
					status: "validation_failed",
					lastValidationError: error.summary,
					error: { code: "YAML_SCHEMA_INVALID", message: error.summary.message, retryable: true },
				}) ?? job;
				this.broadcastJob(updated);
				return { ok: false, status: "validation_failed", retryable: true, validation: error.summary, job: publicJob(updated) ?? updated };
			}
			const typed = classifyDiffResolutionError(error);
			const updated = this.store.update(job.jobId, { status: "error", error: typed }) ?? job;
			this.broadcastJob(updated);
			throw routeError(statusForJobError(typed), typed.message, { code: typed.code, retryable: typed.retryable, job: publicJob(updated) });
		}
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
			job: publicJob(updated) ?? updated,
			changesetId: updated.changesetId,
			warnings,
			message: "PR walkthrough YAML accepted and published. Stay available for follow-up questions in this session.",
		};
	}

	restore(): void {
		for (const job of this.store.list()) {
			if (job.status === "ready" || job.status === "error") continue;
			const session = this.deps.sessionManager?.getSession?.(job.childSessionId);
			if (session) this.attachRuntimeListeners(job.childSessionId, job.jobId, session.rpcClient);
		}
	}

	private async resolveAndPersistLaunchBundle(job: PrWalkthroughJobRecord): Promise<PrWalkthroughJobRecord> {
		const parsedDiff = await this.resolveLaunchDiffForBundle(job);
		if (!parsedDiff) return job;
		const bundle = createAnalysisBundleFromParsedDiff(job, parsedDiff);
		const { metadata } = this.bundleStore.save(job.jobId, bundle);
		const baseSha = bundle.changeset.base_sha;
		const headSha = bundle.changeset.head_sha;
		return this.store.update(job.jobId, {
			analysisBundle: metadata,
			target: {
				...job.target,
				...(baseSha ? { baseSha } : {}),
				...(headSha ? { headSha } : {}),
			},
			warnings: bundle.warnings,
		}) ?? job;
	}

	private async resolveLaunchDiffForBundle(job: PrWalkthroughJobRecord): Promise<WalkthroughParsedDiffForYamlMapping | undefined> {
		if (job.target.provider !== "github") return undefined;
		if (job.target.baseSha && job.target.headSha) {
			const local = await localDiffForYaml(job.cwd, job.target.baseSha, job.target.headSha);
			return {
				...local,
				changeset: {
					...local.changeset,
					provider: "github",
					externalUrl: job.target.prUrl,
					prUrl: job.target.prUrl,
					prNumber: job.target.number,
					prTitle: job.title,
					prBody: "",
					title: job.title,
				},
				export: { provider: "github", available: false, previewOnly: true, reason: "GitHub submission requires launch-time GitHub metadata; preview is available." },
			};
		}
		if (typeof this.deps.preflightGithubLaunch === "function") await this.deps.preflightGithubLaunch(job);
		const resolved = await resolveGithubPr({
			cwd: job.cwd,
			prUrl: job.target.prUrl,
			prNumber: job.target.number,
			trustedHosts: this.getManagedTrustedHosts(),
		});
		return {
			changeset: resolved.changeset,
			files: resolved.files,
			warnings: resolved.warnings,
			export: resolved.export as unknown as WalkthroughParsedDiffForYamlMapping["export"],
		};
	}

	private async validateYaml(yamlText: string, job: PrWalkthroughJobRecord): Promise<WalkthroughYamlValidationResult> {
		if (this.deps.validateYaml) return this.deps.validateYaml(yamlText, job);
		const result = defaultValidatePrWalkthroughYaml(yamlText, { target: job.target });
		if (!result.ok) return { ok: false, summary: normalizeValidationSummary(result.summary, yamlText) };
		return { ok: true, document: result.document as unknown as Record<string, unknown> };
	}

	private async mapYamlToPayload(document: Record<string, unknown>, job: PrWalkthroughJobRecord, yamlText: string): Promise<WalkthroughStorePayload> {
		if (this.deps.mapYamlToPayload) return this.deps.mapYamlToPayload(document, job);
		const parsedDiff = await this.resolveDiffForYamlMapping(document, job);
		const authoritativeErrors = validateYamlAgainstAuthoritativeChangeset(document as unknown as PrWalkthroughYamlDocument, parsedDiff, job);
		if (authoritativeErrors.length > 0) {
			throw new WalkthroughYamlValidationFailure(validationSummary(authoritativeErrors, createHash("sha256").update(yamlText).digest("hex").slice(0, 16)));
		}
		return defaultMapYamlToWalkthroughPayload(document as unknown as PrWalkthroughYamlDocument, parsedDiff, {
			changesetId: job.changesetId,
			target: { ...job.target, changesetId: job.changesetId },
			export: parsedDiff.export ?? { provider: "github", available: false, previewOnly: true, reason: "GitHub submission remains explicit and is handled by the existing export flow." },
		});
	}

	private async resolveDiffForYamlMapping(document: Record<string, unknown>, job: PrWalkthroughJobRecord): Promise<WalkthroughParsedDiffForYamlMapping> {
		if (job.analysisBundle) {
			const bundle = this.bundleStore.load(job.jobId);
			if (!bundle) throw missingBundleError(job.jobId);
			return analysisBundleToParsedDiff(bundle);
		}
		if (job.target.provider === "github") throw missingBundleError(job.jobId);
		if (this.deps.resolveDiffForYamlMapping) return this.deps.resolveDiffForYamlMapping(document, job);
		const baseSha = job.target.baseSha;
		const headSha = job.target.headSha;

		if (job.target.provider === "local") {
			if (!baseSha || !headSha) throw new Error("Local walkthrough diff resolution requires baseSha and headSha.");
			return localDiffForYaml(job.cwd, baseSha, headSha);
		}

		throw new Error(`Unsupported PR walkthrough target provider: ${job.target.provider}`);
	}

	private getSession(sessionId: string): SessionLike | PersistedSessionLike | undefined {
		return this.deps.sessionManager?.getSession?.(sessionId) ?? this.deps.sessionManager?.getPersistedSession?.(sessionId);
	}

	private assertLaunchableParent(sessionId: string, parent: SessionLike | PersistedSessionLike | undefined): asserts parent is SessionLike | PersistedSessionLike {
		if (!parent) {
			throw routeError(404, `Parent session ${sessionId} was not found. Open or reload the launching session, then start the PR walkthrough again.`, {
				code: "PARENT_SESSION_NOT_FOUND",
				retryable: false,
			});
		}
		if (parent.archived === true || parent.status === "terminated" || parent.status === "archived") {
			throw routeError(409, `Parent session ${sessionId} is no longer active. Start the PR walkthrough from an active session.`, {
				code: "PARENT_SESSION_STALE",
				retryable: false,
			});
		}
	}

	private async resolveCwd(input: LaunchWalkthroughRequest, parentSessionId: string, parent: SessionLike | PersistedSessionLike | undefined): Promise<string> {
		const explicit = stringValue(input.cwd);
		if (explicit) return explicit;
		const resolved = await this.deps.resolveSessionCwd?.(parentSessionId);
		if (resolved) return resolved;
		return stringValue(parent?.worktreePath) ?? stringValue(parent?.cwd) ?? this.deps.defaultCwd;
	}

	private getManagedTrustedHosts(): string[] {
		return normalizeTrustedHosts(this.deps.preferencesStore?.get("githubTrustedHosts"));
	}

	/**
	 * Synchronous host trust check run BEFORE any job/child session is created, so an
	 * untrusted host aborts the launch cleanly (no stale walkthrough tab). The HTTP
	 * response carries { code: "untrusted_github_host", host } so the UI can prompt to
	 * add the host and retry.
	 */
	private assertTrustedGithubTarget(target: PrWalkthroughTarget): void {
		if (target.provider !== "github" || !target.prUrl) return;
		let host: string;
		try {
			host = new URL(target.prUrl).hostname.replace(/\.$/, "").toLowerCase();
		} catch {
			return;
		}
		if (!isTrustedExternalHost(host, this.getManagedTrustedHosts())) {
			throw routeError(400, `Untrusted GitHub PR host: ${host}`, { code: "untrusted_github_host", host, retryable: false });
		}
	}

	private async resolveLaunchTarget(input: LaunchWalkthroughRequest, cwd: string): Promise<PrWalkthroughTarget> {
		const target = canonicalizeTarget(input);
		if (target.provider === "local") {
			throw routeError(400, "Session-hosted PR walkthrough agents currently support GitHub pull requests only. Use the standalone local walkthrough resolver for local base/head changesets.", {
				code: "LOCAL_WALKTHROUGH_AGENT_UNSUPPORTED",
				retryable: false,
			});
		}
		const resolved = (target.provider !== "github" || (target.owner && target.repo))
			? target
			: await resolveNumberOnlyGithubTarget(target, cwd);
		this.assertTrustedGithubTarget(resolved);
		return resolved;
	}

	private async resolveParentInitialModel(parentSessionId: string, parent: SessionLike | PersistedSessionLike | undefined): Promise<string | undefined> {
		const resolved = await this.deps.resolveSessionModel?.(parentSessionId);
		return normalizeModelPref(resolved) ?? normalizeModelPref(parent);
	}

	private shouldReuse(job: PrWalkthroughJobRecord): boolean {
		const session = this.getSession(job.childSessionId);
		if (!session || session.status === "terminated" || session.status === "archived" || session.archived === true) return false;
		if ((job.status === "starting" || job.status === "waiting_for_yaml" || job.status === "validation_failed") && !job.submissionProofHash) return false;
		return job.status === "ready" || job.status === "error" || job.status === "starting" || job.status === "waiting_for_yaml" || job.status === "validation_failed";
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

	private attachRuntimeListeners(sessionId: string, jobId: string, rpcClient: RpcLike | undefined): void {
		if (!rpcClient?.onEvent || this.reminderUnsubscribers.has(jobId)) return;
		const unsubscribe = rpcClient.onEvent((event) => {
			const runtimeFailure = runtimeFailureMessage(event);
			if (runtimeFailure) {
				void this.markRuntimeFailure(sessionId, jobId, runtimeFailure);
				return;
			}
			if (!isRecord(event) || event.type !== "agent_end") return;
			void this.remindIfNeeded(sessionId, jobId);
		});
		this.reminderUnsubscribers.set(jobId, unsubscribe);
	}

	private async markRuntimeFailure(sessionId: string, jobId: string, message: string): Promise<void> {
		const job = this.store.get(jobId);
		if (!job || job.status === "ready" || job.status === "error") return;
		const error = { code: "AGENT_RUNTIME_FAILED", message: `PR walkthrough agent failed before publishing YAML: ${message}`, retryable: true };
		const updated = this.store.update(jobId, { status: "error", error }) ?? job;
		this.broadcastJob(updated);
		await this.notifyChildOfError(this.getSession(sessionId), error, "agent runtime");
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

	private async notifyChildOfError(session: SessionLike | PersistedSessionLike | undefined, error: PrWalkthroughJobError, phase: string): Promise<void> {
		if (!session?.id) return;
		const prompt = [
			`PR walkthrough ${phase} failed before the walkthrough could be published.`,
			`Error (${error.code}): ${error.message}`,
			error.retryable === false ? "This error is not retryable from the current session." : "Fix the issue, then relaunch or prompt this walkthrough session to retry when available.",
		].join("\n");
		const enqueuePrompt = this.deps.sessionManager?.enqueuePrompt;
		if (enqueuePrompt) {
			try {
				const result = await enqueuePrompt(session.id, prompt, { isSteered: true, source: "system" });
				if (!isFailureResult(result)) return;
			} catch {
				// Fall through to the direct RPC prompt path below.
			}
		}
		try {
			await ("rpcClient" in session ? session.rpcClient?.prompt?.(prompt) : undefined);
		} catch {
			// Best-effort transcript surfacing only; the panel state remains authoritative.
		}
	}

	private broadcastJob(job: PrWalkthroughJobRecord): void {
		this.deps.broadcast?.({ type: "pr_walkthrough_job_updated", job: publicJob(job) ?? job });
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
		const host = normalizeGithubHost(parsed?.host);
		const url = prUrl ?? `https://${host}/${owner}/${repo}/pull/${number}`;
		// github.com keeps its historical key shape for back-compat with persisted
		// jobs/tabs; other hosts include the host in identity to avoid cross-host
		// dedup collisions for the same owner/repo/number.
		const canonicalKey = host === "github.com"
			? `github:${owner}/${repo}#${number}`
			: `github:${host}/${owner}/${repo}#${number}`;
		return { provider: "github", prUrl: url, owner, repo, number, baseSha, headSha, host, canonicalKey };
	}
	if (number !== undefined) {
		return { provider: "github", prUrl, number, baseSha, headSha, host: "github.com", canonicalKey: `github:unknown/unknown#${number}` };
	}
	if (baseSha && headSha) {
		return { provider: "local", baseSha, headSha, canonicalKey: `local:${baseSha}..${headSha}` };
	}
	throw routeError(400, "A GitHub PR URL/number or local baseSha/headSha is required", { code: "INVALID_TARGET" });
}

async function resolveNumberOnlyGithubTarget(target: PrWalkthroughTarget, cwd: string): Promise<PrWalkthroughTarget> {
	const inferred = await inferGithubRepository(cwd);
	if (!inferred) {
		throw routeError(400, "A GitHub PR number requires a GitHub origin remote so Bobbit can scope readonly_bash to owner/repo/number. Pass a full GitHub PR URL or run from a GitHub-backed worktree.", {
			code: "GITHUB_REPOSITORY_REQUIRED",
			retryable: false,
		});
	}
	const number = target.number;
	if (number === undefined) return target;
	const host = inferred.host || "github.com";
	const prUrl = target.prUrl ?? `https://${host}/${inferred.owner}/${inferred.repo}/pull/${number}`;
	return {
		...target,
		owner: inferred.owner,
		repo: inferred.repo,
		prUrl,
		canonicalKey: `github:${inferred.owner}/${inferred.repo}#${number}`,
	};
}

async function inferGithubRepository(cwd: string): Promise<{ owner: string; repo: string; host: string } | undefined> {
	try {
		const { stdout } = await execFileSafe("git", ["remote", "get-url", "origin"], { cwd, timeout: 5_000, encoding: "utf8" });
		return parseGithubRemoteUrl(stdout) ?? undefined;
	} catch {
		return undefined;
	}
}

// Centralized prefix rule for github changeset ids: github.com (and
// www.github.com) keep the historical un-prefixed shape for back-compat with
// already-persisted jobs/tabs; every other host is qualified by the normalized
// host so two trusted enterprise hosts sharing owner/repo/number do not collide
// on the same tabId / stored-payload path / export lookup.
function githubChangesetHostPrefix(host: string | undefined): string {
	const normalized = normalizeGithubHost(host);
	return normalized === "github.com" ? "" : `${normalized}/`;
}

function changesetIdForTarget(target: PrWalkthroughTarget): string {
	if (target.provider === "github") {
		const repo = target.owner && target.repo ? `${target.owner}/${target.repo}` : "unknown/unknown";
		const prefix = githubChangesetHostPrefix(target.host);
		return `github:${prefix}${repo}#${target.number ?? "unknown"}`;
	}
	return `${shortSha(target.baseSha ?? "unknown")}..${shortSha(target.headSha ?? "unknown")}`;
}

export const changesetIdForTargetForTesting = changesetIdForTarget;

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
		job: publicJob(job) ?? job,
	};
}

function publicJob(job: PrWalkthroughJobRecord | null): PrWalkthroughJobRecord | null {
	if (!job) return null;
	const { submissionProofHash: _submissionProofHash, ...safeJob } = job;
	return safeJob as PrWalkthroughJobRecord;
}

const REQUIRED_YAML_SCHEMA_PROMPT = `Required submit_pr_walkthrough_yaml YAML shape (preserve these keys and enum values).
You must call submit_pr_walkthrough_yaml with exactly one raw YAML document matching this schema.
Do not include Markdown code fences, backticks, blockquotes, commentary, or multiple documents in the submit_pr_walkthrough_yaml tool argument.

\`\`\`yaml
schema_version: 1
pr:
  provider: github
  owner: string
  repo: string
  number: 123
  title: string
  url: string
  base_sha: 7-40 hex chars
  head_sha: 7-40 hex chars
  original_description:
    body: string
    source: gh_api|gh_cli|unknown
    fetched_at: ISO timestamp string
  stats:
    files_changed: 0
    additions: 0
    deletions: 0
walkthrough:
  context:
    why_created: string
    problem_solved: string
    why_worth_merging: string
    merge_concerns: string
    author_intent: string
    reviewer_map: string
  merge_assessment:
    recommendation: approve|comment|request_changes|unknown
    confidence: low|medium|high
    summary: string
    blocking_concerns:
      - string
    non_blocking_concerns:
      - string
  design_decisions:
    - id: stable-id
      title: string
      nav_label: short label (≤3 words, ≤24 chars)
      explanation: string
      chosen_approach: string
      alternatives_considered:
        - option: string
          pros:
            - string
          cons:
            - string
      tradeoffs:
        - string
      suggested_reviewer_concerns:
        - string
      relevant_hunks:
        - file: path/to/file.ts
          hunk_header: "@@ ... @@"
          why_relevant: string
  review_chunks:
    - id: stable-id
      phase: significant|other|audit
      title: string
      nav_label: short label (≤3 words, ≤24 chars)
      reviewer_goal: string
      explanation: string
      files:
        - path/to/file.ts
      relevant_hunks:
        - file: path/to/file.ts
          hunk_header: "@@ ... @@"
          line_range: string
          why_relevant: string
      suggested_concerns:
        - severity: blocking|non_blocking|question|nit
          concern: string
          suggested_comment: string
          anchors:
            - file: path/to/file.ts
              hunk_header: "@@ ... @@"
              line_range: string
      positive_notes:
        - string
  omissions_and_followups:
    - category: tests|docs|migration|telemetry|security|performance|compatibility|cleanup|other
      expected_artifact: string
      evidence_checked: string
      concern: string
      suggested_comment: string
      severity: blocking|non_blocking|question
  audit:
    remaining_changed_areas:
      - string
    low_signal_or_mechanical_changes:
      - string
    generated_or_binary_files:
      - string
    reviewer_checklist:
      - string
  display:
    phase_order:
      - orientation
      - design
      - significant
      - other
      - audit
    chunk_order:
      - review_chunk_id
\`\`\`

nav_label is the compact sidebar label; keep it ≤3 words / ≤24 chars so it never truncates. Omit to auto-derive from title.

The fenced block above is only a prompt example for readability; the submit_pr_walkthrough_yaml tool argument must be the raw YAML document without code fences.`;

function buildRolePrompt(target: PrWalkthroughTarget): string {
	return [
		"You are a read-only PR walkthrough agent.",
		"Investigate the PR using only read-only tools and report rough percentage progress in chat.",
		"Start from read_pr_walkthrough_bundle; it is the authoritative launch-time PR metadata and diff bundle for this job. Use readonly_bash only for additional read-only investigation.",
		"Do not edit files, run tests/builds, install dependencies, push, commit, or submit GitHub reviews/comments.",
		"When complete, call submit_pr_walkthrough_yaml with exactly one YAML document matching the schema below. The panel will remain empty until that tool succeeds.",
		`Target: ${target.canonicalKey}`,
		REQUIRED_YAML_SCHEMA_PROMPT,
	].join("\n");
}

function buildKickoffPrompt(job: PrWalkthroughJobRecord): string {
	return [
		`Review target: ${job.target.canonicalKey}`,
		job.target.prUrl ? `PR URL: ${job.target.prUrl}` : undefined,
		job.target.baseSha && job.target.headSha ? `Range: ${job.target.baseSha}..${job.target.headSha}` : undefined,
		"Start by calling read_pr_walkthrough_bundle in manifest mode, then say you are beginning the investigation with an approximate progress percentage.",
		"Treat the persisted bundle as authoritative for PR body, SHAs, stats, files, hunks, warnings, and limits.",
		"Populate the panel only by calling submit_pr_walkthrough_yaml with valid YAML. Stay available after success.",
		REQUIRED_YAML_SCHEMA_PROMPT,
	].filter(Boolean).join("\n");
}

function validationSummary(errors: PrWalkthroughValidationIssue[], yamlHash: string): PrWalkthroughValidationSummary {
	return { code: "YAML_SCHEMA_INVALID", message: "PR walkthrough YAML failed validation.", errors, retryable: true, yamlHash };
}

function validateYamlAgainstAuthoritativeChangeset(
	document: PrWalkthroughYamlDocument,
	parsedDiff: WalkthroughParsedDiffForYamlMapping,
	job: PrWalkthroughJobRecord,
): PrWalkthroughValidationIssue[] {
	if (job.target.provider !== "github") return [];
	const errors: PrWalkthroughValidationIssue[] = [];
	const authoritativeBaseSha = stringValue(parsedDiff.changeset?.baseSha);
	const authoritativeHeadSha = stringValue(parsedDiff.changeset?.headSha);
	if (authoritativeBaseSha && !shaMatches(authoritativeBaseSha, document.pr.base_sha)) {
		errors.push({
			path: "$.pr.base_sha",
			message: `Must match the authoritative PR base SHA ${authoritativeBaseSha} resolved from the PR diff. Re-fetch the authoritative PR diff and regenerate all hunk_header, line_range, and anchor references before retrying; do not only patch this SHA. The walkthrough was not published.`,
		});
	}
	if (authoritativeHeadSha && !shaMatches(authoritativeHeadSha, document.pr.head_sha)) {
		errors.push({
			path: "$.pr.head_sha",
			message: `Must match the authoritative PR head SHA ${authoritativeHeadSha} resolved from the PR diff. Re-fetch the authoritative PR diff and regenerate all hunk_header, line_range, and anchor references before retrying; do not only patch this SHA. The walkthrough was not published.`,
		});
	}
	return errors;
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

async function localDiffForYaml(cwd: string, baseSha: string, headSha: string): Promise<WalkthroughParsedDiffForYamlMapping> {
	const resolved = await resolveLocalChangeset({ cwd, baseSha, headSha });
	return {
		changeset: resolved.changeset,
		files: resolved.files,
		warnings: resolved.warnings,
		limits: resolved.limits as WalkthroughParsedDiffForYamlMapping["limits"],
		export: { provider: "local", available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
	};
}

function classifyAgentError(error: unknown, fallbackCode: string): PrWalkthroughJobError {
	const message = error instanceof Error ? error.message : String(error);
	const code = /model|api key|provider|unavailable/i.test(message) ? "MODEL_UNAVAILABLE" : fallbackCode;
	return { code, message, retryable: true };
}

export function classifyDiffResolutionError(error: unknown): PrWalkthroughJobError {
	if (isRecord(error) && isRecord(error.extra) && typeof error.extra.code === "string") {
		return { code: error.extra.code, message: error instanceof Error ? error.message : String(error), retryable: error.extra.retryable !== false };
	}
	if (error instanceof GithubPrAdapterError) {
		if (error.code === "untrusted_github_host") {
			return { code: "untrusted_github_host", message: error.message, retryable: false, host: error.host };
		}
		if (error.status === 401 || error.code === "github_auth_failed") {
			return { code: "GITHUB_AUTH_REQUIRED", message: "GitHub rejected the configured credentials. Check GITHUB_TOKEN/GH_TOKEN or run gh auth status, then retry the walkthrough.", retryable: true };
		}
		if (error.status === 403 && error.code === "github_rate_limited") {
			return { code: "GITHUB_RATE_LIMITED", message: "GitHub API rate limit exceeded. Configure GITHUB_TOKEN/GH_TOKEN, run gh auth login, or retry after the rate-limit reset time.", retryable: true };
		}
		if (error.status === 403) {
			return { code: "GITHUB_FORBIDDEN", message: "GitHub denied access to this pull request or repository. Check token permissions and repository access, then retry.", retryable: true };
		}
		if (error.status === 404 || error.code === "github_pr_not_found") {
			return { code: "GITHUB_NOT_FOUND_OR_PRIVATE", message: "GitHub could not find this pull request. It may be private, deleted, or inaccessible with the current credentials.", retryable: true };
		}
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/rate limit|api rate/i.test(message)) return { code: "GITHUB_RATE_LIMITED", message, retryable: true };
	if (/forbidden|permission|denied/i.test(message)) return { code: "GITHUB_FORBIDDEN", message, retryable: true };
	if (/not found|private|404/i.test(message)) return { code: "GITHUB_NOT_FOUND_OR_PRIVATE", message, retryable: true };
	if (/auth|credential|token|401/i.test(message)) return { code: "GITHUB_AUTH_REQUIRED", message, retryable: true };
	return { code: "DIFF_RESOLUTION_FAILED", message: `Could not resolve PR diff for YAML mapping: ${message}`, retryable: true };
}

function statusForJobError(error: PrWalkthroughJobError): number {
	switch (error.code) {
		case "GITHUB_AUTH_REQUIRED": return 401;
		case "GITHUB_FORBIDDEN": return 403;
		case "GITHUB_RATE_LIMITED": return 429;
		case "GITHUB_NOT_FOUND_OR_PRIVATE": return 404;
		case "PR_WALKTHROUGH_BUNDLE_MISSING": return 409;
		default: return 502;
	}
}

function normalizeModelPref(value: unknown): string | undefined {
	if (typeof value === "string" && /^[^/]+\/.+/.test(value.trim())) return value.trim();
	if (!isRecord(value)) return undefined;
	const provider = stringValue(value.provider);
	const id = stringValue(value.id) ?? stringValue(value.modelId);
	return provider && id ? `${provider}/${id}` : undefined;
}

function runtimeFailureMessage(event: unknown): string | undefined {
	if (!isRecord(event)) return undefined;
	if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant" && event.message.stopReason === "error") {
		return stringValue(event.message.errorMessage) ?? "assistant message ended with an error";
	}
	if (event.type === "process_exit") {
		const code = stringValue(event.code) ?? stringValue(event.exitCode) ?? (typeof event.code === "number" ? String(event.code) : undefined) ?? (typeof event.exitCode === "number" ? String(event.exitCode) : undefined);
		const signal = stringValue(event.signal);
		return code || signal ? `agent process exited (${[code ? `code ${code}` : undefined, signal ? `signal ${signal}` : undefined].filter(Boolean).join(", ")})` : "agent process exited before publishing YAML";
	}
	if (event.type === "agent_error" || event.type === "runtime_error" || event.type === "model_error") {
		return stringValue(event.message) ?? stringValue(event.error) ?? `${event.type}`;
	}
	if (event.type === "agent_end" && (event.error || event.success === false || event.failed === true)) {
		return stringValue(event.message) ?? stringValue(event.error) ?? "agent ended with an error";
	}
	return undefined;
}

function isRecoverablePromptDispatchError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /agent is already processing|re-?enqueue|dispatch.*queued|queued.*drain/i.test(message);
}

function routeError(status: number, message: string, extra?: Record<string, unknown>): Error & { status?: number; extra?: Record<string, unknown> } {
	const error = new Error(message) as Error & { status?: number; extra?: Record<string, unknown> };
	error.status = status;
	error.extra = extra;
	return error;
}

function parseGithubPrUrl(input: string): { owner: string; repo: string; number: number; host: string } | undefined {
	try {
		const url = new URL(input);
		const host = url.hostname.replace(/\.$/, "").toLowerCase();
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length >= 4 && parts[2] === "pull") {
			const number = Number(parts[3]);
			if (Number.isInteger(number) && number > 0) return { owner: parts[0], repo: parts[1], number, host };
		}
	} catch { /* not a URL */ }
	return undefined;
}

function normalizeGithubHost(host: string | undefined): string {
	const normalized = (host ?? "github.com").replace(/\.$/, "").toLowerCase();
	return normalized === "www.github.com" ? "github.com" : normalized;
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

function shaMatches(expected: string, actual: string): boolean {
	return actual.toLowerCase().startsWith(expected.toLowerCase()) || expected.toLowerCase().startsWith(actual.toLowerCase());
}

function isFailureResult(value: unknown): value is { success: false; error: string } {
	return isRecord(value) && value.success === false && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
