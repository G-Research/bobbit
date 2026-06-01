import {
	panelTabsForSession,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	walkthroughChangesetIdFromPanelTabId,
	walkthroughPanelTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { getRouteFromHash } from "./routing.js";
import {
	expandedGoals,
	renderApp,
	saveExpandedGoals,
	setArchivedParentExpanded,
	setTeamLeadExpanded,
	state as globalState,
} from "./state.js";
import type { state as appState } from "./state.js";
import type { PrWalkthroughCard, PrWalkthroughChangesetRef } from "../ui/components/pr-walkthrough/types.js";

export type AppState = typeof appState;

export type PrWalkthroughStatus = "fixture" | "loading" | "waiting_for_yaml" | "validation_failed" | "ready" | "error";

export interface WalkthroughWarning {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
}

interface WalkthroughResolveResult {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	cards: PrWalkthroughCard[];
	warnings?: WalkthroughWarning[];
	limits?: unknown;
	export?: unknown;
	exportCapability?: unknown;
}

interface WalkthroughValidationIssue {
	path?: string;
	message?: string;
	[key: string]: unknown;
}

interface WalkthroughValidationSummary {
	message?: string;
	errors?: WalkthroughValidationIssue[];
	issues?: WalkthroughValidationIssue[];
	[key: string]: unknown;
}

interface WalkthroughJobError {
	code?: string;
	message?: string;
	retryable?: boolean;
	[key: string]: unknown;
}

interface WalkthroughJobTarget {
	provider?: string;
	prUrl?: string;
	url?: string;
	owner?: string;
	repo?: string;
	number?: string | number;
	baseSha?: string;
	headSha?: string;
	canonicalKey?: string;
	[key: string]: unknown;
}

interface WalkthroughJobRecord {
	jobId: string;
	parentSessionId?: string;
	childSessionId: string;
	changesetId: string;
	tabId?: string;
	status: PrWalkthroughStatus | "starting";
	title?: string;
	target?: WalkthroughJobTarget;
	lastValidationError?: WalkthroughValidationSummary;
	warnings?: WalkthroughWarning[];
	error?: WalkthroughJobError;
	submittedAt?: string;
	payloadUpdatedAt?: string;
	[key: string]: unknown;
}

interface WalkthroughApiError extends Error {
	status?: number;
	body?: unknown;
	plainText?: string;
	missingRoute?: boolean;
}

export interface OpenPrWalkthroughInput {
	baseSha?: string;
	headSha?: string;
	base?: string;
	head?: string;
	baseRef?: string;
	headRef?: string;
	baseBranch?: string;
	headBranch?: string;
	prNumber?: string | number;
	url?: string;
	prUrl?: string;
	title?: string;
	prTitle?: string;
	prBody?: string;
	provider?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
}

export function parseWalkthroughPrCommand(input: string): OpenPrWalkthroughInput | null {
	const match = /^\/walkthrough-pr(?:\s+(.+))?$/i.exec(input.trim());
	if (!match) return null;
	const target = (match[1] || "").trim();
	if (!target) return {};
	if (/^https?:\/\//i.test(target)) {
		const metadata = prMetadataFromUrl(target);
		return { url: target, prUrl: target, ...metadata };
	}
	return { prNumber: target.replace(/^#/, "") };
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePrNumber(value: unknown): string | undefined {
	const raw = typeof value === "number" ? String(Math.trunc(value)) : cleanString(value);
	if (!raw) return undefined;
	const normalized = raw.replace(/^#/, "").trim();
	return normalized || undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.trunc(value));
}

function prMetadataFromUrl(value: string): Pick<OpenPrWalkthroughInput, "prNumber" | "provider"> {
	try {
		const url = new URL(value);
		const match = /\/pull\/(\d+)(?:\/|$)/i.exec(url.pathname);
		return {
			prNumber: match?.[1],
			provider: /(^|\.)github\.com$/i.test(url.hostname) ? "github" : undefined,
		};
	} catch {
		return {};
	}
}

function mergeSessionPrMetadata(state: AppState, input: OpenPrWalkthroughInput): OpenPrWalkthroughInput {
	const chatPanel = (state as any)?.chatPanel as Record<string, unknown> | null | undefined;
	const inputNumber = normalizePrNumber(input.prNumber);
	const panelNumber = normalizePrNumber(chatPanel?.prNumber);
	const shouldUsePanelPr = !inputNumber || !panelNumber || inputNumber === panelNumber;
	if (!shouldUsePanelPr) return input;
	return {
		...input,
		prNumber: input.prNumber ?? panelNumber,
		url: input.url ?? cleanString(chatPanel?.prUrl),
		prUrl: input.prUrl ?? cleanString(chatPanel?.prUrl),
		prTitle: input.prTitle ?? cleanString(chatPanel?.prTitle),
	};
}

function normalizeInput(state: AppState, input: OpenPrWalkthroughInput): OpenPrWalkthroughInput {
	const merged = mergeSessionPrMetadata(state, input);
	const url = cleanString(merged.url) || cleanString(merged.prUrl);
	const urlMetadata = url ? prMetadataFromUrl(url) : {};
	return {
		...merged,
		baseSha: cleanString(merged.baseSha) || cleanString(merged.base) || cleanString(merged.baseRef) || cleanString(merged.baseBranch),
		headSha: cleanString(merged.headSha) || cleanString(merged.head) || cleanString(merged.headRef) || cleanString(merged.headBranch),
		url,
		prUrl: url,
		prNumber: normalizePrNumber(merged.prNumber) || normalizePrNumber(urlMetadata.prNumber),
		prTitle: cleanString(merged.prTitle) || cleanString(merged.title),
		prBody: cleanString(merged.prBody),
		title: cleanString(merged.title) || cleanString(merged.prTitle),
		provider: cleanString(merged.provider) || urlMetadata.provider || (url ? "external-pr" : undefined),
		filesChanged: finiteNonNegativeNumber(merged.filesChanged),
		additions: finiteNonNegativeNumber(merged.additions),
		deletions: finiteNonNegativeNumber(merged.deletions),
	};
}

function titleForInput(input: OpenPrWalkthroughInput): string {
	const explicit = cleanString(input.prTitle) || cleanString(input.title);
	const prNumber = normalizePrNumber(input.prNumber);
	if (explicit && prNumber && !/^PR\s+#/i.test(explicit)) return `PR #${prNumber}: ${explicit}`;
	if (explicit) return explicit;
	if (prNumber) return `PR #${prNumber} Walkthrough`;
	if (input.url || input.prUrl) return "PR Walkthrough";
	return "Changeset Walkthrough";
}

function labelForPrNumber(value: unknown): string | undefined {
	const prNumber = normalizePrNumber(value);
	return prNumber ? `PR: #${prNumber}` : undefined;
}

export function changesetRefForWalkthrough(input: OpenPrWalkthroughInput): PrWalkthroughChangesetRef {
	const prNumber = normalizePrNumber(input.prNumber);
	const externalUrl = cleanString(input.prUrl) || cleanString(input.url);
	return {
		baseSha: cleanString(input.baseSha) || "fixture-base",
		headSha: cleanString(input.headSha) || "fixture-head",
		provider: cleanString(input.provider) || (externalUrl ? "external-pr" : prNumber ? "pr" : undefined),
		externalUrl,
		prUrl: externalUrl,
		prNumber,
		prTitle: cleanString(input.prTitle),
		prBody: cleanString(input.prBody),
		title: titleForInput(input),
		filesChanged: finiteNonNegativeNumber(input.filesChanged),
		additions: finiteNonNegativeNumber(input.additions),
		deletions: finiteNonNegativeNumber(input.deletions),
	};
}

export function prWalkthroughStandaloneHref(sessionId: string, tabId: string): string {
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	params.set("tab", tabId);
	return `/walkthrough?${params.toString()}`;
}

function shouldResolveInput(input: OpenPrWalkthroughInput): boolean {
	return Boolean(cleanString(input.prUrl) || cleanString(input.url) || normalizePrNumber(input.prNumber) || (cleanString(input.baseSha) && cleanString(input.headSha)));
}

function resolveRequestForInput(sessionId: string, input: OpenPrWalkthroughInput): Record<string, unknown> {
	const prUrl = cleanString(input.prUrl) || cleanString(input.url);
	const prNumber = normalizePrNumber(input.prNumber);
	const provider = cleanString(input.provider);
	const shouldUseGithubPrDiff = Boolean(prUrl || prNumber || provider === "github" || provider === "external-pr");
	return {
		sessionId: sessionId || undefined,
		// PR walkthroughs should resolve through the GitHub PR API by default so the
		// diff matches GitHub's PR view, including already-merged PRs. Local refs are
		// only sent for explicit local changeset walkthroughs.
		baseSha: shouldUseGithubPrDiff ? undefined : cleanString(input.baseSha),
		headSha: shouldUseGithubPrDiff ? undefined : cleanString(input.headSha),
		prUrl,
		prNumber,
		prTitle: cleanString(input.prTitle),
		prBody: cleanString(input.prBody),
		title: cleanString(input.title),
		provider,
		fixture: !shouldResolveInput(input) || undefined,
	};
}

function isResolveResult(value: unknown): value is WalkthroughResolveResult {
	const result = value as Partial<WalkthroughResolveResult> | null;
	return Boolean(result && typeof result === "object" && typeof result.changesetId === "string" && result.changeset && typeof result.changeset === "object" && Array.isArray(result.cards));
}

async function readJsonOrText(response: Response): Promise<{ body: unknown; text: string }> {
	const text = await response.text().catch(() => "");
	if (!text) return { body: undefined, text };
	try {
		return { body: JSON.parse(text), text };
	} catch {
		return { body: undefined, text };
	}
}

function errorMessageFromBody(body: unknown, fallback: string): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		for (const key of ["message", "error", "detail"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return fallback;
}

async function fetchWalkthroughJson(path: string, options?: RequestInit): Promise<unknown> {
	const response = await gatewayFetch(path, options);
	const contentType = response.headers.get("content-type") || "";
	const { body, text } = await readJsonOrText(response);
	if (!response.ok) {
		const err = new Error(errorMessageFromBody(body, text || `Request failed with ${response.status}`)) as WalkthroughApiError;
		err.status = response.status;
		err.body = body;
		err.plainText = text;
		err.missingRoute = response.status === 404 && !contentType.includes("application/json") && /^not found$/i.test(text.trim());
		throw err;
	}
	return body;
}

function isJobStatus(value: unknown): value is WalkthroughJobRecord["status"] {
	return value === "starting" || value === "waiting_for_yaml" || value === "validation_failed" || value === "ready" || value === "error";
}

function jobRecordFromResponse(value: unknown): WalkthroughJobRecord | undefined {
	const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
	const candidate = (record?.job && typeof record.job === "object" ? record.job : record) as Record<string, unknown> | undefined;
	if (!candidate) return undefined;
	const jobId = typeof candidate.jobId === "string" ? candidate.jobId : "";
	const childSessionId = typeof candidate.childSessionId === "string" ? candidate.childSessionId : "";
	const changesetId = typeof candidate.changesetId === "string" ? candidate.changesetId : "";
	const status = isJobStatus(candidate.status) ? candidate.status : undefined;
	if (!jobId || !childSessionId || !changesetId || !status) return undefined;
	return candidate as unknown as WalkthroughJobRecord;
}

function validationMessage(summary: WalkthroughValidationSummary | undefined): string | undefined {
	if (!summary || typeof summary !== "object") return undefined;
	if (typeof summary.message === "string" && summary.message.trim()) return summary.message.trim();
	const issues = Array.isArray(summary.errors) ? summary.errors : Array.isArray(summary.issues) ? summary.issues : [];
	const first = issues.find((issue) => issue && typeof issue.message === "string" && issue.message.trim());
	return first?.message?.trim();
}

function targetChangesetFromJob(job: WalkthroughJobRecord): PrWalkthroughChangesetRef {
	const target = job.target || {};
	const prNumber = normalizePrNumber(target.number);
	const prUrl = cleanString(target.prUrl) || cleanString(target.url);
	const prTitle = cleanString((job as Record<string, unknown>).prTitle) || cleanString(target.title);
	return {
		baseSha: cleanString(target.baseSha) || "pending-base",
		headSha: cleanString(target.headSha) || "pending-head",
		provider: cleanString(target.provider) || (prUrl ? "github" : undefined),
		externalUrl: prUrl,
		prUrl,
		prNumber,
		prTitle,
		title: cleanString(job.title) || titleForInput({ prNumber, prUrl, prTitle }),
	};
}

function labelForJob(job: WalkthroughJobRecord): string {
	return labelForPrNumber(job.target?.number) || (job.target?.prUrl ? "PR" : "Walkthrough");
}

function isLiveSessionHostedWalkthrough(state: AppState, sessionId: string): boolean {
	const session = state.gatewaySessions.find((candidate) => candidate.id === sessionId);
	return session?.childKind === "pr-walkthrough" && !session.archived && session.status !== "terminated" && session.status !== "archived";
}

/** True when the dedicated, prompt-less standalone `/walkthrough` route is active. */
function isStandaloneWalkthroughRoute(): boolean {
	try { return getRouteFromHash().view === "walkthrough"; } catch { return false; }
}

function keepLiveWalkthroughPanelPromptable(state: AppState, sessionId: string, tabId?: string): void {
	if (tabId) setActivePanelTabIdForSession(state, sessionId, tabId);
	const tabs = panelTabsForSession(state, sessionId);
	const nextTabs = tabs.map((tab) => tab.kind === "walkthrough" && tab.state?.fullscreenOnReady === true
		? { ...tab, state: { ...tab.state, fullscreenOnReady: false } }
		: tab);
	if (nextTabs.some((tab, index) => tab !== tabs[index])) setPanelTabsForSession(state, sessionId, nextTabs);
	// Forcing split + clearing the collapse flag keeps the in-app chat prompt
	// visible for a live child. The standalone /walkthrough route has no prompt
	// and owns its own fullscreen/collapse state, so skip the reset there —
	// otherwise the per-render job restore bounces the user out of fullscreen
	// and wipes the persisted collapse flag on every paint.
	if (isStandaloneWalkthroughRoute()) return;
	(state as any).previewPanelFullscreen = false;
	try { localStorage.removeItem(`bobbit-preview-collapsed-${sessionId}`); } catch { /* non-browser/test */ }
}

export function upsertPrWalkthroughJobPanel(
	state: AppState,
	job: WalkthroughJobRecord,
	options: { select?: boolean; fullscreenOnReady?: boolean } = {},
): PanelWorkspaceTab {
	const sessionId = job.childSessionId;
	const changeset = targetChangesetFromJob(job);
	const changesetId = job.changesetId;
	const rawTabId = cleanString(job.tabId);
	const requestedTabId = rawTabId && walkthroughChangesetIdFromPanelTabId(rawTabId) ? rawTabId : walkthroughPanelTabId(changesetId);
	const existing = panelTabsForSession(state, sessionId);
	const existingJobTab = existing.find((candidate) => {
		if (candidate.kind !== "walkthrough") return false;
		const source = (candidate.source || {}) as Record<string, unknown>;
		const candidateState = (candidate.state || {}) as Record<string, unknown>;
		return source.jobId === job.jobId || candidateState.jobId === job.jobId;
	});
	const tabId = existingJobTab?.id || requestedTabId;
	const status: PrWalkthroughStatus = job.status === "starting" ? "waiting_for_yaml" : job.status;
	const target = job.target || {};
	const errorMessage = job.error?.message || (status === "validation_failed" ? validationMessage(job.lastValidationError) : undefined);
	const liveSessionHosted = !!job.parentSessionId || isLiveSessionHostedWalkthrough(state, sessionId);
	const fullscreenOnReady = !!options.fullscreenOnReady && !liveSessionHosted;
	const tab: PanelWorkspaceTab = {
		id: tabId,
		kind: "walkthrough",
		title: cleanString(job.title) || changeset.title || "PR Walkthrough",
		label: labelForJob(job),
		legacyTab: "walkthrough",
		source: {
			type: "walkthrough",
			sessionId,
			changesetId,
			title: cleanString(job.title) || changeset.title,
			baseSha: changeset.baseSha,
			headSha: changeset.headSha,
			provider: changeset.provider,
			externalUrl: changeset.externalUrl,
			prUrl: changeset.prUrl,
			prNumber: changeset.prNumber,
			prTitle: changeset.prTitle,
			jobId: job.jobId,
			targetKey: cleanString(target.canonicalKey),
		} as PanelWorkspaceTab["source"],
		state: {
			status,
			jobId: job.jobId,
			changesetId,
			changeset,
			warnings: job.warnings || [],
			lastValidationError: job.lastValidationError,
			validationError: job.lastValidationError,
			error: errorMessage,
			errorCode: job.error?.code,
			retryable: job.error?.retryable,
			prUrl: changeset.prUrl,
			prNumber: changeset.prNumber,
			prTitle: changeset.prTitle,
			baseSha: changeset.baseSha,
			headSha: changeset.headSha,
			fullscreenOnReady: status === "ready" && fullscreenOnReady || undefined,
		},
	};

	const next = existing.some((candidate) => candidate.id === tabId)
		? existing.map((candidate) => {
			if (candidate.id !== tabId) return candidate;
			const candidateState = (candidate.state || {}) as Record<string, unknown>;
			const tabState = (tab.state || {}) as Record<string, unknown>;
			const mergedState = { ...candidateState, ...tabState };
			if (status === "ready" && Array.isArray(candidateState.cards) && !Array.isArray(tabState.cards)) {
				mergedState.cards = candidateState.cards;
				if (candidateState.changeset) mergedState.changeset = candidateState.changeset;
				if (candidateState.exportCapability && !tabState.exportCapability) mergedState.exportCapability = candidateState.exportCapability;
				if (candidateState.limits && !tabState.limits) mergedState.limits = candidateState.limits;
			}
			return {
				...candidate,
				...tab,
				source: { ...(candidate.source as Record<string, unknown>), ...(tab.source as Record<string, unknown>) } as PanelWorkspaceTab["source"],
				state: mergedState,
			};
		})
		: [...existing, tab];
	setPanelTabsForSession(state, sessionId, next);
	if (options.select) setActivePanelTabIdForSession(state, sessionId, tabId);
	if (status === "ready") {
		if (liveSessionHosted) keepLiveWalkthroughPanelPromptable(state, sessionId, tabId);
		else setActivePanelTabIdForSession(state, sessionId, tabId);
		if (fullscreenOnReady && !liveSessionHosted) (state as any).previewPanelFullscreen = true;
		// A ready job broadcast carries job metadata, not the YAML-derived cards.
		// Always hydrate the payload from the walkthrough store so live child
		// panels and standalone tabs don't remain stuck on stale waiting content.
		restorePrWalkthroughPanel(state, sessionId, tabId);
	}
	return tab;
}

function patchWalkthroughTab(
	state: AppState,
	sessionId: string,
	tabId: string,
	patch: Record<string, unknown>,
	result?: WalkthroughResolveResult,
): string {
	const canonicalChangesetId = typeof patch.changesetId === "string" && patch.changesetId ? patch.changesetId : undefined;
	const nextTabId = canonicalChangesetId ? walkthroughPanelTabId(canonicalChangesetId) : tabId;
	let updatedTabId = tabId;
	let replaced = false;
	const tabs = panelTabsForSession(state, sessionId);
	const nextTabs = tabs.map((tab) => {
		if (tab.id !== tabId && tab.id !== nextTabId) return tab;
		if (tab.id === nextTabId && tab.id !== tabId) return tab;
		replaced = true;
		updatedTabId = nextTabId;
		const source = (tab.source || {}) as Record<string, unknown>;
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const changeset = result?.changeset || (patch.changeset as PrWalkthroughChangesetRef | undefined) || (tabState.changeset as PrWalkthroughChangesetRef | undefined);
		const title = changeset?.title || (typeof patch.title === "string" ? patch.title : undefined) || tab.title;
		return {
			...tab,
			id: nextTabId,
			title,
			label: labelForPrNumber(changeset?.prNumber) || tab.label || "Walkthrough",
			source: {
				...source,
				type: "walkthrough",
				sessionId,
				...(canonicalChangesetId ? { changesetId: canonicalChangesetId } : {}),
				...(changeset ? {
					title,
					baseSha: changeset.baseSha,
					headSha: changeset.headSha,
					provider: changeset.provider,
					externalUrl: changeset.externalUrl,
					prUrl: changeset.prUrl || changeset.externalUrl,
					prNumber: changeset.prNumber,
					prTitle: changeset.prTitle,
					prBody: changeset.prBody,
					filesChanged: changeset.filesChanged,
					additions: changeset.additions,
					deletions: changeset.deletions,
				} : {}),
			} as PanelWorkspaceTab["source"],
			state: { ...tabState, ...patch },
		} as PanelWorkspaceTab;
	});

	const deduped = nextTabId !== tabId ? nextTabs.filter((tab, index, all) => tab.id !== nextTabId || all.findIndex((candidate) => candidate.id === nextTabId) === index) : nextTabs;
	if (replaced) {
		setPanelTabsForSession(state, sessionId, deduped);
		const liveSessionHosted = isLiveSessionHostedWalkthrough(state, sessionId);
		if (nextTabId !== tabId) setActivePanelTabIdForSession(state, sessionId, nextTabId);
		if (patch.status === "ready") {
			if (liveSessionHosted) keepLiveWalkthroughPanelPromptable(state, sessionId, nextTabId);
			else {
				setActivePanelTabIdForSession(state, sessionId, nextTabId);
				if ((state as any).selectedSessionId === sessionId) (state as any).previewPanelFullscreen = true;
			}
		}
	}
	return updatedTabId;
}

export async function resolvePrWalkthrough(state: AppState, sessionId: string, tabId: string, input: OpenPrWalkthroughInput): Promise<void> {
	try {
		const data = await fetchWalkthroughJson("/api/pr-walkthrough/resolve", {
			method: "POST",
			body: JSON.stringify(resolveRequestForInput(sessionId, input)),
		});
		if (!isResolveResult(data)) throw new Error("PR walkthrough resolver returned an invalid response");
		patchWalkthroughTab(state, sessionId, tabId, {
			status: "ready",
			changesetId: data.changesetId,
			changeset: data.changeset,
			cards: data.cards,
			warnings: data.warnings || [],
			limits: data.limits,
			exportCapability: data.exportCapability ?? data.export,
		}, data);
	} catch (error) {
		const err = error as WalkthroughApiError;
		patchWalkthroughTab(state, sessionId, tabId, err.missingRoute
			? {
				status: "fixture",
				warnings: [{ code: "resolver_unavailable", severity: "info", message: "Using fixture walkthrough because the resolver API is unavailable." }],
			}
			: {
				status: "error",
				error: err.message || "Failed to resolve PR walkthrough",
				warnings: [],
			});
	} finally {
		renderApp();
	}
}

const restoreInFlight = new Set<string>();

export function restorePrWalkthroughPanel(state: AppState, sessionId: string, tabId: string): void {
	const tabs = panelTabsForSession(state, sessionId);
	const tab = tabs.find((candidate) => candidate.id === tabId);
	if (!tab || tab.kind !== "walkthrough") return;
	const tabState = (tab.state || {}) as Record<string, unknown>;
	if (Array.isArray(tabState.cards) || tabState.status === "loading") return;
	if (tabState.status === "waiting_for_yaml" || tabState.status === "validation_failed") return;
	if (tabState.status === "error" && tabState.jobId) return;
	const changesetId = typeof tabState.changesetId === "string" && tabState.changesetId
		? tabState.changesetId
		: walkthroughChangesetIdFromPanelTabId(tab.id);
	if (!changesetId || changesetId === "fixture") return;
	const key = `${sessionId}:${tab.id}:${changesetId}`;
	if (restoreInFlight.has(key)) return;
	restoreInFlight.add(key);
	patchWalkthroughTab(state, sessionId, tab.id, { status: "loading" });
	renderApp();
	void fetchWalkthroughJson(`/api/pr-walkthrough/${encodeURIComponent(changesetId)}`)
		.then((data) => {
			if (!isResolveResult(data)) throw new Error("PR walkthrough store returned an invalid response");
			patchWalkthroughTab(state, sessionId, tab.id, {
				status: "ready",
				changesetId: data.changesetId,
				changeset: data.changeset,
				cards: data.cards,
				warnings: data.warnings || [],
				limits: data.limits,
				exportCapability: data.exportCapability ?? data.export,
			}, data);
		})
		.catch((error: WalkthroughApiError) => {
			patchWalkthroughTab(state, sessionId, tab.id, {
				status: error.missingRoute ? "fixture" : "error",
				error: error.missingRoute ? undefined : error.message || "Failed to restore PR walkthrough",
				warnings: error.missingRoute ? [{ code: "resolver_unavailable", severity: "info", message: "Using fixture walkthrough because the resolver API is unavailable." }] : [],
			});
		})
		.finally(() => {
			restoreInFlight.delete(key);
			renderApp();
		});
}

function launchRequestForInput(sessionId: string, input: OpenPrWalkthroughInput): Record<string, unknown> {
	return resolveRequestForInput(sessionId, input);
}

function expandWalkthroughSidebarContainers(childSessionId: string): void {
	const sessions = [...globalState.gatewaySessions, ...globalState.archivedSessions];
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const visited = new Set<string>();
	let current = byId.get(childSessionId);
	let savedGoalsChanged = false;

	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		const goalId = current.teamGoalId || current.goalId;
		if (goalId && !expandedGoals.has(goalId)) {
			expandedGoals.add(goalId);
			savedGoalsChanged = true;
		}

		const teamLeadId = current.teamLeadSessionId;
		if (teamLeadId) setTeamLeadExpanded(teamLeadId, true);

		const parentId = current.parentSessionId || current.delegateOf;
		if (!parentId) break;
		setArchivedParentExpanded(parentId, true);
		const parent = byId.get(parentId);
		if (parent?.role === "team-lead") setTeamLeadExpanded(parentId, true);
		current = parent;
	}

	if (savedGoalsChanged) saveExpandedGoals();
}

async function focusWalkthroughChildSession(childSessionId: string): Promise<void> {
	try {
		const [{ refreshSessions }, { connectToSession }] = await Promise.all([
			import("./api.js"),
			import("./session-manager.js"),
		]);
		await refreshSessions();
		expandWalkthroughSidebarContainers(childSessionId);
		await connectToSession(childSessionId, true);
	} catch {
		// The launch already created the child tab state. Session polling will make
		// the child visible if an immediate focus attempt races session refresh.
	}
}

async function showWalkthroughLaunchToast(message: string): Promise<void> {
	try {
		const { showHeaderToast } = await import("./render.js");
		showHeaderToast(message);
	} catch { /* best-effort toast */ }
}

export async function launchPrWalkthroughAgent(state: AppState, sessionId: string, rawInput: OpenPrWalkthroughInput): Promise<PanelWorkspaceTab | undefined> {
	const input = normalizeInput(state, rawInput);
	if (!shouldResolveInput(input)) {
		await showWalkthroughLaunchToast("Enter a PR URL or number: /walkthrough-pr <GitHub PR URL>");
		renderApp();
		return undefined;
	}
	try {
		const data = await fetchWalkthroughJson("/api/pr-walkthrough/launch", {
			method: "POST",
			body: JSON.stringify(launchRequestForInput(sessionId, input)),
		});
		const job = jobRecordFromResponse(data);
		if (!job) throw new Error("PR walkthrough launch returned an invalid response");
		const tab = upsertPrWalkthroughJobPanel(state, job, { select: true, fullscreenOnReady: job.status === "ready" });
		renderApp();
		void focusWalkthroughChildSession(job.childSessionId);
		return tab;
	} catch (error) {
		const err = error as WalkthroughApiError;
		console.error("[pr-walkthrough] launch failed", err);
		await showWalkthroughLaunchToast(err.message || "Failed to launch PR walkthrough agent");
		renderApp();
		return undefined;
	}
}

export function openPrWalkthroughPanel(state: AppState, sessionId: string, rawInput: OpenPrWalkthroughInput): Promise<PanelWorkspaceTab | undefined> {
	return launchPrWalkthroughAgent(state, sessionId, rawInput);
}

const jobRestoreInFlight = new Set<string>();
const jobRestoreLastAttempt = new Map<string, number>();

export function restorePrWalkthroughJobForSession(state: AppState, childSessionId: string): void {
	if (!childSessionId) return;
	if (isLiveSessionHostedWalkthrough(state, childSessionId)) keepLiveWalkthroughPanelPromptable(state, childSessionId);
	const now = Date.now();
	const last = jobRestoreLastAttempt.get(childSessionId) || 0;
	if (jobRestoreInFlight.has(childSessionId) || now - last < 2_000) return;
	jobRestoreInFlight.add(childSessionId);
	jobRestoreLastAttempt.set(childSessionId, now);
	void fetchWalkthroughJson(`/api/pr-walkthrough/session/${encodeURIComponent(childSessionId)}`)
		.then((data) => {
			const job = jobRecordFromResponse(data);
			if (!job) return;
			upsertPrWalkthroughJobPanel(state, job, { select: (state as any).selectedSessionId === childSessionId, fullscreenOnReady: job.status === "ready" });
		})
		.catch(() => { /* older server or no job for this session */ })
		.finally(() => {
			jobRestoreInFlight.delete(childSessionId);
			renderApp();
		});
}
