/**
 * Re-registers pi-coding-agent's file-tool builtins (read/edit/write/grep/find/ls)
 * as extension tools.
 *
 * Background: pi 0.70 changed `--tools <list>` from "filter only builtins" to
 * "unified allowlist applied to builtins AND extension-registered tools". That
 * broke bobbit's previous spawn pattern of `--tools read,edit,write,grep,find,ls`
 * + `--extension shell/extension.ts` (which registers bash/bash_bg) — every
 * extension-registered tool got stripped because it wasn't in the `--tools`
 * list. See docs/debugging.md.
 *
 * Bobbit now passes `--no-builtin-tools` (disables pi's internal builtins) and
 * loads this extension to bring back the desired file builtins as extension
 * tools, which auto-activate via the agent session's `includeAllExtensionTools`
 * pass at construction time.
 *
 * Env: BOBBIT_BUILTIN_TOOLS — comma-separated list of names to register.
 *   - unset           → all six (read,edit,write,grep,find,ls)
 *   - empty string    → none
 *   - "read,grep"     → just those two
 *
 * Names not in the FACTORIES map below are silently skipped. Anything bash-shaped
 * is intentionally absent — bash is provided by shell/extension.ts.
 */
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapReadToolWithDedup } from "./read-dedup.js";
import { wrapReadToolWithSpill } from "./read-spill.js";
import type { ReadToolDefinitionLike } from "./read-tool-shared.js";

const FACTORIES: Record<string, (cwd: string) => unknown> = {
	// Wrapped (innermost first) with:
	//  1. read-spill (F1(a)): a plain oversized read that hits pi's own
	//     truncation cap gets spilled to disk + replaced with a head+tail
	//     excerpt + path, instead of a head-only truncation.
	//  2. read-dedup (F24): an exact repeat read (same path/offset/limit) of
	//     an unchanged file returns a short stub instead of full content --
	//     this also covers repeat reads of the (now much smaller) spilled
	//     excerpt above, so re-reading a huge unchanged file twice doesn't
	//     re-spill to disk each time.
	read: (cwd: string) =>
		wrapReadToolWithDedup(wrapReadToolWithSpill(createReadToolDefinition(cwd) as unknown as ReadToolDefinitionLike, cwd), cwd),
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

const ALL_NAMES = Object.keys(FACTORIES);

function resolveNames(): string[] {
	const raw = process.env.BOBBIT_BUILTIN_TOOLS;
	if (raw === undefined) return ALL_NAMES;
	if (raw === "") return [];
	return raw.split(",").map(s => s.trim()).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	for (const name of resolveNames()) {
		const factory = FACTORIES[name];
		if (!factory) continue;
		pi.registerTool(factory(cwd) as Parameters<typeof pi.registerTool>[0]);
	}
}
