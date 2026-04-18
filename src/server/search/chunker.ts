/**
 * Token-aware text chunker for semantic search indexing.
 *
 * Splits long text into overlapping chunks so each chunk stays within the
 * embedder's context window. Uniform code path for messages (v1) and files (v2).
 *
 * Design: docs/design/semantic-search.md §6.
 */

export interface ChunkOptions {
  /** Maximum tokens per chunk. Default 2000. */
  maxTokens?: number;
  /** Number of tokens of overlap between consecutive chunks. Default 200. */
  overlap?: number;
  /** Token counter injected by caller (e.g. nomic tokenizer). */
  countTokens: (text: string) => number;
}

export interface Chunk {
  /** Stable deterministic id: `<parentId>:chunk:<n>` (0-indexed). */
  id: string;
  /** Chunk text. */
  text: string;
  /** 0-indexed chunk position within the parent. */
  index: number;
  /** Token count of this chunk, per the injected counter. */
  tokenCount: number;
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_OVERLAP = 200;

/**
 * Split `text` into chunks of at most `maxTokens`, with `overlap` tokens of
 * trailing context carried into the next chunk. Pure, deterministic.
 *
 * Empty / whitespace-only input → `[]`.
 * Text that fits within `maxTokens` → single chunk `<parentId>:chunk:0`.
 *
 * Approach:
 *   - Split on whitespace into words.
 *   - Greedily accumulate words until the cumulative token count would meet
 *     or exceed maxTokens; emit that chunk.
 *   - For the next chunk, back off by ~`overlap`-tokens worth of trailing
 *     words so consecutive chunks overlap.
 */
export function chunkText(
  text: string,
  parentId: string,
  opts: ChunkOptions,
): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const countTokens = opts.countTokens;

  if (maxTokens <= 0) {
    throw new Error("chunkText: maxTokens must be > 0");
  }
  if (overlap < 0 || overlap >= maxTokens) {
    throw new Error("chunkText: overlap must satisfy 0 <= overlap < maxTokens");
  }

  if (!text || text.trim().length === 0) return [];

  // Fast path: whole text fits in one chunk.
  const total = countTokens(text);
  if (total <= maxTokens) {
    return [{ id: `${parentId}:chunk:0`, text, index: 0, tokenCount: total }];
  }

  // Split on whitespace runs; preserve tokens for re-assembly with single spaces.
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  // Per-word token count cache.
  const wordTokens: number[] = words.map((w) => Math.max(1, countTokens(w)));

  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < words.length) {
    // Grow the window until adding the next word would exceed maxTokens.
    let end = start;
    let acc = 0;
    while (end < words.length && acc + wordTokens[end] <= maxTokens) {
      acc += wordTokens[end];
      end++;
    }

    // Pathological case: a single word is larger than maxTokens. Emit it alone
    // to guarantee forward progress.
    if (end === start) {
      end = start + 1;
      acc = wordTokens[start];
    }

    const chunkBody = words.slice(start, end).join(" ");
    chunks.push({
      id: `${parentId}:chunk:${chunkIndex}`,
      text: chunkBody,
      index: chunkIndex,
      tokenCount: acc,
    });
    chunkIndex++;

    if (end >= words.length) break;

    // Back off `overlap`-tokens worth of trailing words for the next chunk's head.
    let backoffTokens = 0;
    let nextStart = end;
    while (nextStart > start + 1 && backoffTokens < overlap) {
      nextStart--;
      backoffTokens += wordTokens[nextStart];
    }
    // Guarantee forward progress even if overlap would stall us.
    if (nextStart <= start) nextStart = start + 1;
    start = nextStart;
  }

  return chunks;
}
