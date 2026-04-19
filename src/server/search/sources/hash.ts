/**
 * Shared helper for computing a stable `contentHash` on an `Indexable`.
 *
 * Per design §8 (Incremental upsert flow):
 *   contentHash = sha256(text + weight + role + timestamp)
 *
 * Kept in its own module so every source emits hashes under the exact
 * same recipe — which is load-bearing: the indexer uses this hash to
 * skip re-embedding unchanged rows.
 */

import { createHash } from "node:crypto";
import type { Role } from "../types.js";

export function contentHashOf(
	text: string,
	weight: number,
	role: Role | undefined,
	timestamp: number,
): string {
	const h = createHash("sha256");
	h.update(text);
	h.update("\u0000");
	h.update(String(weight));
	h.update("\u0000");
	h.update(role ?? "");
	h.update("\u0000");
	h.update(String(timestamp));
	return h.digest("hex");
}
