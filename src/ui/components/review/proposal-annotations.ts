/**
 * proposal-annotations — ephemeral, in-memory annotation store for
 * inline comments on goal/role/staff proposals.
 *
 * Mirrors the read/write API of `AnnotationStore` but never hits the
 * server. Annotations live in a module-level Map cache keyed by
 * (sessionId, bucket) where bucket is "proposal:<type>". They die with
 * the panel — by design, since the proposal itself (in
 * state.activeProposals[type]) is the durable artifact.
 */

import type { AnnotationBackend, AnnotationKey, ReviewAnnotation } from "./AnnotationStore.js";

// (sessionId → bucket → annotations[])
const _cache = new Map<string, Map<string, ReviewAnnotation[]>>();

function _bucketArr(k: AnnotationKey): ReviewAnnotation[] {
  let s = _cache.get(k.sessionId);
  if (!s) {
    s = new Map();
    _cache.set(k.sessionId, s);
  }
  let b = s.get(k.bucket);
  if (!b) {
    b = [];
    s.set(k.bucket, b);
  }
  return b;
}

export const proposalBackend: AnnotationBackend & {
  clear(k: AnnotationKey): void;
  count(k: AnnotationKey): number;
} = {
  add(k, ann) {
    _bucketArr(k).push(ann);
  },
  remove(k, id) {
    const arr = _bucketArr(k);
    const idx = arr.findIndex((a) => a.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  },
  get(k) {
    return [..._bucketArr(k)];
  },
  clear(k) {
    _cache.get(k.sessionId)?.delete(k.bucket);
  },
  count(k) {
    return _cache.get(k.sessionId)?.get(k.bucket)?.length ?? 0;
  },
};

/** Clear all annotations for a given (sessionId, proposal type). */
export function clearProposalAnnotations(
  sessionId: string,
  type: "goal" | "role" | "staff",
): void {
  proposalBackend.clear({ sessionId, bucket: `proposal:${type}` });
}

/**
 * Compose a markdown chat-message from all annotations in a bucket.
 * Returns an empty string if the bucket has no annotations.
 */
export function composeProposalFeedback(
  sessionId: string,
  bucket: string,
  markdown: string,
): string {
  const anns = proposalBackend.get({ sessionId, bucket });
  if (anns.length === 0) return "";
  const lines: string[] = ["## Feedback on proposal", ""];
  for (const a of anns) {
    const q = a.isCode ? `\`${a.quote}\`` : `"${a.quote}"`;
    const ln =
      a.start != null
        ? ` (line ${markdown.substring(0, a.start).split("\n").length})`
        : "";
    lines.push(`> ${q}${ln}\n${a.comment}`);
  }
  return lines.join("\n\n");
}
