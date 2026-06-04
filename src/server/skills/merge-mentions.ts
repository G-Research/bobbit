/**
 * Pure merge of slash-skill expansions and `@file` text mentions into a single
 * model-facing string. Extracted from the WS prompt handler so it is unit
 * testable in isolation (handler.ts has a heavy import surface).
 *
 * The `/` and `@` *inline* token sets are disjoint, BUT a PREFIX-only slash
 * skill claims the whole-message range `[0, originalText.length]`
 * (see resolve-skill-expansions.ts), which overlaps any `@file` token in the
 * same message (e.g. `/mockup @notes.txt`). On overlap the SKILL expansion
 * wins for `modelText` and the file mention is NOT inlined — inlining it too
 * would corrupt the spliced text. The file mention is still recorded by the
 * resolver so its chip renders in the user bubble.
 *
 * All replacements are spliced right-to-left to preserve earlier indices.
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

	for (const e of skillExpansions) {
		replacements.push({ start: e.range[0], end: e.range[1], expanded: e.expanded });
	}
	for (const m of fileMentions) {
		if (m.kind !== "text" || m.content === undefined) continue;
		// Skill expansion wins on overlap — skip inlining this file mention.
		if (skillRanges.some((sr) => overlaps(sr, m.range))) continue;
		replacements.push({
			start: m.range[0],
			end: m.range[1],
			expanded: buildFileReferenceBlock(m.path, m.content),
		});
	}

	if (replacements.length === 0) return originalText;
	replacements.sort((a, b) => a.start - b.start);
	let out = originalText;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		out = out.slice(0, r.start) + r.expanded + out.slice(r.end);
	}
	return out;
}
