/**
 * AnnotationStore — Pure data module for managing review annotations.
 * No Lit dependency. Uses in-memory cache with server-side persistence.
 *
 * Cache-first pattern: all reads are synchronous from cache, all writes
 * update cache immediately and fire-and-forget to server API.
 * On session connect, `initAnnotationStore()` hydrates cache from server.
 */

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

function _serverFetch(url: string, options?: RequestInit): void {
  const p = fetch(url, options).then(() => {}).catch(() => {
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
    const res = await fetch(`/api/sessions/${sessionId}/review/annotations`);
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
 */
export function clearReviewSubmitted(sessionId: string): void {
  _submittedCache.set(sessionId, false);

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

// ── beforeunload: flush cache to server via sendBeacon ───────────────

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    const beaconedSessions = new Set<string>();
    for (const [sessionId, sessionCache] of _annotationCache) {
      if (sessionCache.size === 0 && !_submittedCache.has(sessionId)) continue;
      const annotations: Record<string, ReviewAnnotation[]> = {};
      for (const [docTitle, anns] of sessionCache) {
        annotations[docTitle] = anns;
      }
      const submitted = _submittedCache.get(sessionId) ?? false;
      navigator.sendBeacon(
        `/api/sessions/${sessionId}/review/annotations/bulk`,
        new Blob([JSON.stringify({ annotations, submitted })], { type: "application/json" }),
      );
      beaconedSessions.add(sessionId);
    }
    // Beacon submitted sessions not already covered by _annotationCache
    // (e.g. after clearAllAnnotations removed the session from the cache)
    for (const [sessionId, submitted] of _submittedCache) {
      if (beaconedSessions.has(sessionId) || !submitted) continue;
      navigator.sendBeacon(
        `/api/sessions/${sessionId}/review/annotations/bulk`,
        new Blob([JSON.stringify({ annotations: {}, submitted: true })], { type: "application/json" }),
      );
    }
  });
}
