/**
 * ProjectProposalPanel \u2014 sub-section diff helpers for project.yaml proposals.
 *
 * Phase 4b: scope diff to top-level YAML keys so workflow regeneration shows
 * a focused diff (only `workflows:` block changed) rather than a full-file
 * dump. We special-case `workflows:` and `components:` (the structured
 * blocks the project assistant rewrites in bulk) and stream every other
 * top-level key through a flat-string compare.
 *
 * See docs/design/multi-repo-components.md \u00a78.6.
 *
 * The renderer is intentionally framework-free \u2014 it takes raw YAML strings
 * in, produces a plain data structure out (a list of section diffs). The
 * Lit-based rendering inside Bobbit lives in src/app/render.ts. A test
 * fixture exercises this module directly.
 */

import yaml from "yaml";

export type SectionDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface SectionDiff {
	/** Top-level YAML key (e.g. "workflows", "components", "build_command"). */
	key: string;
	/** Whether this section was added, removed, modified, or unchanged. */
	status: SectionDiffStatus;
	/** YAML representation of the old value (empty string if missing). */
	oldYaml: string;
	/** YAML representation of the new value (empty string if missing). */
	newYaml: string;
	/** Pre-rendered unified diff (line-prefixed `-`/`+`/` `). */
	unifiedDiff: string;
}

export interface ProjectProposalDiff {
	sections: SectionDiff[];
	/** Quick lookup: how many top-level keys actually changed. */
	changedCount: number;
}

/**
 * Convert a YAML document (or sub-tree) into a string with stable
 * formatting. Missing values return an empty string so the diff renderer
 * can show "(unset)" gracefully.
 */
function dumpYaml(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return yaml.stringify(value).trimEnd();
	} catch {
		return "";
	}
}

function parseYaml(text: string): Record<string, unknown> {
	if (!text || !text.trim()) return {};
	try {
		const parsed = yaml.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	return {};
}

/** Compute a unified diff (one section). Trivial line-by-line; no LCS. */
function unifiedDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	if (oldText === newText) {
		return oldLines.map(l => ` ${l}`).join("\n");
	}
	const out: string[] = [];
	for (const l of oldLines) out.push(`-${l}`);
	for (const l of newLines) out.push(`+${l}`);
	return out.join("\n");
}

/**
 * Compute a per-key sub-section diff between two project.yaml documents.
 *
 * Top-level keys are partitioned into added / removed / changed /
 * unchanged. The `workflows:` and `components:` keys get the same per-key
 * partitioning treatment as everything else \u2014 if the assistant
 * regenerates only the workflows block, only that section will be marked
 * changed, leaving every flat command key unchanged (and collapsible).
 */
export function diffProjectYaml(oldYaml: string, newYaml: string): ProjectProposalDiff {
	const oldDoc = parseYaml(oldYaml);
	const newDoc = parseYaml(newYaml);

	const allKeys = new Set<string>([
		...Object.keys(oldDoc),
		...Object.keys(newDoc),
	]);

	// Stable order: known structural keys first, then alphabetical.
	const KEY_ORDER = ["name", "rootPath", "worktree_root", "components", "workflows"];
	const sortedKeys = [...allKeys].sort((a, b) => {
		const ai = KEY_ORDER.indexOf(a);
		const bi = KEY_ORDER.indexOf(b);
		if (ai >= 0 && bi >= 0) return ai - bi;
		if (ai >= 0) return -1;
		if (bi >= 0) return 1;
		return a.localeCompare(b);
	});

	const sections: SectionDiff[] = [];
	let changedCount = 0;

	for (const key of sortedKeys) {
		const hasOld = Object.prototype.hasOwnProperty.call(oldDoc, key);
		const hasNew = Object.prototype.hasOwnProperty.call(newDoc, key);
		const oldText = hasOld ? dumpYaml(oldDoc[key]) : "";
		const newText = hasNew ? dumpYaml(newDoc[key]) : "";
		let status: SectionDiffStatus;
		if (!hasOld && hasNew) status = "added";
		else if (hasOld && !hasNew) status = "removed";
		else if (oldText === newText) status = "unchanged";
		else status = "changed";

		if (status !== "unchanged") changedCount += 1;

		sections.push({
			key,
			status,
			oldYaml: oldText,
			newYaml: newText,
			unifiedDiff: unifiedDiff(oldText, newText),
		});
	}

	return { sections, changedCount };
}

export interface RenderProjectProposalDiffOpts {
	focus?: "workflows" | "components" | "all";
}

/**
 * Backwards-compatible string-rendering entry point. Returns a single
 * unified diff. New code should call `diffProjectYaml()` directly.
 */
export function renderProjectProposalDiff(
	oldYaml: string,
	newYaml: string,
	_opts?: RenderProjectProposalDiffOpts,
): string {
	const diff = diffProjectYaml(oldYaml, newYaml);
	const out: string[] = [];
	for (const section of diff.sections) {
		if (section.status === "unchanged") continue;
		out.push(`# ${section.key} (${section.status})`);
		out.push(section.unifiedDiff);
		out.push("");
	}
	return out.join("\n").trimEnd();
}
