/**
 * Pure resolver for slash-skill invocations in user prompt text.
 *
 * Reproduces the semantics of the original inline block in `ws/handler.ts`
 * exactly:
 *
 *   1. **Prefix-only** — text matches `/^\/([\w-]+)(?:\s+([\s\S]*))?$/` AND
 *      the named skill exists. The whole text is replaced by
 *      `buildSlashSkillPrompt(skill, args)` (which appends the
 *      "ARGUMENTS: x" footer when no `$ARGUMENTS` placeholder is present).
 *      Range = `[0, originalText.length]`.
 *
 *   2. **Inline scan** — regex `(^|\s)\/([\w-]+)/g`; for each match, only
 *      the `/name` token is replaced (no args appended), via
 *      `buildSlashSkillPrompt(skill, "")`. Splices are applied right-to-left
 *      to preserve indices; expansions are recorded left-to-right.
 *
 * The `expanded` field is **snapshotted at invocation time** so replaying a
 * `.jsonl` later renders the same text the agent originally saw, even if
 * SKILL.md has changed on disk.
 */

import {
	getSlashSkill,
	buildSlashSkillPrompt,
	type SlashSkill,
} from "./slash-skills.js";

/** Char range, in UTF-16 code units (matches `String.prototype.slice`). */
export type SkillRange = [number, number];

export interface SkillExpansion {
	/** Slash skill name (without leading `/`). */
	name: string;
	/** Raw arguments string (everything after `/name<space>` for prefix-only; empty for inline). */
	args: string;
	/** Skill source bucket (project / personal / legacy / built-in / custom). */
	source: SlashSkill["source"];
	/** Absolute path to the SKILL.md / command .md file. */
	filePath: string;
	/** UTF-16 char range in `originalText` that the chip replaces. */
	range: SkillRange;
	/** The expanded markdown — snapshotted at invocation time. */
	expanded: string;
}

export interface ResolvedSkills {
	/** The user's original verbatim text. */
	originalText: string;
	/** Text after splicing in expansions — what the model sees. Equals `originalText` when no expansions. */
	modelText: string;
	/** Recorded expansions, in original-text order. */
	expansions: SkillExpansion[];
	/** Names of `/foo` tokens that did not resolve to a known skill. */
	unknown: string[];
}

type StoreLike = { get(key: string): string | undefined } | undefined;

/**
 * Resolve all slash-skill invocations in `text`. See module doc for the
 * exact semantics. Pure function — no side effects beyond reading skills
 * via the provided store.
 */
export function resolveSkillExpansions(
	text: string,
	cwd: string,
	store?: StoreLike,
): ResolvedSkills {
	const originalText = text;
	const unknown: string[] = [];

	// 1. Prefix-only check: whole text is `/name [args...]`. Uses `.*` (not
	// `[\s\S]*`) so multi-line input (e.g. `/foo\nsee /bar`) does NOT
	// trigger prefix-only — it falls through to the inline scan instead.
	// This matches the legacy handler regex byte-for-byte.
	const prefixMatch = /^\/([\w-]+)(?:\s+(.*))?$/.exec(text);
	if (prefixMatch) {
		const skillName = prefixMatch[1];
		const argsPart = prefixMatch[2] ?? "";
		const skill = getSlashSkill(cwd, skillName, store);
		if (skill) {
			const args = argsPart.trim();
			const expanded = buildSlashSkillPrompt(skill, args);
			return {
				originalText,
				modelText: expanded,
				expansions: [
					{
						name: skill.name,
						args,
						source: skill.source,
						filePath: skill.filePath,
						range: [0, originalText.length],
						expanded,
					},
				],
				unknown: [],
			};
		}
		// Prefix-only with unknown skill: fall through. Inline scan won't
		// match a leading `/` (no leading whitespace), so we still record
		// the unknown name for diagnostics. Match today's behavior:
		// promptText is left as-is and a warning is logged by the caller.
		unknown.push(skillName);
	}

	// 2. Inline scan
	const inlineRe = /(^|\s)\/([\w-]+)/g;
	const expansions: SkillExpansion[] = [];
	const replacements: Array<{ start: number; end: number; expanded: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = inlineRe.exec(text)) !== null) {
		const skillName = m[2];
		const skill = getSlashSkill(cwd, skillName, store);
		if (!skill) {
			if (!unknown.includes(skillName)) unknown.push(skillName);
			continue;
		}
		const prefixLen = m[1].length; // 0 at string start, 1 after whitespace
		const tokenStart = m.index + prefixLen; // position of "/"
		const tokenEnd = tokenStart + 1 + skillName.length;
		const expanded = buildSlashSkillPrompt(skill, "");
		expansions.push({
			name: skill.name,
			args: "",
			source: skill.source,
			filePath: skill.filePath,
			range: [tokenStart, tokenEnd],
			expanded,
		});
		replacements.push({ start: tokenStart, end: tokenEnd, expanded });
	}

	if (expansions.length === 0) {
		return { originalText, modelText: originalText, expansions: [], unknown };
	}

	// Splice right-to-left to preserve earlier indices.
	let modelText = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		modelText = modelText.slice(0, r.start) + r.expanded + modelText.slice(r.end);
	}

	return { originalText, modelText, expansions, unknown };
}
