import { refreshGateStatusForGoal } from "./api.js";
import { isReviewArtifactIdentity, isReviewArtifactPayloadId, reviewArtifactTabId } from "../shared/review-artifact-identity.js";
import { dispatchHumanSignoffResolved } from "./gate-status-events.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { legacyReviewDocumentIdFromTitle, reviewDocumentIdFromPanelTab, reviewTitleFromPanelTab } from "./panel-workspace.js";
import { selectReviewWorkspaceTab } from "./preview-panel.js";
import {
	closeSidePanelTab,
	getSidePanelWorkspace,
	openSidePanelTab,
	updateSidePanelTab,
	type SidePanelWorkspaceTab,
} from "./side-panel-workspace.js";
import {
	activeSessionId,
	renderApp,
	state,
	type ReviewDecisionPayload,
	type ReviewDocumentModel,
	type ReviewFileModel,
	type ReviewGroupModel,
	type ReviewInlineCommentPayload,
	type ReviewSource,
} from "./state.js";
import {
	clearAnnotations,
	flushPendingWrites,
	getInlineCommentPayloads,
	getReviewTombstones,
	isReviewSubmitted,
	setReviewTombstone,
} from "../ui/components/review/AnnotationStore.js";

export { clearReviewTombstone, setReviewTombstone } from "../ui/components/review/AnnotationStore.js";

const REVIEW_CONTEXT_STORAGE_PREFIX = "bobbit-review-contexts-v1:";
const REVIEW_CONTEXT_VERSION = 2;
const MAX_ARTIFACT_REVIEW_TITLE_BYTES = 320;

export interface OpenReviewFileOptions {
	title: string;
	markdown: string;
	fileId?: string;
}

export interface OpenReviewGroupOptions {
	title: string;
	files: OpenReviewFileOptions[];
	reviewId?: string;
	activeFileId?: string;
	replace?: boolean;
	/** Explicit live opens may reopen an exact tombstoned review through authoritative workspace presence. */
	live?: boolean;
	sessionId?: string;
	source?: ReviewSource;
}

export interface OpenMarkdownReviewDocumentOptions {
	title: string;
	markdown: string;
	documentId?: string;
	fileId?: string;
	reviewId?: string;
	replace?: boolean;
	live?: boolean;
	sessionId?: string;
}

export interface OpenReviewDocumentOptions extends OpenMarkdownReviewDocumentOptions {
	source?: ReviewSource;
}

/** Immutable review payload identity persisted on an authoritative workspace tab. */
export interface ArtifactReviewReference {
	sessionId: string;
	reviewId: string;
	title: string;
	toolCallId: string;
	payloadId: string;
	contentHash: string;
	activeFileId: string;
}

export interface SubmitReviewDecisionOptions {
	sessionId?: string;
	prompt?: (feedback: string) => void | Promise<void>;
}

export interface ReviewDecisionSubmissionOutcome {
	submitted: boolean;
	sessionId: string;
	reviewId: string;
	/** Exact review-level draft delivered by the accepted submission. */
	finalComment: string;
}

interface PersistedReviewGroupsV2 {
	version: 2;
	groups: ReviewGroupModel[];
}

let generatedReviewIdentityCounter = 0;

type ReviewLifecycleSequence = {
	generation: number;
	tail: Promise<void>;
};

/** Exact review lifecycle effects must settle in intent order without blocking siblings. */
const reviewLifecycleSequences = new Map<string, ReviewLifecycleSequence>();
/** One accepted external decision effect may be pending for an exact review key. */
const pendingReviewDecisions = new Map<string, Promise<ReviewDecisionSubmissionOutcome>>();
/** Artifact-backed Markdown lives only in memory; the workspace reference is durable. */
const artifactReviewReferences = new Map<string, ArtifactReviewReference>();

function reviewLifecycleKey(sessionId: string, reviewId: string): string {
	return `${sessionId}\u0000${reviewId}`;
}

function enqueueReviewLifecycle<T>(
	sessionId: string,
	reviewId: string,
	operation: (isCurrent: () => boolean) => Promise<T>,
): Promise<T> {
	const key = reviewLifecycleKey(sessionId, reviewId);
	const previous = reviewLifecycleSequences.get(key);
	const generation = (previous?.generation || 0) + 1;
	const result = (previous?.tail || Promise.resolve()).then(
		() => operation(() => reviewLifecycleSequences.get(key)?.generation === generation),
	);
	// A failed intent must not prevent a later exact-key intent from running.
	const tail = result.then(() => undefined, () => undefined);
	const sequence = { generation, tail };
	reviewLifecycleSequences.set(key, sequence);
	void tail.then(() => {
		if (reviewLifecycleSequences.get(key) === sequence) reviewLifecycleSequences.delete(key);
	});
	return result;
}

function storageKey(sessionId: string): string {
	return `${REVIEW_CONTEXT_STORAGE_PREFIX}${sessionId}`;
}

function safeIdentityPart(value: string): string {
	return encodeURIComponent(value || "no-session").replace(/%/g, "_").slice(0, 80) || "no-session";
}

function normalizeIdentity(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 160 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

function exactArtifactTitle(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
	return new TextEncoder().encode(value).byteLength <= MAX_ARTIFACT_REVIEW_TITLE_BYTES ? value : undefined;
}

function artifactReviewKey(sessionId: string, reviewId: string): string {
	return `${sessionId}\u0000${reviewId}`;
}

function exactArtifactReferenceFromTab(
	tab: SidePanelWorkspaceTab | undefined,
	expectedSessionId: string,
): ArtifactReviewReference | undefined {
	if (!tab || tab.kind !== "review" || tab.source.type !== "review") return undefined;
	const source = tab.source as Record<string, unknown>;
	const sessionId = normalizeIdentity(source.sessionId);
	const reviewId = isReviewArtifactIdentity(source.reviewId, "reviewId") ? source.reviewId : undefined;
	const title = exactArtifactTitle(source.title);
	const toolCallId = isReviewArtifactIdentity(source.toolCallId, "toolCallId") ? source.toolCallId : undefined;
	const payloadId = isReviewArtifactPayloadId(source.payloadId) ? source.payloadId : undefined;
	const contentHash = typeof source.contentHash === "string" && /^[a-f0-9]{64}$/.test(source.contentHash) ? source.contentHash : undefined;
	const activeFileId = isReviewArtifactIdentity(tab.state?.activeFileId, "fileId") ? tab.state.activeFileId : undefined;
	if (!sessionId || sessionId !== expectedSessionId || !reviewId || !title
		|| !toolCallId || !payloadId || !contentHash || !activeFileId) return undefined;
	if (tab.id !== reviewArtifactTabId(reviewId)) return undefined;
	return { sessionId, reviewId, title, toolCallId, payloadId, contentHash, activeFileId };
}

function artifactReferenceMatches(a: ArtifactReviewReference, b: ArtifactReviewReference): boolean {
	return a.sessionId === b.sessionId
		&& a.reviewId === b.reviewId
		&& a.title === b.title
		&& a.toolCallId === b.toolCallId
		&& a.payloadId === b.payloadId
		&& a.contentHash === b.contentHash
		&& a.activeFileId === b.activeFileId;
}

/** Return only complete, exact artifact references from the owner's authoritative workspace. */
export function getArtifactReviewWorkspaceReferences(sessionId: string): ArtifactReviewReference[] {
	if (!normalizeIdentity(sessionId)) return [];
	return getSidePanelWorkspace(sessionId).tabs
		.map((tab) => exactArtifactReferenceFromTab(tab, sessionId))
		.filter((reference): reference is ArtifactReviewReference => !!reference);
}

function newIdentity(kind: "review" | "file", sessionId: string): string {
	generatedReviewIdentityCounter += 1;
	return `${kind}:${safeIdentityPart(sessionId)}:${Date.now().toString(36)}-${generatedReviewIdentityCounter.toString(36)}`;
}

function sourceWithDefault(source: ReviewSource | undefined, sessionId: string): ReviewSource {
	return source || { kind: "markdown-review", sessionId };
}

function signoffTitle(source: ReviewSource): string {
	if (source.kind !== "verification-signoff-markdown" && source.kind !== "verification-signoff-pr") return "Review";
	const goal = source.goalTitle || source.goalId;
	const gate = source.gateName || source.gateId;
	const step = source.stepLabel || source.stepName;
	return `Sign-off: ${goal} / ${gate} / ${step}`;
}

function normalizeReviewSource(value: unknown): ReviewSource | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const kind = source.kind;
	if (kind === "markdown-review" && typeof source.sessionId === "string") return { kind, sessionId: source.sessionId };
	if (kind === "verification-signoff-markdown") {
		if (typeof source.goalId !== "string" || typeof source.gateId !== "string" || typeof source.signalId !== "string" || typeof source.stepName !== "string") return undefined;
		return {
			kind,
			goalId: source.goalId,
			gateId: source.gateId,
			signalId: source.signalId,
			stepName: source.stepName,
			goalTitle: typeof source.goalTitle === "string" ? source.goalTitle : undefined,
			gateName: typeof source.gateName === "string" ? source.gateName : undefined,
			stepLabel: typeof source.stepLabel === "string" ? source.stepLabel : undefined,
		};
	}
	if (kind === "verification-signoff-pr") {
		if (typeof source.goalId !== "string" || typeof source.gateId !== "string" || typeof source.signalId !== "string" || typeof source.stepName !== "string" || typeof source.prUrl !== "string") return undefined;
		return {
			kind,
			goalId: source.goalId,
			gateId: source.gateId,
			signalId: source.signalId,
			stepName: source.stepName,
			prUrl: source.prUrl,
			goalTitle: typeof source.goalTitle === "string" ? source.goalTitle : undefined,
			gateName: typeof source.gateName === "string" ? source.gateName : undefined,
			stepLabel: typeof source.stepLabel === "string" ? source.stepLabel : undefined,
		};
	}
	return undefined;
}

function normalizeFiles(rawFiles: unknown, sessionId: string): ReviewFileModel[] {
	if (!Array.isArray(rawFiles)) return [];
	const seen = new Set<string>();
	const files: ReviewFileModel[] = [];
	for (let index = 0; index < rawFiles.length; index += 1) {
		const raw = rawFiles[index];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.markdown !== "string") continue;
		let fileId = normalizeIdentity(record.fileId) || normalizeIdentity(record.documentId) || newIdentity("file", sessionId);
		while (seen.has(fileId)) fileId = newIdentity("file", sessionId);
		seen.add(fileId);
		files.push({
			fileId,
			title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : `File ${index + 1}`,
			markdown: record.markdown,
		});
	}
	return files;
}

function normalizeGroup(raw: unknown, sessionId: string): ReviewGroupModel | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const files = normalizeFiles(record.files, sessionId);
	if (files.length === 0) return undefined;
	const source = normalizeReviewSource(record.source) || { kind: "markdown-review", sessionId };
	const reviewId = normalizeIdentity(record.reviewId) || newIdentity("review", sessionId);
	const activeFileId = normalizeIdentity(record.activeFileId);
	return {
		reviewId,
		title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Review",
		files,
		activeFileId: activeFileId && files.some((file) => file.fileId === activeFileId) ? activeFileId : files[0].fileId,
		source,
	};
}

function migrateLegacyDocuments(raw: Record<string, unknown>, sessionId: string): ReviewGroupModel[] {
	const groups: ReviewGroupModel[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const doc = value as Record<string, unknown>;
		if (typeof doc.markdown !== "string") continue;
		const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : key || "Review";
		const source = normalizeReviewSource(doc.source) || { kind: "markdown-review", sessionId };
		const reviewId = normalizeIdentity(doc.reviewId) || normalizeIdentity(doc.documentId) || legacyReviewDocumentIdFromTitle(title);
		const fileId = normalizeIdentity(doc.fileId) || normalizeIdentity(doc.documentId) || newIdentity("file", sessionId);
		groups.push({ reviewId, title, files: [{ fileId, title, markdown: doc.markdown }], activeFileId: fileId, source });
	}
	return groups;
}

function safeReadPersisted(sessionId: string): ReviewGroupModel[] {
	if (!sessionId || typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(sessionId));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const record = parsed as Record<string, unknown>;
		const isCurrentFormat = record.version === REVIEW_CONTEXT_VERSION && Array.isArray(record.groups);
		const candidates = isCurrentFormat ? record.groups as unknown[] : migrateLegacyDocuments(record, sessionId);
		const seen = new Set<string>();
		const groups: ReviewGroupModel[] = [];
		for (const candidate of candidates) {
			const group = normalizeGroup(candidate, sessionId);
			if (!group) continue;
			while (seen.has(group.reviewId)) group.reviewId = newIdentity("review", sessionId);
			seen.add(group.reviewId);
			groups.push(group);
		}
		if (!isCurrentFormat) safeWritePersisted(sessionId, groups);
		return groups;
	} catch {
		return [];
	}
}

function shouldPersistReviewGroup(sessionId: string, group: ReviewGroupModel): boolean {
	// Artifact payloads are durable on the server and can be up to 10 MiB. Never
	// duplicate their Markdown into quota-limited localStorage.
	if (artifactReviewReferences.has(artifactReviewKey(sessionId, group.reviewId))) return false;
	return group.source.kind === "markdown-review"
		|| group.source.kind === "verification-signoff-markdown"
		|| group.source.kind === "verification-signoff-pr";
}

function safeWritePersisted(sessionId: string, groups: ReviewGroupModel[]): void {
	if (!sessionId || typeof localStorage === "undefined") return;
	try {
		const key = storageKey(sessionId);
		const persistable = groups.filter((group) => shouldPersistReviewGroup(sessionId, group));
		if (persistable.length === 0) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify({ version: REVIEW_CONTEXT_VERSION, groups: persistable } satisfies PersistedReviewGroupsV2));
	} catch { /* localStorage may be unavailable/full */ }
}

function sessionGroups(sessionId: string): ReviewGroupModel[] {
	if (!Object.prototype.hasOwnProperty.call(state.reviewGroupsBySession, sessionId)) {
		state.reviewGroupsBySession[sessionId] = safeReadPersisted(sessionId);
	}
	return state.reviewGroupsBySession[sessionId] || [];
}

function writeSessionGroups(sessionId: string, groups: ReviewGroupModel[]): void {
	state.reviewGroupsBySession = { ...state.reviewGroupsBySession, [sessionId]: groups };
	safeWritePersisted(sessionId, groups);
}

function isVisibleSession(sessionId: string): boolean {
	return !!sessionId && (state.selectedSessionId === sessionId || activeSessionId() === sessionId);
}

function compatibilityDocument(group: ReviewGroupModel, file: ReviewFileModel): ReviewDocumentModel {
	return {
		title: file.title,
		markdown: file.markdown,
		source: group.source,
		documentId: file.fileId,
		fileId: file.fileId,
		reviewId: group.reviewId,
	};
}

/** Hydrate only the selected session into the visible review model and legacy file mirrors. */
export function hydrateVisibleReviewGroups(sessionId: string, groups: ReviewGroupModel[], preferredReviewId?: string): void {
	if (!isVisibleSession(sessionId)) return;
	state.reviewGroups = new Map(groups.map((group) => [group.reviewId, group]));
	const activeReviewId = preferredReviewId && state.reviewGroups.has(preferredReviewId)
		? preferredReviewId
		: state.reviewGroups.has(state.reviewActiveReviewId) ? state.reviewActiveReviewId : groups[0]?.reviewId || "";
	state.reviewActiveReviewId = activeReviewId;
	const activeGroup = state.reviewGroups.get(activeReviewId);
	state.reviewDocuments = new Map((activeGroup?.files || []).map((file) => [file.fileId, compatibilityDocument(activeGroup!, file)]));
	state.reviewActiveTab = activeGroup?.activeFileId || "";
	state.reviewPanelOpen = groups.length > 0;
}

export function readPersistedReviewGroups(sessionId: string): ReviewGroupModel[] {
	const groups = safeReadPersisted(sessionId);
	state.reviewGroupsBySession = { ...state.reviewGroupsBySession, [sessionId]: groups };
	return groups;
}

function titleOccurrenceKey(title: string, occurrence: number): string {
	return `${title}\u0000${occurrence}`;
}

/** Retain stable file IDs by display-title occurrence during whole-review replacement. */
export function reconcileReviewGroup(existing: ReviewGroupModel, incoming: ReviewGroupModel): ReviewGroupModel {
	const existingOccurrences = new Map<string, string>();
	const existingCounts = new Map<string, number>();
	for (const file of existing.files) {
		const occurrence = existingCounts.get(file.title) || 0;
		existingCounts.set(file.title, occurrence + 1);
		existingOccurrences.set(titleOccurrenceKey(file.title, occurrence), file.fileId);
	}
	const incomingCounts = new Map<string, number>();
	const incomingToReconciled = new Map<string, string>();
	const files = incoming.files.map((file) => {
		const occurrence = incomingCounts.get(file.title) || 0;
		incomingCounts.set(file.title, occurrence + 1);
		const fileId = existingOccurrences.get(titleOccurrenceKey(file.title, occurrence)) || file.fileId;
		incomingToReconciled.set(file.fileId, fileId);
		return { ...file, fileId };
	});
	const survivingIds = new Set(files.map((file) => file.fileId));
	const requestedActive = incomingToReconciled.get(incoming.activeFileId);
	const activeFileId = survivingIds.has(existing.activeFileId)
		? existing.activeFileId
		: requestedActive && survivingIds.has(requestedActive) ? requestedActive : files[0].fileId;
	return { ...incoming, reviewId: existing.reviewId, files, activeFileId };
}

/** Pure ordered upsert used by persistence and focused model tests. */
export function upsertReviewGroup(groups: ReviewGroupModel[], incoming: ReviewGroupModel, replace = true, _sessionId = ""): ReviewGroupModel[] {
	if (!replace) {
		const replayIndex = groups.findIndex((group) => group.reviewId === incoming.reviewId);
		if (replayIndex >= 0) {
			// Canonical tool results carry opaque IDs. Replaying the same result is
			// idempotent; distinct live replace:false calls already have fresh IDs.
			const next = [...groups];
			next[replayIndex] = reconcileReviewGroup(groups[replayIndex], incoming);
			return next;
		}
		return [...groups, incoming];
	}
	const index = groups.findIndex((group) => group.title === incoming.title);
	if (index < 0) return [...groups, incoming];
	const next = [...groups];
	next[index] = reconcileReviewGroup(groups[index], incoming);
	return next;
}

function normalizeIncomingGroup(options: OpenReviewGroupOptions, sessionId: string, source: ReviewSource): ReviewGroupModel {
	const files = normalizeFiles(options.files, sessionId);
	if (files.length === 0) throw new Error("A review must contain at least one file.");
	const requestedActive = normalizeIdentity(options.activeFileId);
	return {
		reviewId: normalizeIdentity(options.reviewId) || newIdentity("review", sessionId),
		title: options.title?.trim() || signoffTitle(source),
		files,
		activeFileId: requestedActive && files.some((file) => file.fileId === requestedActive) ? requestedActive : files[0].fileId,
		source,
	};
}

function reviewWorkspaceTabId(reviewId: string): string {
	return `review:${encodeURIComponent(reviewId)}`;
}

function normalizeArtifactReviewGroup(raw: unknown, reference: ArtifactReviewReference): ReviewGroupModel {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Review payload is malformed.");
	const record = raw as Record<string, unknown>;
	const payloadActiveFileId = isReviewArtifactIdentity(record.activeFileId, "fileId") ? record.activeFileId : undefined;
	if (record.reviewId !== reference.reviewId || record.title !== reference.title
		|| !payloadActiveFileId || !Array.isArray(record.files) || record.files.length === 0) {
		throw new Error("Review payload identity does not match its workspace reference.");
	}
	const seen = new Set<string>();
	const files: ReviewFileModel[] = [];
	for (const rawFile of record.files) {
		if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error("Review payload is malformed.");
		const file = rawFile as Record<string, unknown>;
		const fileId = isReviewArtifactIdentity(file.fileId, "fileId") ? file.fileId : undefined;
		const fileTitle = exactArtifactTitle(file.title);
		if (!fileId || seen.has(fileId) || !fileTitle
			|| typeof file.markdown !== "string") throw new Error("Review payload file identity is invalid.");
		seen.add(fileId);
		files.push({ fileId, title: fileTitle, markdown: file.markdown });
	}
	if (!seen.has(payloadActiveFileId) || !seen.has(reference.activeFileId)) {
		throw new Error("Review payload active file is unavailable.");
	}
	const rawSource = raw && typeof record.source === "object" && !Array.isArray(record.source)
		? record.source as Record<string, unknown>
		: undefined;
	if (rawSource && (rawSource.kind !== "markdown-review" || rawSource.sessionId !== reference.sessionId)) {
		throw new Error("Review payload owner does not match its workspace reference.");
	}
	return {
		reviewId: reference.reviewId,
		title: reference.title,
		files,
		activeFileId: reference.activeFileId,
		source: { kind: "markdown-review", sessionId: reference.sessionId },
	};
}

/**
 * Atomically publish a coordinator-validated payload into client review state.
 * The exact artifact workspace tab must already be authoritative; this function
 * never creates a tab or clears replay suppression during passive hydration.
 */
export function commitArtifactReviewGroup(reference: ArtifactReviewReference, rawGroup: unknown): ReviewGroupModel {
	const workspace = getSidePanelWorkspace(reference.sessionId);
	const tab = workspace.tabs.find((candidate) => candidate.id === reviewWorkspaceTabId(reference.reviewId));
	const authoritative = exactArtifactReferenceFromTab(tab, reference.sessionId);
	if (!authoritative || !artifactReferenceMatches(authoritative, reference)) {
		throw new Error("Review workspace reference is unavailable or changed.");
	}
	const group = normalizeArtifactReviewGroup(rawGroup, authoritative);
	const workspaceReviewIds = workspace.tabs
		.map((candidate) => reviewIdentityFromWorkspaceTab(candidate))
		.filter((identity): identity is string => !!identity);
	const openIds = new Set(workspaceReviewIds);
	const current = sessionGroups(reference.sessionId);
	const byId = new Map(current.filter((candidate) => openIds.has(candidate.reviewId))
		.map((candidate) => [candidate.reviewId, candidate]));
	byId.set(group.reviewId, group);
	const next = workspaceReviewIds.map((reviewId) => byId.get(reviewId))
		.filter((candidate): candidate is ReviewGroupModel => !!candidate);

	artifactReviewReferences.set(artifactReviewKey(reference.sessionId, reference.reviewId), authoritative);
	writeSessionGroups(reference.sessionId, next);
	if (isVisibleSession(reference.sessionId)) {
		const activeTab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId);
		const activeReviewId = reviewIdentityFromWorkspaceTab(activeTab);
		hydrateVisibleReviewGroups(reference.sessionId, next, activeReviewId || group.reviewId);
		if (activeReviewId) {
			state.previewPanelActiveTab = "review";
			state.previewPanelTab = "review";
		}
		renderApp();
	}
	return group;
}

async function openReviewWorkspace(group: ReviewGroupModel, sessionId: string): Promise<void> {
	const tab = {
		id: reviewWorkspaceTabId(group.reviewId),
		kind: "review",
		title: `Review: ${group.title}`,
		label: `Review: ${group.title}`,
		source: { type: "review", sessionId, reviewId: group.reviewId, documentId: group.reviewId, title: group.title },
		state: { activeFileId: group.activeFileId },
		updatedAt: Date.now(),
	} as any;
	try {
		await openSidePanelTab(tab, { focus: true });
	} catch {
		if (!isVisibleSession(sessionId)) return;
		(selectReviewWorkspaceTab as any)(group.title, { sessionId, select: true, reviewId: group.reviewId, documentId: group.reviewId });
	}
}

/** Reconcile a delayed explicit open only after its exact primary is authoritative. */
function reconcileVisibleExplicitReviewOpen(
	sessionId: string,
	reviewId: string,
	isCurrent: () => boolean,
): void {
	if (!isCurrent() || !isVisibleSession(sessionId)) return;
	const current = safeReadPersisted(sessionId).find((group) => group.reviewId === reviewId);
	if (!current) return;
	const hasAuthoritativePrimary = getSidePanelWorkspace(sessionId).tabs.some((tab) =>
		reviewIdentityFromWorkspaceTab(tab) === reviewId);
	if (!hasAuthoritativePrimary || !isCurrent() || !isVisibleSession(sessionId)) return;

	// Reuse the normal authority/tombstone filter. Unlike historical replay,
	// this runs only after an explicit live open created the exact primary.
	restorePersistedReviewDocuments(sessionId, { select: true });
	if (!state.reviewGroups.has(reviewId)) return;
	state.previewPanelActiveTab = "review";
	state.previewPanelTab = "review";
	renderApp();
}

export function openReviewGroup(options: OpenReviewGroupOptions): ReviewGroupModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	const source = sourceWithDefault(options.source, sessionId);
	const incoming = normalizeIncomingGroup(options, sessionId, source);
	const nextGroups = upsertReviewGroup(sessionGroups(sessionId), incoming, options.replace !== false, sessionId);
	const stored = options.replace !== false
		? nextGroups.find((group) => group.title === incoming.title) || incoming
		: nextGroups.find((group) => group.reviewId === incoming.reviewId) || nextGroups[nextGroups.length - 1];
	artifactReviewReferences.delete(artifactReviewKey(sessionId, stored.reviewId));
	writeSessionGroups(sessionId, nextGroups);
	// Every primary open advances exact-key generation immediately. Sign-off
	// launchers are non-live, but must still supersede cleanup before it can
	// commit destructive state after closing an older primary.
	void enqueueReviewLifecycle(sessionId, stored.reviewId, async (isCurrent) => {
		if (!isCurrent()) return;
		// Explicit workspace presence, rather than a cross-store tombstone clear,
		// authorizes this reopen. A failed open therefore leaves replay suppression
		// byte-for-byte unchanged and the same content remains retryable.
		await openReviewWorkspace(stored, sessionId);
		if (!isCurrent()) return;
		if (options.live) reconcileVisibleExplicitReviewOpen(sessionId, stored.reviewId, isCurrent);
	});
	if (isVisibleSession(sessionId)) {
		hydrateVisibleReviewGroups(sessionId, nextGroups, stored.reviewId);
		state.previewPanelActiveTab = "review";
		state.previewPanelTab = "review";
		renderApp();
	}
	return stored;
}

export function openMarkdownReviewGroup(options: Omit<OpenReviewGroupOptions, "source">): ReviewGroupModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	return openReviewGroup({ ...options, sessionId, source: { kind: "markdown-review", sessionId } });
}

export function openMarkdownReviewDocument(options: OpenMarkdownReviewDocumentOptions): ReviewDocumentModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	const group = openMarkdownReviewGroup({
		title: options.title,
		reviewId: options.reviewId || options.documentId,
		files: [{ title: options.title, markdown: options.markdown, fileId: options.fileId || options.documentId }],
		replace: options.replace,
		live: options.live,
		sessionId,
	});
	return compatibilityDocument(group, group.files[0]);
}

export function openReviewDocument(options: OpenReviewDocumentOptions): ReviewDocumentModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	const source = sourceWithDefault(options.source, sessionId);
	const title = options.title || signoffTitle(source);
	const group = openReviewGroup({
		title,
		reviewId: options.reviewId || options.documentId,
		files: [{ title, markdown: options.markdown, fileId: options.fileId || options.documentId }],
		replace: options.replace,
		live: options.live,
		sessionId,
		source,
	});
	return compatibilityDocument(group, group.files[0]);
}

export function openReviewDocumentFromEvent(detail: unknown, sessionId = activeSessionId() || ""): ReviewDocumentModel | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
	const record = detail as Record<string, unknown>;
	const source = normalizeReviewSource(record.source);
	const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : source ? signoffTitle(source) : "Review";
	const replace = typeof record.replace === "boolean" ? record.replace : true;
	if (Array.isArray(record.files)) {
		const group = openReviewGroup({
			title,
			reviewId: normalizeIdentity(record.reviewId),
			files: record.files as OpenReviewFileOptions[],
			activeFileId: normalizeIdentity(record.activeFileId),
			replace,
			live: record.live === true,
			sessionId,
			source,
		});
		const file = group.files.find((candidate) => candidate.fileId === group.activeFileId) || group.files[0];
		return compatibilityDocument(group, file);
	}
	const hasMarkdown = typeof record.markdown === "string";
	const markdown = hasMarkdown ? record.markdown as string : "";
	if (!hasMarkdown && source?.kind !== "verification-signoff-pr") return undefined;
	return openReviewDocument({
		title,
		markdown,
		source,
		documentId: normalizeIdentity(record.documentId),
		reviewId: normalizeIdentity(record.reviewId),
		replace,
		live: record.live === true,
		sessionId,
	});
}

function reviewIdentityFromWorkspaceTab(tab: any): string | undefined {
	if (!tab || tab.kind !== "review") return undefined;
	const source = tab.source && typeof tab.source === "object" ? tab.source as Record<string, unknown> : undefined;
	const artifactBacked = typeof source?.toolCallId === "string"
		|| typeof source?.payloadId === "string"
		|| typeof source?.contentHash === "string";
	if (artifactBacked) return isReviewArtifactIdentity(source?.reviewId, "reviewId") ? source.reviewId : undefined;
	return normalizeIdentity(source?.reviewId) || normalizeIdentity(source?.documentId) || reviewDocumentIdFromPanelTab(tab);
}

export function restorePersistedReviewDocuments(sessionId: string, _options: { select?: boolean } = {}): void {
	const workspace = getSidePanelWorkspace(sessionId);
	const tabs = workspace.tabs.filter((tab) => tab.kind === "review");
	// Before the first workspace response, an empty local mirror is not proof of
	// authoritative absence. Preserve persisted candidates until the server view
	// arrives so an exact tombstone cannot erase content for an already-open tab.
	const workspaceKnown = tabs.length > 0 || typeof state.lastWorkspaceRevisionBySession[sessionId] === "number";
	const openIds = new Set(tabs.map(reviewIdentityFromWorkspaceTab).filter((id): id is string => !!id));
	const persisted = safeReadPersisted(sessionId);
	const inMemoryArtifacts = (state.reviewGroupsBySession[sessionId] || []).filter((group) => {
		const reference = artifactReviewReferences.get(artifactReviewKey(sessionId, group.reviewId));
		if (!reference) return false;
		const tab = tabs.find((candidate) => candidate.id === reviewWorkspaceTabId(group.reviewId));
		const authoritative = exactArtifactReferenceFromTab(tab, sessionId);
		return !!authoritative && artifactReferenceMatches(authoritative, reference);
	});
	const candidatesById = new Map(persisted.map((group) => [group.reviewId, group]));
	for (const group of inMemoryArtifacts) candidatesById.set(group.reviewId, group);
	const candidates = [...candidatesById.values()];
	const tombstones = getReviewTombstones(sessionId);
	const legacySubmitted = isReviewSubmitted(sessionId)
		&& tombstones.size === 0
		&& candidates.length <= 1;
	const legacyTitles = new Set(tabs.map((tab) => reviewTitleFromPanelTab(tab as any) || tab.title.replace(/^Review:\s*/, "")).filter(Boolean));
	const hasAuthoritativePrimary = (group: ReviewGroupModel) =>
		openIds.has(group.reviewId) || legacyTitles.has(group.title);
	// Exact and legacy tombstones suppress only passive recreation of an absent
	// primary. An existing authoritative tab proves an explicit open committed,
	// so reload restores it without rewriting annotation storage.
	const eligible = workspaceKnown
		? candidates.filter((group) =>
			hasAuthoritativePrimary(group) || (!legacySubmitted && !tombstones.has(group.reviewId)))
		: candidates;
	if (workspaceKnown && eligible.length !== candidates.length) writeSessionGroups(sessionId, eligible);

	const restored = workspaceKnown ? eligible.filter(hasAuthoritativePrimary) : [];
	state.reviewGroupsBySession = { ...state.reviewGroupsBySession, [sessionId]: eligible };
	if (!isVisibleSession(sessionId)) return;
	const activeTab = tabs.find((tab) => tab.id === workspace.activeTabId);
	const activeIdentity = reviewIdentityFromWorkspaceTab(activeTab) || restored.find((group) => reviewTitleFromPanelTab(activeTab as any) === group.title)?.reviewId;
	hydrateVisibleReviewGroups(sessionId, restored, activeIdentity);
	renderApp();
}

export function persistReviewGroup(sessionId: string, group: ReviewGroupModel): void {
	const groups = sessionGroups(sessionId);
	const index = groups.findIndex((candidate) => candidate.reviewId === group.reviewId);
	const next = index < 0 ? [...groups, group] : groups.map((candidate, candidateIndex) => candidateIndex === index ? group : candidate);
	artifactReviewReferences.delete(artifactReviewKey(sessionId, group.reviewId));
	writeSessionGroups(sessionId, next);
	if (isVisibleSession(sessionId)) hydrateVisibleReviewGroups(sessionId, next, group.reviewId);
}

export function persistReviewDocument(sessionId: string, doc: ReviewDocumentModel): void {
	const source = sourceWithDefault(doc.source, sessionId);
	const title = doc.title || "Review";
	const reviewId = normalizeIdentity(doc.reviewId) || normalizeIdentity(doc.documentId) || legacyReviewDocumentIdFromTitle(title);
	const fileId = normalizeIdentity(doc.fileId) || normalizeIdentity(doc.documentId) || newIdentity("file", sessionId);
	persistReviewGroup(sessionId, { reviewId, title, files: [{ fileId, title, markdown: doc.markdown }], activeFileId: fileId, source });
}

export function setActiveReviewGroup(sessionId: string, reviewId: string): boolean {
	const groups = sessionGroups(sessionId);
	if (!groups.some((group) => group.reviewId === reviewId)) return false;
	if (isVisibleSession(sessionId)) {
		hydrateVisibleReviewGroups(sessionId, groups, reviewId);
		renderApp();
	}
	return true;
}

export async function setReviewActiveFile(sessionId: string, reviewId: string, fileId: string): Promise<boolean> {
	const groups = sessionGroups(sessionId);
	const index = groups.findIndex((group) => group.reviewId === reviewId);
	if (index < 0 || !groups[index].files.some((file) => file.fileId === fileId)) return false;
	const tabId = reviewWorkspaceTabId(reviewId);
	let workspace = getSidePanelWorkspace(sessionId);
	let tab = workspace.tabs.find((candidate) => candidate.id === tabId && candidate.kind === "review");
	const artifactReference = artifactReviewReferences.get(artifactReviewKey(sessionId, reviewId));
	if (artifactReference && !tab) return false;
	if (tab) {
		const patch = { state: { ...(tab.state || {}), activeFileId: fileId } };
		try {
			workspace = await updateSidePanelTab(tabId, patch, { sessionId });
			tab = workspace.tabs.find((candidate) => candidate.id === tabId && candidate.kind === "review");
			if (tab?.state?.activeFileId !== fileId) {
				workspace = await updateSidePanelTab(tabId, patch, { sessionId });
				tab = workspace.tabs.find((candidate) => candidate.id === tabId && candidate.kind === "review");
			}
			if (!tab || tab.state?.activeFileId !== fileId) return false;
		} catch {
			return false;
		}
	}

	const next = [...groups];
	next[index] = { ...groups[index], activeFileId: fileId };
	if (artifactReference) {
		artifactReviewReferences.set(artifactReviewKey(sessionId, reviewId), { ...artifactReference, activeFileId: fileId });
	}
	writeSessionGroups(sessionId, next);
	if (isVisibleSession(sessionId)) {
		hydrateVisibleReviewGroups(sessionId, next, reviewId);
		renderApp();
	}
	return true;
}

export function removePersistedReviewGroup(sessionId: string, reviewId: string): ReviewGroupModel | undefined {
	const groups = sessionGroups(sessionId);
	const removed = groups.find((group) => group.reviewId === reviewId);
	if (!removed) return undefined;
	const next = groups.filter((group) => group.reviewId !== reviewId);
	writeSessionGroups(sessionId, next);
	artifactReviewReferences.delete(artifactReviewKey(sessionId, reviewId));
	if (isVisibleSession(sessionId)) hydrateVisibleReviewGroups(sessionId, next);
	return removed;
}

/** Compatibility removal: exact identity wins; legacy titles remove owner-session matches only. */
export function removePersistedReviewDocument(sessionId: string, identity: string): void {
	const groups = sessionGroups(sessionId);
	const exact = groups.find((group) => group.reviewId === identity);
	const removedIds = new Set(exact ? [exact.reviewId] : groups.filter((group) => group.title === identity).map((group) => group.reviewId));
	if (removedIds.size === 0) return;
	const next = groups.filter((group) => !removedIds.has(group.reviewId));
	writeSessionGroups(sessionId, next);
	for (const reviewId of removedIds) artifactReviewReferences.delete(artifactReviewKey(sessionId, reviewId));
	if (isVisibleSession(sessionId)) hydrateVisibleReviewGroups(sessionId, next);
}

export function clearPersistedReviewDocuments(sessionId: string): void {
	for (const [key, reference] of artifactReviewReferences) {
		if (reference.sessionId === sessionId) artifactReviewReferences.delete(key);
	}
	writeSessionGroups(sessionId, []);
	if (isVisibleSession(sessionId)) hydrateVisibleReviewGroups(sessionId, []);
}

function workspaceTabMatchesReview(tab: any, group: ReviewGroupModel): boolean {
	if (!tab || tab.kind !== "review") return false;
	const identity = reviewIdentityFromWorkspaceTab(tab);
	if (identity) {
		if (identity === group.reviewId) return true;
		// Flat review workspaces used the document identity for the primary tab.
		// Match only identities owned by this captured group so duplicate review
		// titles in the same session remain isolated.
		return group.files.some((file) => identity === file.fileId);
	}
	return (reviewTitleFromPanelTab(tab) || tab.title?.replace(/^Review:\s*/, "")) === group.title;
}

function documentsForGroup(group: ReviewGroupModel): Map<string, ReviewDocumentModel> {
	return new Map(group.files.map((file) => [file.fileId, compatibilityDocument(group, file)]));
}

function unambiguousFileForComment(group: ReviewGroupModel, comment: ReviewInlineCommentPayload): ReviewFileModel | undefined {
	if (comment.fileId) return group.files.find((candidate) => candidate.fileId === comment.fileId);
	if (!comment.documentTitle) return group.files.length === 1 ? group.files[0] : undefined;
	const matches = group.files.filter((candidate) => candidate.title === comment.documentTitle);
	return matches.length === 1 ? matches[0] : undefined;
}

function annotationCommentsForGroup(sessionId: string, group: ReviewGroupModel): ReviewInlineCommentPayload[] {
	return getInlineCommentPayloads(sessionId, documentsForGroup(group));
}

export function normalizeReviewDecisionPayload(input: ReviewDecisionPayload, sessionId: string, group: ReviewGroupModel): ReviewDecisionPayload {
	const provided = Array.isArray(input.inlineComments) ? input.inlineComments : [];
	let inlineComments: ReviewInlineCommentPayload[];
	if (provided.length === 0) {
		inlineComments = annotationCommentsForGroup(sessionId, group);
	} else {
		const assigned = new Map<string, ReviewInlineCommentPayload[]>();
		for (const comment of provided) {
			const file = unambiguousFileForComment(group, comment);
			if (!file) continue;
			assigned.set(file.fileId, [...(assigned.get(file.fileId) || []), { ...comment, fileId: file.fileId, documentTitle: file.title }]);
		}
		inlineComments = group.files.flatMap((file) => assigned.get(file.fileId) || []);
	}
	return {
		decision: input.decision,
		finalComment: typeof input.finalComment === "string" ? input.finalComment : "",
		inlineComments,
		feedback: provided.length > 0 || inlineComments.length > 0 ? "" : typeof input.feedback === "string" ? input.feedback : "",
	};
}

export function reviewGroupFromDecisionDetail(detail: unknown): ReviewGroupModel | undefined {
	if (detail && typeof detail === "object" && !Array.isArray(detail)) {
		const record = detail as Record<string, unknown>;
		const embedded = normalizeGroup(record.review, activeSessionId() || "");
		if (embedded) return embedded;
		const reviewId = normalizeIdentity(record.reviewId);
		if (reviewId) return state.reviewGroups.get(reviewId);
		const doc = record.document as Record<string, unknown> | undefined;
		const embeddedReviewId = normalizeIdentity(doc?.reviewId);
		if (embeddedReviewId) return state.reviewGroups.get(embeddedReviewId);
		const fileId = normalizeIdentity(doc?.fileId) || normalizeIdentity(doc?.documentId);
		if (fileId) {
			for (const group of state.reviewGroups.values()) if (group.files.some((file) => file.fileId === fileId)) return group;
		}
	}
	return state.reviewGroups.get(state.reviewActiveReviewId);
}

export function reviewDocumentFromDecisionDetail(detail: unknown): ReviewDocumentModel | undefined {
	const group = reviewGroupFromDecisionDetail(detail);
	if (group) {
		const file = group.files.find((candidate) => candidate.fileId === group.activeFileId) || group.files[0];
		return compatibilityDocument(group, file);
	}
	if (detail && typeof detail === "object" && !Array.isArray(detail)) {
		const record = detail as Record<string, unknown>;
		const embedded = record.document;
		if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
			const doc = embedded as Record<string, unknown>;
			if (typeof doc.title === "string" && typeof doc.markdown === "string") {
				return {
					title: doc.title,
					markdown: doc.markdown,
					documentId: normalizeIdentity(doc.documentId),
					fileId: normalizeIdentity(doc.fileId),
					reviewId: normalizeIdentity(doc.reviewId),
					source: normalizeReviewSource(doc.source) || normalizeReviewSource(record.source),
				};
			}
		}
		const fileId = normalizeIdentity(record.fileId) || normalizeIdentity(record.documentId);
		if (fileId) return state.reviewDocuments.get(fileId);
	}
	return state.reviewActiveTab ? state.reviewDocuments.get(state.reviewActiveTab) : undefined;
}

function legacyGroupForDocument(sessionId: string, doc: ReviewDocumentModel): ReviewGroupModel {
	const source = sourceWithDefault(doc.source, sessionId);
	const existing = doc.reviewId ? sessionGroups(sessionId).find((group) => group.reviewId === doc.reviewId) : undefined;
	if (existing) return existing;
	const fileId = doc.fileId || doc.documentId || legacyReviewDocumentIdFromTitle(doc.title);
	return { reviewId: doc.reviewId || doc.documentId || legacyReviewDocumentIdFromTitle(doc.title), title: doc.title, files: [{ fileId, title: doc.title, markdown: doc.markdown }], activeFileId: fileId, source };
}

export function reviewDecisionPayloadFromDetail(detail: unknown, sessionId: string, doc?: ReviewDocumentModel, group?: ReviewGroupModel): ReviewDecisionPayload | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
	const record = detail as Record<string, unknown>;
	const payloadRecord = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : record;
	const decision = payloadRecord.decision;
	if (decision !== "approve" && decision !== "reject") return undefined;
	const target = group || reviewGroupFromDecisionDetail(detail) || legacyGroupForDocument(sessionId, doc || { title: "", markdown: "" });
	return normalizeReviewDecisionPayload({
		decision,
		finalComment: typeof payloadRecord.finalComment === "string" ? payloadRecord.finalComment : "",
		inlineComments: Array.isArray(payloadRecord.inlineComments) ? payloadRecord.inlineComments as ReviewInlineCommentPayload[] : [],
		feedback: typeof payloadRecord.feedback === "string" ? payloadRecord.feedback : "",
	}, sessionId, target);
}

function composeDecisionFeedback(group: ReviewGroupModel, payload: ReviewDecisionPayload): string {
	const sections: string[] = [];
	if (payload.inlineComments.length > 0) {
		const grouped = new Map<string, ReviewInlineCommentPayload[]>();
		for (const comment of payload.inlineComments) {
			const file = unambiguousFileForComment(group, comment);
			if (!file) continue;
			grouped.set(file.fileId, [...(grouped.get(file.fileId) || []), comment]);
		}
		const fileSections: string[] = [];
		for (const file of group.files) {
			const comments = grouped.get(file.fileId) || [];
			if (comments.length === 0) continue;
			const lines = comments.map((comment) => {
				const quote = comment.isCode ? `\`${comment.quote}\`` : `"${comment.quote}"`;
				const location = comment.start != null ? ` (offset ${comment.start}${comment.end != null ? `-${comment.end}` : ""})` : "";
				return `> ${quote}${location}\n\n${comment.comment}`;
			});
			fileSections.push(`### "${file.title}"\n\n${lines.join("\n\n")}`);
		}
		if (fileSections.length > 0) sections.push(`## Inline comments\n\n${fileSections.join("\n\n")}`);
	}
	const finalComment = payload.finalComment.trim();
	if (finalComment) sections.push(`## Final comment\n\n${finalComment}`);
	if (sections.length > 0) return sections.join("\n\n");
	return payload.feedback.trim();
}

function composeMarkdownReviewDecisionFeedback(group: ReviewGroupModel, payload: ReviewDecisionPayload): string {
	const heading = payload.decision === "approve" ? "## Review Approved" : "## Review Rejected";
	const body = composeDecisionFeedback(group, payload);
	return body ? `${heading}\n\n${body}` : `${heading}\n\n${payload.decision === "approve" ? "Approved with no comments." : "Rejected."}`;
}

async function postSignoffDecision(source: Extract<ReviewSource, { kind: "verification-signoff-markdown" }>, group: ReviewGroupModel, payload: ReviewDecisionPayload): Promise<void> {
	const feedback = composeDecisionFeedback(group, payload);
	const body: Record<string, unknown> = {
		signalId: source.signalId,
		stepName: source.stepName,
		decision: payload.decision === "approve" ? "pass" : "fail",
	};
	if (feedback) body.feedback = feedback;
	const res = await gatewayFetch(`/api/goals/${encodeURIComponent(source.goalId)}/gates/${encodeURIComponent(source.gateId)}/signoff`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) {
		let message = `Sign-off failed (${res.status})`;
		try {
			const data = await res.json();
			if (data?.error) message = String(data.error);
			else if (data?.message) message = String(data.message);
		} catch { /* keep status message */ }
		throw new Error(message);
	}
	dispatchHumanSignoffResolved({ goalId: source.goalId, gateId: source.gateId, signalId: source.signalId, stepName: source.stepName, decision: body.decision as "pass" | "fail" });
	await refreshGateStatusForGoal(source.goalId);
}

function reviewGroupMatchesSnapshot(current: ReviewGroupModel, captured: ReviewGroupModel): boolean {
	if (current.reviewId !== captured.reviewId
		|| current.title !== captured.title
		|| current.files.length !== captured.files.length) return false;
	return current.files.every((file, index) => {
		const expected = captured.files[index];
		return file.fileId === expected.fileId
			&& file.title === expected.title
			&& file.markdown === expected.markdown;
	});
}

/** Return the exact persisted group version captured by a lifecycle intent. */
function currentCapturedReviewGroup(sessionId: string, captured: ReviewGroupModel): ReviewGroupModel | undefined {
	const current = sessionGroups(sessionId).find((group) => group.reviewId === captured.reviewId);
	return current && reviewGroupMatchesSnapshot(current, captured) ? current : undefined;
}

/** Remove only the group version whose workspace absence has been confirmed. */
function removeCapturedReviewGroup(sessionId: string, captured: ReviewGroupModel): ReviewGroupModel | undefined {
	const groups = sessionGroups(sessionId);
	const index = groups.findIndex((group) => group.reviewId === captured.reviewId);
	if (index < 0 || !reviewGroupMatchesSnapshot(groups[index], captured)) return undefined;
	const removed = groups[index];
	writeSessionGroups(sessionId, groups.filter((_, candidateIndex) => candidateIndex !== index));
	artifactReviewReferences.delete(artifactReviewKey(sessionId, removed.reviewId));
	return removed;
}

/**
 * Close every canonical or flat-legacy primary before review data is destroyed.
 * A false result means a newer exact-key lifecycle intent superseded this one.
 */
async function closeReviewWorkspaceTabs(
	sessionId: string,
	group: ReviewGroupModel,
	isCurrent: () => boolean,
): Promise<boolean> {
	if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return false;
	const tabIds = new Set<string>([reviewWorkspaceTabId(group.reviewId)]);
	for (const tab of getSidePanelWorkspace(sessionId).tabs) {
		if (workspaceTabMatchesReview(tab, group)) tabIds.add(tab.id);
	}

	let closeError: unknown;
	let authoritative = getSidePanelWorkspace(sessionId);
	for (const tabId of tabIds) {
		if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return false;
		try {
			authoritative = await closeSidePanelTab(tabId, { sessionId, retryConflictOnce: true });
		} catch (error) {
			closeError ??= error;
			authoritative = getSidePanelWorkspace(sessionId);
		}
		if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return false;
	}

	const remainingTabs = authoritative.tabs.filter((tab) =>
		tabIds.has(tab.id) || workspaceTabMatchesReview(tab, group));
	if (closeError || remainingTabs.length > 0) {
		const detail = closeError instanceof Error && closeError.message ? ` ${closeError.message}` : "";
		throw new Error(`Review workspace tab could not be closed. Review content was preserved; retry the close.${detail}`);
	}
	return true;
}

/** Commit destructive review cleanup only after authoritative workspace absence. */
async function commitReviewGroupCleanup(
	sessionId: string,
	group: ReviewGroupModel,
	isCurrent: () => boolean,
	tombstone: "closed" | "submitted" | false,
): Promise<ReviewGroupModel | undefined> {
	if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return undefined;
	if (tombstone !== false) {
		await setReviewTombstone(sessionId, group.reviewId, tombstone, group.activeFileId);
		// A newer explicit open may have committed while this write was pending.
		// Its authoritative primary wins over this passive-replay marker, so do
		// not perform a compensating annotation write that could clobber a later
		// exact or sibling mutation.
		if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return undefined;
	}

	const removed = removeCapturedReviewGroup(sessionId, group);
	if (!removed) return undefined;
	const closingTitles = new Set(removed.files.map((file) => file.title));
	const remainingTitles = new Set(sessionGroups(sessionId).flatMap((candidate) => candidate.files.map((file) => file.title)));
	for (const file of removed.files) clearAnnotations(sessionId, file.fileId);
	// Legacy one-document annotations were title-keyed. Clear each bucket once
	// after the group is removed, unless a sibling review still owns that title.
	for (const title of closingTitles) {
		if (!remainingTitles.has(title)) clearAnnotations(sessionId, title);
	}
	clearAnnotations(sessionId, removed.reviewId);
	await flushPendingWrites();
	if (!isCurrent()) return undefined;

	if (isVisibleSession(sessionId)) {
		hydrateVisibleReviewGroups(sessionId, sessionGroups(sessionId));
		renderApp();
	}
	return removed;
}

export async function cleanupReviewGroup(
	sessionId: string,
	reviewId: string,
	options: { tombstone?: "closed" | false } = {},
): Promise<ReviewGroupModel | undefined> {
	const group = sessionGroups(sessionId).find((candidate) => candidate.reviewId === reviewId);
	if (!group) return undefined;

	return enqueueReviewLifecycle(sessionId, reviewId, async (isCurrent) => {
		if (!isCurrent() || !currentCapturedReviewGroup(sessionId, group)) return undefined;
		if (!await closeReviewWorkspaceTabs(sessionId, group, isCurrent)) return undefined;
		return commitReviewGroupCleanup(
			sessionId,
			group,
			isCurrent,
			options.tombstone === false ? false : options.tombstone || "closed",
		);
	});
}

export function submitReviewGroupDecision(
	group: ReviewGroupModel,
	inputPayload: ReviewDecisionPayload,
	options: SubmitReviewDecisionOptions = {},
): Promise<ReviewDecisionSubmissionOutcome> {
	const sessionId = options.sessionId || (group.source.kind === "markdown-review" ? group.source.sessionId : activeSessionId()) || "";
	const key = reviewLifecycleKey(sessionId, group.reviewId);
	const pending = pendingReviewDecisions.get(key);
	// The first accepted exact-key decision owns its external effect. Repeated or
	// conflicting clicks await that same result rather than enqueueing a newer
	// lifecycle generation which could send a second prompt/sign-off.
	if (pending) return pending;

	let payload: ReviewDecisionPayload;
	let source: ReviewSource;
	try {
		payload = normalizeReviewDecisionPayload(inputPayload, sessionId, group);
		if (payload.decision === "reject" && !payload.finalComment.trim() && payload.inlineComments.length === 0) throw new Error("Reject requires at least one comment.");
		source = sourceWithDefault(group.source, sessionId);
		if (source.kind === "verification-signoff-pr") throw new Error("PR review source is not implemented yet.");
	} catch (error) {
		return Promise.reject(error);
	}

	const outcome = (submitted: boolean): ReviewDecisionSubmissionOutcome => ({
		submitted,
		sessionId,
		reviewId: group.reviewId,
		finalComment: payload.finalComment,
	});
	const decision = enqueueReviewLifecycle(sessionId, group.reviewId, async (isCurrent) => {
		// A close or explicit live reopen may supersede this queued intent before
		// it starts. Never send its irreversible external effect in that case.
		if (!isCurrent()) return outcome(false);
		if (source.kind === "verification-signoff-markdown") {
			await postSignoffDecision(source, group, payload);
		} else {
			if (!options.prompt) throw new Error("No active agent is available for this review.");
			await options.prompt(composeMarkdownReviewDecisionFeedback(group, payload));
		}
		if (!isCurrent()) return outcome(false);

		// External feedback is intentionally delivered before workspace cleanup.
		// Keep the captured group, annotations, draft, and replay eligibility until
		// every authoritative primary is absent. A later manual retry after a
		// surfaced terminal infrastructure failure may repeat external feedback;
		// avoiding that requires a separate persisted delivery protocol.
		if (!currentCapturedReviewGroup(sessionId, group)) return outcome(false);
		if (!await closeReviewWorkspaceTabs(sessionId, group, isCurrent)) return outcome(false);
		const removed = await commitReviewGroupCleanup(
			sessionId,
			group,
			isCurrent,
			source.kind === "markdown-review" && sessionId ? "submitted" : false,
		);
		return outcome(!!removed);
	});

	// Install synchronously, before the queued lifecycle operation can yield to
	// an external prompt/sign-off. Identity guards prevent an older completion
	// from deleting a later pending decision for the same exact key.
	pendingReviewDecisions.set(key, decision);
	void decision.finally(() => {
		if (pendingReviewDecisions.get(key) === decision) pendingReviewDecisions.delete(key);
	}).catch(() => {
		// The original decision promise remains the caller-visible rejection.
	});
	return decision;
}

export const removeReviewGroup = cleanupReviewGroup;
export const restorePersistedReviewGroups = restorePersistedReviewDocuments;
export const clearPersistedReviewGroups = clearPersistedReviewDocuments;

export function submitReviewDecision(
	doc: ReviewDocumentModel,
	inputPayload: ReviewDecisionPayload,
	options: SubmitReviewDecisionOptions = {},
): Promise<ReviewDecisionSubmissionOutcome> {
	const sessionId = options.sessionId || activeSessionId() || "";
	const group = (doc.reviewId ? sessionGroups(sessionId).find((candidate) => candidate.reviewId === doc.reviewId) : undefined) || legacyGroupForDocument(sessionId, doc);
	return submitReviewGroupDecision(group, inputPayload, options);
}
