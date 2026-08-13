import {
  activeGatewayConnection,
  gatewayFetch,
  gatewayNativeTransportSupport,
  gatewayUrl,
} from "../../../app/gateway-fetch.js";
import { gatewayRoute } from "../../../shared/base-path.js";
import type {
  ReviewDecision,
  ReviewDecisionPayload,
  ReviewDocumentModel,
  ReviewGroupModel,
  ReviewInlineCommentPayload,
} from "./review-types.js";

/**
 * AnnotationStore — Pure data module for managing review annotations.
 * No Lit dependency. Uses in-memory cache with server-side persistence.
 *
 * Cache-first pattern: all reads are synchronous from cache. Writes update
 * cache immediately and return the server persistence promise so callers can
 * await durability before navigation/reload-sensitive UI state changes.
 * On session connect, `initAnnotationStore()` hydrates cache from server.
 */

// ── Pluggable backend interface (used by <review-document>) ──────────

export type AnnotationKey = { sessionId: string; bucket: string };

export interface AnnotationBackend {
  add(key: AnnotationKey, ann: ReviewAnnotation): void | Promise<void>;
  remove(key: AnnotationKey, id: string): void | Promise<void>;
  get(key: AnnotationKey): ReviewAnnotation[];
}

export interface ReviewAnnotation {
  id: string;
  /** The quoted/selected text */
  quote: string;
  /** User's comment on the selection */
  comment: string;
  /** Text before the selection (for re-anchoring) */
  prefix?: string;
  /** Text after the selection (for re-anchoring) */
  suffix?: string;
  /** Character offset start */
  start?: number;
  /** Character offset end */
  end?: number;
  /** Whether the selection was inside a code block */
  isCode?: boolean;
}

// ── Module-level caches ──────────────────────────────────────────────

/** sessionId → (docTitle → annotations[]) */
const _annotationCache = new Map<string, Map<string, ReviewAnnotation[]>>();

/** sessionId → submitted flag (legacy one-review compatibility only). */
const _submittedCache = new Map<string, boolean>();

export type ReviewTombstoneState = "submitted" | "closed";

/** sessionId → (reviewId → durable replay tombstone). */
const _reviewTombstoneCache = new Map<string, Map<string, ReviewTombstoneState>>();

/** Tombstone mutations must win over an annotation GET already in flight. */
let _tombstoneMutationVersion = 0;
const _tombstoneMutationVersions = new Map<string, Map<string, number>>();
/** Session-wide legacy submitted mutations must also win over an in-flight hydration. */
const _legacySubmittedMutationVersions = new Map<string, number>();
const _pendingTombstoneWrites = new Map<string, Set<Promise<void>>>();
const _annotationHydrationGeneration = new Map<string, number>();

/**
 * Monotonically increasing version counter, bumped on cache hydration.
 * Used internally to track mutations; not exported.
 */
let _cacheVersion = 0;

// ── Pending write tracking ───────────────────────────────────────────

/** All in-flight server write promises (cleaned up on resolve). */
const _pendingWrites: Promise<void>[] = [];

/**
 * Wait for all pending server writes to complete.
 * Useful before page navigation/reload to ensure data is persisted.
 */
export async function flushPendingWrites(): Promise<void> {
  await Promise.all([..._pendingWrites]);
}

// ── Internal helpers ─────────────────────────────────────────────────

function _isKeepaliveSafe(options?: RequestInit): boolean {
  const body = options?.body;
  if (body == null) return true;
  if (typeof body !== "string") return false;
  return new TextEncoder().encode(body).byteLength <= 60 * 1024;
}

function _serverFetch(route: string, options?: RequestInit): Promise<void> {
  const p = gatewayFetch(gatewayRoute(route), {
    ...options,
    keepalive: options?.keepalive ?? _isKeepaliveSafe(options),
  }).then(() => {}).catch(() => {
    // Persistence is best-effort when the server is unavailable. Callers that
    // await this promise still wait for the request to settle when it can run.
  });
  _pendingWrites.push(p);
  p.finally(() => {
    const idx = _pendingWrites.indexOf(p);
    if (idx >= 0) _pendingWrites.splice(idx, 1);
  });
  return p;
}

function _ensureSessionCache(sessionId: string): Map<string, ReviewAnnotation[]> {
  let sessionCache = _annotationCache.get(sessionId);
  if (!sessionCache) {
    sessionCache = new Map();
    _annotationCache.set(sessionId, sessionCache);
  }
  return sessionCache;
}

// ── Initialization ───────────────────────────────────────────────────

function _applyTombstoneMutationsAfter(
  sessionId: string,
  hydrated: Map<string, ReviewTombstoneState>,
  afterVersion: number,
): Map<string, ReviewTombstoneState> {
  const local = _reviewTombstoneCache.get(sessionId);
  for (const [reviewId, version] of _tombstoneMutationVersions.get(sessionId) || []) {
    if (version <= afterVersion) continue;
    const state = local?.get(reviewId);
    if (state) hydrated.set(reviewId, state);
    else hydrated.delete(reviewId);
  }
  return hydrated;
}

function _applyLegacySubmittedMutationAfter(sessionId: string, hydrated: boolean, afterVersion: number): boolean {
  const mutationVersion = _legacySubmittedMutationVersions.get(sessionId) || 0;
  return mutationVersion > afterVersion ? _submittedCache.get(sessionId) === true : hydrated;
}

/**
 * Hydrate the in-memory cache from the server for a given session.
 * Call once on session connect, before reading annotations or submitted state.
 */
export async function initAnnotationStore(sessionId: string): Promise<void> {
  const generation = (_annotationHydrationGeneration.get(sessionId) || 0) + 1;
  _annotationHydrationGeneration.set(sessionId, generation);
  const pendingBeforeHydration = [...(_pendingTombstoneWrites.get(sessionId) || [])];
  if (pendingBeforeHydration.length > 0) await Promise.all(pendingBeforeHydration);
  const mutationVersionAtRequest = _tombstoneMutationVersion;
  try {
    const res = await gatewayFetch(gatewayRoute(`/api/sessions/${sessionId}/review/annotations`));
    if (_annotationHydrationGeneration.get(sessionId) !== generation) return;
    if (!res.ok) {
      // Server doesn't have data yet or session not found — start empty, while
      // retaining a live exact mutation that landed during this request.
      _annotationCache.set(sessionId, new Map());
      _submittedCache.set(sessionId, _applyLegacySubmittedMutationAfter(sessionId, false, mutationVersionAtRequest));
      _reviewTombstoneCache.set(sessionId, _applyTombstoneMutationsAfter(sessionId, new Map(), mutationVersionAtRequest));
      return;
    }
    const data = await res.json();
    const sessionCache = new Map<string, ReviewAnnotation[]>();
    if (data.annotations && typeof data.annotations === "object") {
      for (const [docTitle, annotations] of Object.entries(data.annotations)) {
        if (Array.isArray(annotations)) {
          sessionCache.set(docTitle, annotations as ReviewAnnotation[]);
        }
      }
    }
    _annotationCache.set(sessionId, sessionCache);
    _submittedCache.set(sessionId, _applyLegacySubmittedMutationAfter(sessionId, !!data.submitted, mutationVersionAtRequest));
    const tombstones = new Map<string, ReviewTombstoneState>();
    if (Array.isArray(data.submittedReviewIds)) {
      for (const reviewId of data.submittedReviewIds) {
        if (typeof reviewId === "string" && reviewId.trim()) tombstones.set(reviewId, "submitted");
      }
    }
    if (Array.isArray(data.closedReviewIds)) {
      for (const reviewId of data.closedReviewIds) {
        if (typeof reviewId === "string" && reviewId.trim()) tombstones.set(reviewId, "closed");
      }
    }
    _reviewTombstoneCache.set(sessionId, _applyTombstoneMutationsAfter(sessionId, tombstones, mutationVersionAtRequest));
    _cacheVersion++;
    // Notify any open review panes so they can refresh annotation counts.
    // This handles the race where a review pane was created (via a concurrent
    // event) before initAnnotationStore finished hydrating the cache.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("annotation-cache-ready", { detail: { sessionId } }));
    }
  } catch {
    if (_annotationHydrationGeneration.get(sessionId) !== generation) return;
    // Network error — initialize empty caches for graceful degradation while
    // retaining a live exact mutation that landed during this request.
    _annotationCache.set(sessionId, new Map());
    _submittedCache.set(sessionId, _applyLegacySubmittedMutationAfter(sessionId, false, mutationVersionAtRequest));
    _reviewTombstoneCache.set(sessionId, _applyTombstoneMutationsAfter(sessionId, new Map(), mutationVersionAtRequest));
  }
}

// ── Annotation CRUD ──────────────────────────────────────────────────

export function addAnnotation(sessionId: string, docTitle: string, annotation: ReviewAnnotation): Promise<void> {
  const sessionCache = _ensureSessionCache(sessionId);
  const docAnnotations = [...(sessionCache.get(docTitle) || [])];
  docAnnotations.push(annotation);
  sessionCache.set(docTitle, docAnnotations);

  return _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docTitle, annotation }),
  });
}

export function removeAnnotation(sessionId: string, docTitle: string, annotationId: string): Promise<void> {
  const sessionCache = _annotationCache.get(sessionId);
  if (sessionCache) {
    const filtered = (sessionCache.get(docTitle) || []).filter(a => a.id !== annotationId);
    sessionCache.set(docTitle, filtered);
  }

  return _serverFetch(
    `/api/sessions/${sessionId}/review/annotations/${encodeURIComponent(annotationId)}?docTitle=${encodeURIComponent(docTitle)}`,
    { method: "DELETE" },
  );
}

export function getAnnotations(sessionId: string, docTitle: string): ReviewAnnotation[] {
  return _annotationCache.get(sessionId)?.get(docTitle) || [];
}

export function clearAnnotations(sessionId: string, docTitle: string): Promise<void> {
  _annotationCache.get(sessionId)?.delete(docTitle);

  return _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docTitle }),
  });
}

export function clearAllAnnotations(sessionId: string): Promise<void> {
  _annotationCache.delete(sessionId);

  return _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "DELETE",
  });
}

// ── Review replay tombstones ─────────────────────────────────────────

function _ensureTombstoneCache(sessionId: string): Map<string, ReviewTombstoneState> {
  let sessionCache = _reviewTombstoneCache.get(sessionId);
  if (!sessionCache) {
    sessionCache = new Map();
    _reviewTombstoneCache.set(sessionId, sessionCache);
  }
  return sessionCache;
}

function _recordTombstoneMutation(sessionId: string, reviewId: string): void {
  _tombstoneMutationVersion += 1;
  let versions = _tombstoneMutationVersions.get(sessionId);
  if (!versions) {
    versions = new Map();
    _tombstoneMutationVersions.set(sessionId, versions);
  }
  versions.set(reviewId, _tombstoneMutationVersion);
}

function _recordLegacySubmittedMutation(sessionId: string): void {
  _tombstoneMutationVersion += 1;
  _legacySubmittedMutationVersions.set(sessionId, _tombstoneMutationVersion);
}

function _trackTombstoneWrite(sessionId: string, write: Promise<void>): Promise<void> {
  let pending = _pendingTombstoneWrites.get(sessionId);
  if (!pending) {
    pending = new Set();
    _pendingTombstoneWrites.set(sessionId, pending);
  }
  pending.add(write);
  write.finally(() => {
    pending?.delete(write);
    if (pending?.size === 0) _pendingTombstoneWrites.delete(sessionId);
  });
  return write;
}

/** Persist an exact review's replay tombstone without suppressing sibling reviews. */
export function setReviewTombstone(
  sessionId: string,
  reviewId: string,
  state: ReviewTombstoneState,
  activeFileId?: string,
): Promise<void> {
  _ensureTombstoneCache(sessionId).set(reviewId, state);
  _recordTombstoneMutation(sessionId, reviewId);
  return _trackTombstoneWrite(sessionId, _serverFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/review/tombstones/${encodeURIComponent(reviewId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, ...(activeFileId ? { activeFileId } : {}) }),
    },
  ));
}

/** Explicitly clear an exact review tombstone; normal review opens do not call this. */
export function clearReviewTombstone(
  sessionId: string,
  reviewId: string,
  options: { clearLegacySubmitted?: boolean } = {},
): Promise<void> {
  _reviewTombstoneCache.get(sessionId)?.delete(reviewId);
  _recordTombstoneMutation(sessionId, reviewId);
  if (options.clearLegacySubmitted) {
    _submittedCache.set(sessionId, false);
    _recordLegacySubmittedMutation(sessionId);
  }
  // Deliberately unconditional: a background live open can arrive before this
  // browser hydrated the owner session's cache, while the server is tombstoned.
  const query = options.clearLegacySubmitted ? "?clearLegacySubmitted=true" : "";
  return _trackTombstoneWrite(sessionId, _serverFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/review/tombstones/${encodeURIComponent(reviewId)}${query}`,
    { method: "DELETE" },
  ));
}

export function getReviewTombstone(sessionId: string, reviewId: string): ReviewTombstoneState | undefined {
  return _reviewTombstoneCache.get(sessionId)?.get(reviewId);
}

export function getReviewTombstones(sessionId: string): ReadonlyMap<string, ReviewTombstoneState> {
  return new Map(_reviewTombstoneCache.get(sessionId) || []);
}

export function isReviewTombstoned(sessionId: string, reviewId: string): boolean {
  return getReviewTombstone(sessionId, reviewId) !== undefined;
}

/**
 * Mark a review submitted. Supplying reviewId uses the canonical per-review
 * route; the one-argument form remains for historical one-review callers.
 */
export function markReviewSubmitted(sessionId: string, reviewId?: string): Promise<void> {
  if (reviewId) return setReviewTombstone(sessionId, reviewId, "submitted");
  _submittedCache.set(sessionId, true);
  return _serverFetch(`/api/sessions/${sessionId}/review/submitted`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submitted: true }),
  });
}

/** Check exact review state when reviewId is supplied; preserve legacy reads otherwise. */
export function isReviewSubmitted(sessionId: string, reviewId?: string): boolean {
  return reviewId
    ? getReviewTombstone(sessionId, reviewId) === "submitted"
    : _submittedCache.get(sessionId) || false;
}

/**
 * Clear submitted replay state. Exact review clearing never mutates the legacy
 * session-wide flag or another review's tombstone.
 */
export function clearReviewSubmitted(sessionId: string, reviewId?: string): Promise<void> | void {
  if (reviewId) return clearReviewTombstone(sessionId, reviewId);
  const wasSubmitted = _submittedCache.get(sessionId) === true;
  _submittedCache.set(sessionId, false);
  if (!wasSubmitted) return;

  return _serverFetch(`/api/sessions/${sessionId}/review/submitted`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submitted: false }),
  });
}

// ── Aggregate helpers ────────────────────────────────────────────────

type ReviewDocumentLike = Pick<ReviewDocumentModel, "title" | "markdown" | "documentId">;
type ReviewDocumentCollection = ReadonlyMap<string, ReviewDocumentLike>;

function _displayTitle(key: string, doc: ReviewDocumentLike): string {
  return doc.title || key;
}

function _uniquePush(values: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || values.includes(trimmed)) return;
  values.push(trimmed);
}

function _isUniqueDocumentTitle(
  doc: ReviewDocumentLike,
  documents?: ReviewDocumentCollection,
): boolean {
  const title = doc.title?.trim();
  if (!title) return false;
  if (!documents) return true;

  let matches = 0;
  for (const [candidateKey, candidate] of documents) {
    const candidateTitle = candidate.title?.trim() || candidateKey;
    if (candidateTitle === title) matches += 1;
    if (matches > 1) return false;
  }
  return true;
}

function _annotationBucketCandidates(
  documentKey: string,
  document: ReviewDocumentLike,
  documents?: ReviewDocumentCollection,
): string[] {
  const candidates: string[] = [];
  _uniquePush(candidates, documentKey);
  _uniquePush(candidates, document.documentId);
  if (_isUniqueDocumentTitle(document, documents)) {
    _uniquePush(candidates, document.title);
  }
  return candidates;
}

export function getAnnotationBucketForDocument(
  sessionId: string,
  documentKey: string,
  document: ReviewDocumentLike,
  documents?: ReviewDocumentCollection,
): string {
  const candidates = _annotationBucketCandidates(documentKey, document, documents);
  const sessionCache = _annotationCache.get(sessionId);
  if (sessionCache) {
    for (const bucket of candidates) {
      if ((sessionCache.get(bucket) || []).length > 0) return bucket;
    }
  }
  return candidates[0] || documentKey || document.title;
}

export function getAnnotationsForDocument(
  sessionId: string,
  documentKey: string,
  document: ReviewDocumentLike,
  documents?: ReviewDocumentCollection,
): ReviewAnnotation[] {
  const sessionCache = _annotationCache.get(sessionId);
  if (!sessionCache) return [];

  const seen = new Set<string>();
  const annotations: ReviewAnnotation[] = [];
  for (const bucket of _annotationBucketCandidates(documentKey, document, documents)) {
    for (const ann of sessionCache.get(bucket) || []) {
      const identity = ann.id || `${ann.start ?? ""}:${ann.end ?? ""}:${ann.quote}:${ann.comment}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      annotations.push(ann);
    }
  }
  return annotations;
}

export function getDocumentAnnotationCountForDocument(
  sessionId: string,
  documentKey: string,
  document: ReviewDocumentLike,
  documents?: ReviewDocumentCollection,
): number {
  return getAnnotationsForDocument(sessionId, documentKey, document, documents).length;
}

function _documentForComment(
  comment: ReviewInlineCommentPayload,
  documents: ReviewDocumentCollection,
): ReviewDocumentLike | undefined {
  const identityMatch = comment.fileId ? documents.get(comment.fileId) : undefined;
  if (identityMatch) return identityMatch;
  const directMatch = documents.get(comment.documentTitle);
  if (directMatch) return directMatch;
  for (const [key, doc] of documents) {
    if (_displayTitle(key, doc) === comment.documentTitle) return doc;
  }
  return undefined;
}

function _lineNumberForComment(
  comment: ReviewInlineCommentPayload,
  documents: ReviewDocumentCollection,
): number | undefined {
  if (comment.start == null) return undefined;
  const doc = _documentForComment(comment, documents);
  return doc?.markdown.substring(0, comment.start).split("\n").length;
}

function _formatInlineCommentSections(
  inlineComments: ReviewInlineCommentPayload[],
  documents: ReviewDocumentCollection,
): string[] {
  const commentsByIdentity = new Map<string, ReviewInlineCommentPayload[]>();
  for (const comment of inlineComments) {
    const identity = comment.fileId || comment.documentTitle;
    commentsByIdentity.set(identity, [...(commentsByIdentity.get(identity) || []), comment]);
  }

  const sections: string[] = [];
  const rendered = new Set<string>();
  const appendSection = (identity: string, title: string) => {
    const comments = commentsByIdentity.get(identity) || [];
    if (comments.length === 0 || rendered.has(identity)) return;
    rendered.add(identity);
    const commentWord = comments.length === 1 ? "comment" : "comments";
    sections.push(`### "${title}" — ${comments.length} ${commentWord}`);
    for (const comment of comments) {
      const quotedText = comment.isCode ? `\`${comment.quote}\`` : `"${comment.quote}"`;
      const lineNum = _lineNumberForComment(comment, documents);
      const locationParts: string[] = [];
      if (lineNum != null) locationParts.push(`line ${lineNum}`);
      if (comment.start != null) locationParts.push(`offset ${comment.start}-${comment.end}`);
      const location = locationParts.length > 0 ? ` (${locationParts.join(", ")})` : "";
      sections.push(`> ${quotedText}${location}\n${comment.comment}`);
    }
  };

  // The document map's insertion order is the review file order. This keeps
  // duplicate display titles distinct because stable file identity is the key.
  for (const [identity, document] of documents) appendSection(identity, _displayTitle(identity, document));
  for (const [identity, comments] of commentsByIdentity) appendSection(identity, comments[0]?.documentTitle || identity);
  return sections;
}

/**
 * Count total annotations across all open documents for a session.
 */
export function getTotalAnnotationCount(
  sessionId: string,
  documents: ReviewDocumentCollection,
): number {
  let total = 0;
  for (const [title, doc] of documents) {
    total += getDocumentAnnotationCountForDocument(sessionId, title, doc, documents);
  }
  return total;
}

export function getDocumentAnnotationCount(sessionId: string, documentTitle: string): number {
  return getAnnotations(sessionId, documentTitle).length;
}

function _inlineCommentPayloadsForEntries(
  sessionId: string,
  entries: Iterable<readonly [string, ReviewDocumentLike]>,
  documents?: ReviewDocumentCollection,
): ReviewInlineCommentPayload[] {
  const inlineComments: ReviewInlineCommentPayload[] = [];

  for (const [title, doc] of entries) {
    for (const ann of getAnnotationsForDocument(sessionId, title, doc, documents)) {
      inlineComments.push({
        fileId: doc.documentId || title,
        documentTitle: _displayTitle(title, doc),
        quote: ann.quote,
        comment: ann.comment,
        prefix: ann.prefix,
        suffix: ann.suffix,
        start: ann.start,
        end: ann.end,
        isCode: ann.isCode,
      });
    }
  }

  return inlineComments;
}

/**
 * Return structured inline-comment payloads for all annotations across open documents.
 */
export function getInlineCommentPayloads(
  sessionId: string,
  documents: ReviewDocumentCollection,
): ReviewInlineCommentPayload[] {
  return _inlineCommentPayloadsForEntries(sessionId, documents, documents);
}

export function getInlineCommentPayloadsForDocument(
  sessionId: string,
  documentTitle: string,
  document: ReviewDocumentLike,
): ReviewInlineCommentPayload[] {
  return _inlineCommentPayloadsForEntries(sessionId, [[documentTitle, document]], new Map([[documentTitle, document]]));
}

/**
 * Compose all annotations across all documents into a structured review feedback string.
 */
export function composeReviewFeedback(
  sessionId: string,
  documents: ReviewDocumentCollection,
): string {
  const inlineComments = getInlineCommentPayloads(sessionId, documents);
  const sections = _formatInlineCommentSections(inlineComments, documents);
  if (sections.length === 0) return "";
  return `## Review Feedback\n\n${sections.join("\n\n")}`;
}

export function composeReviewDecisionFeedback(
  decision: ReviewDecision,
  finalComment: string,
  inlineComments: ReviewInlineCommentPayload[],
  documents: ReviewDocumentCollection,
): string {
  const heading = decision === "approve" ? "Review Approved" : "Review Rejected";
  const sections: string[] = [`## ${heading}`];
  const trimmedFinalComment = finalComment.trim();

  const inlineSections = _formatInlineCommentSections(inlineComments, documents);
  if (inlineSections.length > 0) {
    sections.push(`### Inline comments\n\n${inlineSections.join("\n\n")}`);
  }

  if (trimmedFinalComment) {
    sections.push(`### Final comment\n\n${trimmedFinalComment}`);
  }

  if (sections.length === 1) {
    sections.push(decision === "approve" ? "Approved with no comments." : "Rejected.");
  }

  return sections.join("\n\n");
}

export function buildReviewDecisionPayload(
  sessionId: string,
  documents: ReviewDocumentCollection,
  decision: ReviewDecision,
  finalComment: string,
): ReviewDecisionPayload {
  const normalizedFinalComment = finalComment.trim();
  const inlineComments = getInlineCommentPayloads(sessionId, documents);
  return {
    decision,
    finalComment: normalizedFinalComment,
    inlineComments,
    feedback: composeReviewDecisionFeedback(decision, normalizedFinalComment, inlineComments, documents),
  };
}

export function buildReviewDecisionPayloadForDocument(
  sessionId: string,
  documentTitle: string,
  document: Pick<ReviewDocumentModel, "title" | "markdown" | "documentId">,
  decision: ReviewDecision,
  finalComment: string,
): ReviewDecisionPayload {
  const documents = new Map([[documentTitle, document]]);
  const normalizedFinalComment = finalComment.trim();
  const inlineComments = getInlineCommentPayloadsForDocument(sessionId, documentTitle, document);
  return {
    decision,
    finalComment: normalizedFinalComment,
    inlineComments,
    feedback: composeReviewDecisionFeedback(decision, normalizedFinalComment, inlineComments, documents),
  };
}

function _documentsForReview(review: ReviewGroupModel): ReviewDocumentCollection {
  return new Map(review.files.map((file) => [file.fileId, {
    title: file.title,
    markdown: file.markdown,
    documentId: file.fileId,
  }]));
}

/** Count inline annotations across every ordered file in one review. */
export function getReviewAnnotationCount(sessionId: string, review: ReviewGroupModel): number {
  return getTotalAnnotationCount(sessionId, _documentsForReview(review));
}

/** Build one deterministic whole-review decision grouped by stable file identity. */
export function buildReviewDecisionPayloadForReview(
  sessionId: string,
  review: ReviewGroupModel,
  decision: ReviewDecision,
  finalComment: string,
): ReviewDecisionPayload {
  return buildReviewDecisionPayload(sessionId, _documentsForReview(review), decision, finalComment);
}

// ── Default backend adapter (REST-backed review-pane store) ─────────

export const reviewBackend: AnnotationBackend = {
  add: (k, a) => addAnnotation(k.sessionId, k.bucket, a),
  remove: (k, id) => removeAnnotation(k.sessionId, k.bucket, id),
  get: (k) => getAnnotations(k.sessionId, k.bucket),
};

// ── beforeunload: flush cache to server via sendBeacon ───────────────
//
// IMPORTANT: this beacon must NEVER write `submitted: false`. The submitted
// flag has its own dedicated PUT/clear endpoints that the UI already calls
// synchronously when the user submits or when a fresh review_open arrives.
// A redundant `submitted: false` from the beacon races with concurrent
// out-of-band toggles (other tabs, REST clients, the test harness's
// `setSubmittedViaAPI`) and clobbers them on reload — the original RP-09
// regression. We only positively beacon `submitted: true` to cover the edge
// case where the user submits and immediately closes the tab before the
// dedicated PUT has flushed; the existing PUT is a superset of that
// guarantee but the beacon is harmless when it agrees.

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    const connection = activeGatewayConnection();
    // sendBeacon cannot set a bearer header. Exact-origin gateways can instead
    // authenticate with the signed browser cookie; cross-origin gateways rely
    // on the ordinary authenticated persistence requests made before unload.
    // Never put either a real token or the localhost sentinel in the URL.
    if (!gatewayNativeTransportSupport(connection.baseUrl).supported) return;

    for (const [sessionId, sessionCache] of _annotationCache) {
      if (sessionCache.size === 0) continue;
      const annotations: Record<string, ReviewAnnotation[]> = {};
      for (const [docTitle, anns] of sessionCache) {
        annotations[docTitle] = anns;
      }
      const submitted = _submittedCache.get(sessionId) === true;
      // Only include `submitted: true`. If the local cache says false we
      // omit the field so the server keeps whatever it already has.
      const payload = submitted
        ? { annotations, submitted: true }
        : { annotations };
      const route = gatewayRoute(
        `/api/sessions/${encodeURIComponent(sessionId)}/review/annotations/bulk`,
      );
      navigator.sendBeacon(
        gatewayUrl(route, connection.baseUrl),
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
      );
    }
  });
}
