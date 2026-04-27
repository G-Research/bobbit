/**
 * Skill activation header (Level-3 progressive disclosure).
 *
 * When a skill is activated — either by user `/<name>` invocation or by the
 * agent calling `activate_skill` — the model gets a small synthetic header
 * prepended to the SKILL.md body that tells it:
 *
 *   1. The absolute path to the skill's root directory (so it can read
 *      referenced files using the relative paths the SKILL.md author wrote).
 *   2. A one-level-deep manifest of `references/`, `scripts/`, `assets/` so
 *      the model knows what's available without recursive directory scans.
 *
 * The header is wrapped in an HTML comment fence so:
 *   - it's markdown-invisible (graceful fallback if a UI strip ever misses);
 *   - it's anchored at `^\s*` for an unambiguous regex strip;
 *   - it's still plain text the model can read.
 *
 * For sandboxed sessions, host paths to non-project skills (built-in /
 * personal) cannot be read inside the container. In that case we emit a
 * "degraded" header that tells the model the skill root is not accessible,
 * with no resource manifest. Project-local skills (under the worktree)
 * still work because the worktree mounts at `/workspace`; the caller passes
 * a `pathRewrite` callback that returns the container-side path for those.
 */

import fs from "node:fs";
import path from "node:path";
import type { SlashSkill } from "./slash-skills.js";

const HEADER_OPEN = "<!-- skill-activation-header -->";
const HEADER_CLOSE = "<!-- /skill-activation-header -->";
const HEADER_MAX_BYTES = 2 * 1024;
const RESOURCE_DIRS = ["references", "scripts", "assets"] as const;

export interface SkillResourceManifest {
	/** Skill root (host or container path, depending on caller). */
	root: string;
	/** Relative resource paths, alphabetical, capped at HEADER_MAX_BYTES. */
	resources: string[];
	/** When true, manifest was truncated; the human-readable suffix is set. */
	truncated: boolean;
	/** Human-readable suffix appended after truncation, e.g. `(12 more files)`. */
	truncationSuffix?: string;
}

/**
 * Scan a skill root for one-level-deep entries inside `references/`,
 * `scripts/`, `assets/`. Returns null if none of those dirs exist (so the
 * caller can decide to omit the resource line). Subdirectories within the
 * three roots are NOT recursed into.
 */
export function buildSkillResourceManifest(skillRoot: string): SkillResourceManifest | null {
	if (!skillRoot || !fs.existsSync(skillRoot)) return null;
	const collected: string[] = [];
	let anyDir = false;
	for (const sub of RESOURCE_DIRS) {
		const dir = path.join(skillRoot, sub);
		let stat: fs.Stats | null = null;
		try { stat = fs.statSync(dir); } catch { /* missing */ }
		if (!stat || !stat.isDirectory()) continue;
		anyDir = true;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			// One-level-deep only: include files; include subdirs as `name/` markers
			// are NOT useful to the model — skip them. Only files at the first level.
			if (!e.isFile()) continue;
			collected.push(`${sub}/${e.name}`);
		}
	}
	if (!anyDir) return null;
	collected.sort((a, b) => a.localeCompare(b));

	// Cap total joined string at HEADER_MAX_BYTES (UTF-8 byte length).
	// Always express paths joined with ", ".
	const SEP = ", ";
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (let i = 0; i < collected.length; i++) {
		const item = collected[i];
		const candidate = (kept.length ? SEP : "") + item;
		const candidateBytes = Buffer.byteLength(candidate, "utf-8");
		if (bytes + candidateBytes > HEADER_MAX_BYTES) {
			truncated = true;
			break;
		}
		bytes += candidateBytes;
		kept.push(item);
	}
	const more = collected.length - kept.length;
	return {
		root: skillRoot,
		resources: kept,
		truncated,
		truncationSuffix: truncated && more > 0 ? `(${more} more files)` : undefined,
	};
}

/**
 * Optional rewrite callback. Receives the host-side absolute path to the
 * skill root and returns:
 *   - the path to use in the header (e.g. `/workspace/.claude/skills/foo`);
 *   - `null` to indicate the skill is not visible inside the sandbox, which
 *     forces a degraded header.
 */
export type PathRewrite = (hostPath: string) => string | null;

/**
 * Build the activation header for a skill. Returns `""` (empty string) when
 * no header should be emitted — i.e. the skill has no on-disk root (legacy
 * `.claude/commands/*.md` files and synthetic built-ins like `compact`).
 *
 * Examples:
 *   <!-- skill-activation-header -->
 *   Skill root: /abs/path/to/skill
 *   Available resources: references/REFERENCE.md, scripts/extract.py
 *   <!-- /skill-activation-header -->
 *
 * Sandboxed (non-rewritable):
 *   <!-- skill-activation-header -->
 *   Skill root: (not visible inside sandbox — see docs/internals.md "Skill activation in sandboxed sessions")
 *   <!-- /skill-activation-header -->
 *
 * The header always ends with a blank line so the SKILL.md body that
 * follows starts on its own line.
 */
export function buildActivationHeader(skill: Pick<SlashSkill, "filePath" | "source">, pathRewrite?: PathRewrite): string {
	// Skip header for legacy `.claude/commands/*.md` (no skill dir — single
	// file, not a directory) and synthetic built-ins (`filePath === "(built-in)"`).
	if (!skill.filePath || skill.filePath === "(built-in)") return "";
	if (skill.source === "legacy") return "";
	// SKILL.md sits inside the skill root directory.
	const fileBase = path.basename(skill.filePath).toLowerCase();
	if (fileBase !== "skill.md") return "";

	const hostRoot = path.dirname(skill.filePath);

	let displayRoot: string;
	let manifest: SkillResourceManifest | null;
	if (pathRewrite) {
		const rewritten = pathRewrite(hostRoot);
		if (rewritten === null) {
			// Degraded header — no resources, root not accessible.
			return [
				HEADER_OPEN,
				`Skill root: (not visible inside sandbox — see docs/internals.md "Skill activation in sandboxed sessions")`,
				HEADER_CLOSE,
				"",
			].join("\n");
		}
		displayRoot = rewritten;
		// Manifest still scans the host (caller is on host); container path
		// only affects the displayed root string.
		manifest = buildSkillResourceManifest(hostRoot);
	} else {
		displayRoot = hostRoot;
		manifest = buildSkillResourceManifest(hostRoot);
	}

	const lines: string[] = [HEADER_OPEN, `Skill root: ${displayRoot}`];
	if (manifest && manifest.resources.length > 0) {
		let line = `Available resources: ${manifest.resources.join(", ")}`;
		if (manifest.truncationSuffix) line += ` ${manifest.truncationSuffix}`;
		lines.push(line);
	}
	lines.push(HEADER_CLOSE, "");
	return lines.join("\n");
}

/** Regex used to strip the activation header at chip render time. Anchored at `^\s*`. */
export const ACTIVATION_HEADER_STRIP_RE =
	/^\s*<!--\s*skill-activation-header\s*-->[\s\S]*?<!--\s*\/skill-activation-header\s*-->\s*/;
