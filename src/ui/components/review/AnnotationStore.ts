/**
 * AnnotationStore — Pure data module for managing review annotations.
 * No Lit dependency. Persists to sessionStorage.
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

function storageKey(sessionId: string, docTitle: string): string {
  return `review-annotations-${sessionId}-${docTitle}`;
}

function load(sessionId: string, docTitle: string): ReviewAnnotation[] {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId, docTitle));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(sessionId: string, docTitle: string, annotations: ReviewAnnotation[]): void {
  try {
    sessionStorage.setItem(storageKey(sessionId, docTitle), JSON.stringify(annotations));
  } catch {
    // sessionStorage full or unavailable — silently fail
  }
}

export function addAnnotation(sessionId: string, docTitle: string, annotation: ReviewAnnotation): void {
  const annotations = load(sessionId, docTitle);
  annotations.push(annotation);
  save(sessionId, docTitle, annotations);
}

export function removeAnnotation(sessionId: string, docTitle: string, annotationId: string): void {
  const annotations = load(sessionId, docTitle).filter(a => a.id !== annotationId);
  save(sessionId, docTitle, annotations);
}

export function getAnnotations(sessionId: string, docTitle: string): ReviewAnnotation[] {
  return load(sessionId, docTitle);
}

export function clearAnnotations(sessionId: string, docTitle: string): void {
  try {
    sessionStorage.removeItem(storageKey(sessionId, docTitle));
  } catch {
    // ignore
  }
}

export function clearAllAnnotations(sessionId: string): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(`review-annotations-${sessionId}-`)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/**
 * Count total annotations across all open documents for a session.
 */
export function getTotalAnnotationCount(
  sessionId: string,
  documents: Map<string, { title: string; markdown: string }>,
): number {
  let total = 0;
  for (const [title] of documents) {
    total += load(sessionId, title).length;
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

  for (const [title, _doc] of documents) {
    const annotations = load(sessionId, title);
    if (annotations.length === 0) continue;

    const commentWord = annotations.length === 1 ? "comment" : "comments";
    sections.push(`### "${title}" — ${annotations.length} ${commentWord}`);

    for (const ann of annotations) {
      const quotedText = ann.isCode ? `\`${ann.quote}\`` : `"${ann.quote}"`;
      sections.push(`> ${quotedText}\n${ann.comment}`);
    }
  }

  if (sections.length === 0) return "";

  return `## Review Feedback\n\n${sections.join("\n\n")}`;
}
