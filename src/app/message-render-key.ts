/**
 * Shared stable render-key derivation for transcript rows.
 *
 * Single source of truth for both `MessageList.ts` (the actual `repeat()`
 * key) and `message-reducer.ts`'s `keyFor` export (test-pinned reducer
 * helper) — finding UX-02 (stable row keys; see
 * docs/design/raciness-and-testing-rethink.md §A1 if present in-tree).
 *
 * pi persists user/aborted/errored rows WITHOUT an id
 * (`pi-agent-core/dist/agent.js:259`), and the reducer's snapshot path never
 * invents one (`stamp()` in `message-reducer.ts` only sets `_order`/
 * `_origin`/`_insertionTick`, preserving `id: undefined`). For those rows we
 * must derive a fallback key that stays the same across repeated
 * snapshots/resyncs of the SAME logical row, or Lit's `repeat()` tears down
 * and recreates its DOM every time (focus loss, scroll jumps, flash).
 *
 * `_insertionTick` is exactly the wrong thing to key on: it's a monotonic
 * counter the reducer bumps on every "snapshot" action and stamps across the
 * WHOLE row set in one shot (`message-reducer.ts` snapshot case), so it
 * changes on every resync even when a row's position and content are
 * unchanged. The fallback here is content-derived (role + normalized
 * text/tool-call/tool-result hash + stop reason) plus `_order` (stable
 * position within a given snapshot) — never `_insertionTick`.
 */

/** Flatten a message's content into a plain-text string for keying purposes.
 *  Mirrors the shapes the reducer/renderers see: a raw string, or an array of
 *  content blocks (text / toolCall / toolResult / image). Best-effort — this
 *  only needs to distinguish rows, not render them. */
function normalizeContentForKey(msg: any): string {
	const content = msg?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => {
			if (!block || typeof block !== "object") return "";
			if (typeof block.text === "string") return block.text;
			if (block.type === "toolCall") return `tc:${block.name ?? ""}:${block.id ?? ""}`;
			if (block.type === "toolResult") return `tr:${block.toolCallId ?? ""}`;
			if (block.type === "image") return "img";
			return "";
		})
		.join("");
}

/** Small non-cryptographic string hash (FNV-1a-ish), base36-encoded. Only
 *  needs to be stable and low-collision for keying, not secure. */
function hashForKey(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

/** Build a stable render key for a transcript message — id-based with a
 *  content-derived synthetic fallback for id-less rows. See module doc for
 *  why the fallback must never key on `_insertionTick`. */
export function computeMessageRenderKey(msg: any, group?: string): string {
	const id = typeof msg?.id === "string" && msg.id.length > 0
		? msg.id
		: `synth:${msg?._origin ?? "unknown"}:${msg?._order ?? 0}:${hashForKey(`${msg?.role ?? ""}${normalizeContentForKey(msg)}${msg?.stopReason ?? ""}`)}`;
	return group ? `${group}:${id}` : id;
}
