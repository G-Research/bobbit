/**
 * AnnotationStore — Pure data module for managing review annotations.
 * No Lit dependency. Uses in-memory cache with server-side persistence.
 *
 * Cache-first pattern: all reads are synchronous from cache, all writes
 * update cache immediately and fire-and-forget to server API.
 * On session connect, `initAnnotationStore()` hydrates cache from server.
 */

// ── Pluggable backend interface (used by <review-document>) ──────────

export type AnnotationKey = { sessionId: string; bucket: string };

export interface AnnotationBackend {
  add(key: AnnotationKey, ann: ReviewAnnotation): void;
  remove(key: AnnotationKey, id: string): void;
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

/** sessionId → submitted flag */
const _submittedCache = new Map<string, boolean>();

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

/** Build auth headers from localStorage (same token used by gatewayFetch in api.ts). */
function _authHeaders(): Record<string, string> {
  const token = (typeof localStorage !== "undefined" && localStorage.getItem("gateway.token")) || "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function _serverFetch(url: string, options?: RequestInit): void {
  const p = fetch(url, {
    ...options,
    headers: { ..._authHeaders(), ...options?.headers },
  }).then(() => {}).catch(() => {
    // Fire-and-forget — server down is non-fatal
  });
  _pendingWrites.push(p);
  p.finally(() => {
    const idx = _pendingWrites.indexOf(p);
    if (idx >= 0) _pendingWrites.splice(idx, 1);
  });
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

/**
 * Hydrate the in-memory cache from the server for a given session.
 * Call once on session connect, before reading annotations or submitted state.
 */
export async function initAnnotationStore(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/review/annotations`, {
      headers: _authHeaders(),
    });
    if (!res.ok) {
      // Server doesn't have data yet or session not found — start empty
      _annotationCache.set(sessionId, new Map());
      _submittedCache.set(sessionId, false);
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
    _submittedCache.set(sessionId, !!data.submitted);
    _cacheVersion++;
    // Notify any open review panes so they can refresh annotation counts.
    // This handles the race where a review pane was created (via a concurrent
    // event) before initAnnotationStore finished hydrating the cache.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("annotation-cache-ready", { detail: { sessionId } }));
    }
  } catch {
    // Network error — initialize empty caches for graceful degradation
    _annotationCache.set(sessionId, new Map());
    _submittedCache.set(sessionId, false);
  }
}

// ── Annotation CRUD ──────────────────────────────────────────────────

export function addAnnotation(sessionId: string, docTitle: string, annotation: ReviewAnnotation): void {
  const sessionCache = _ensureSessionCache(sessionId);
  const docAnnotations = [...(sessionCache.get(docTitle) || [])];
  docAnnotations.push(annotation);
  sessionCache.set(docTitle, docAnnotations);

  _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docTitle, annotation }),
  });
}

export function removeAnnotation(sessionId: string, docTitle: string, annotationId: string): void {
  const sessionCache = _annotationCache.get(sessionId);
  if (sessionCache) {
    const filtered = (sessionCache.get(docTitle) || []).filter(a => a.id !== annotationId);
    sessionCache.set(docTitle, filtered);
  }

  _serverFetch(
    `/api/sessions/${sessionId}/review/annotations/${encodeURIComponent(annotationId)}?docTitle=${encodeURIComponent(docTitle)}`,
    { method: "DELETE" },
  );
}

export function getAnnotations(sessionId: string, docTitle: string): ReviewAnnotation[] {
  return _annotationCache.get(sessionId)?.get(docTitle) || [];
}

export function clearAnnotations(sessionId: string, docTitle: string): void {
  _annotationCache.get(sessionId)?.delete(docTitle);

  _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docTitle }),
  });
}

export function clearAllAnnotations(sessionId: string): void {
  _annotationCache.delete(sessionId);

  _serverFetch(`/api/sessions/${sessionId}/review/annotations`, {
    method: "DELETE",
  });
}

// ── Submitted flag ───────────────────────────────────────────────────

/**
 * Mark that the review has been submitted for a session.
 * Prevents review pane from reopening on reconnect/replay.
 */
export function markReviewSubmitted(sessionId: string): void {
  _submittedCache.set(sessionId, true);

  _serverFetch(`/api/sessions/${sessionId}/review/submitted`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submitted: true }),
  });
}

/**
 * Check whether the review was already submitted for a session.
 */
export function isReviewSubmitted(sessionId: string): boolean {
  return _submittedCache.get(sessionId) || false;
}

/**
 * Clear the submitted flag (e.g. when a new review is opened).
 *
 * Only PUTs to the server if the cached value was actually `true` — a
 * redundant PUT(submitted=false) was racing with concurrent PUT(true) calls
 * from external clients (test harness, second browser tab) and clobbering
 * them on reload. Keeping the PUT conditional eliminates the race without
 * losing the across-reconnect persistence the call site relies on. RP-09.
 */
export function clearReviewSubmitted(sessionId: string): void {
  const wasSubmitted = _submittedCache.get(sessionId) === true;
  _submittedCache.set(sessionId, false);
  if (!wasSubmitted) return;

  _serverFetch(`/api/sessions/${sessionId}/review/submitted`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submitted: false }),
  });
}

// ── Aggregate helpers ────────────────────────────────────────────────

/**
 * Count total annotations across all open documents for a session.
 */
export function getTotalAnnotationCount(
  sessionId: string,
  documents: Map<string, { title: string; markdown: string }>,
): number {
  let total = 0;
  const sessionCache = _annotationCache.get(sessionId);
  if (!sessionCache) return 0;
  for (const [title] of documents) {
    total += (sessionCache.get(title) || []).length;
  }
  return total;
}

/**
 * Compose all annotations across all documents into a structured review feedback string.
 */
export function composeReviewFeedback(
  sessionId: string,
  documents: Map<string, { title: string; markdown: string }>,
): string {
  const sections: string[] = [];

  for (const [title, doc] of documents) {
    const annotations = getAnnotations(sessionId, title);
    if (annotations.length === 0) continue;

    const commentWord = annotations.length === 1 ? "comment" : "comments";
    sections.push(`### "${title}" — ${annotations.length} ${commentWord}`);

    for (const ann of annotations) {
      const quotedText = ann.isCode ? `\`${ann.quote}\`` : `"${ann.quote}"`;
      // Compute line number from character offset
      const lineNum = ann.start != null ? doc.markdown.substring(0, ann.start).split("\n").length : undefined;
      const locationParts: string[] = [];
      if (lineNum != null) locationParts.push(`line ${lineNum}`);
      if (ann.start != null) locationParts.push(`offset ${ann.start}-${ann.end}`);
      const location = locationParts.length > 0 ? ` (${locationParts.join(", ")})` : "";
      sections.push(`> ${quotedText}${location}\n${ann.comment}`);
    }
  }

  if (sections.length === 0) return "";

  return `## Review Feedback\n\n${sections.join("\n\n")}`;
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
      navigator.sendBeacon(
        `/api/sessions/${sessionId}/review/annotations/bulk`,
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
      );
    }
  });
}
