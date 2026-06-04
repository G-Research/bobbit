/**
 * Pure merge of slash-skill expansions and `@file` text mentions into a single
 * model-facing string. Extracted from the WS prompt handler so it is unit
 * testable in isolation (handler.ts has a heavy import surface).
 *
 * The `/` and `@` *inline* token sets are disjoint, BUT a PREFIX-only slash
 * skill claims the whole-message range `[0, originalText.length]`
 * (see resolve-skill-expansions.ts), which overlaps any `@file` token in the
 * same message (e.g. `/mockup @notes.txt`). We must NOT splice the overlapping
 * file mention inline (that would corrupt the skill-expanded body), but we also
 * must NOT drop its content — the spec requires every text `@path` to reach the
 * model. So overlapping TEXT mentions are APPENDED (in original-text order) as
 * `<file-reference>` blocks AFTER the spliced body. The skill expansion stays
 * intact and the file content is still delivered. image/binary mentions never
 * touch `modelText` (routed as attachments). The chip still renders at the
 * original `@path` range in the user bubble regardless.
 *
 * Inline replacements are spliced right-to-left to preserve earlier indices.
 */

import { buildFileReferenceBlock, type FileMention } from "./resolve-file-mentions.js";

export interface RangedExpansion {
	range: readonly [number, number];
	expanded: string;
}

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
	return a[0] < b[1] && b[0] < a[1];
}

/**
 * Build the merged model-facing text. `skillExpansions` and `fileMentions`
 * are both expressed as ranges over the SAME `originalText`.
 */
export function buildMergedModelText(
	originalText: string,
	skillExpansions: readonly RangedExpansion[],
	fileMentions: readonly FileMention[],
): string {
	const skillRanges = skillExpansions.map((e) => e.range);
	const replacements: Array<{ start: number; end: number; expanded: string }> = [];
	const appended: string[] = []; // overlapping text mentions, original-text order

	for (const e of skillExpansions) {
		replacements.push({ start: e.range[0], end: e.range[1], expanded: e.expanded });
	}
	for (const m of fileMentions) {
		if (m.kind !== "text" || m.content === undefined) continue;
		const block = buildFileReferenceBlock(m.path, m.content);
		if (skillRanges.some((sr) => overlaps(sr, m.range))) {
			// Overlaps a skill range: cannot splice inline without corrupting the
			// skill body — append the file content after the spliced body instead.
			appended.push(block);
		} else {
			replacements.push({ start: m.range[0], end: m.range[1], expanded: block });
		}
	}

	let out = originalText;
	if (replacements.length > 0) {
		replacements.sort((a, b) => a.start - b.start);
		for (let i = replacements.length - 1; i >= 0; i--) {
			const r = replacements[i];
			out = out.slice(0, r.start) + r.expanded + out.slice(r.end);
		}
	}
	if (appended.length > 0) {
		out += "\n\n" + appended.join("\n\n");
	}
	return out;
}
