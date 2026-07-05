import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Vendor-behavior compatibility pin for the two-layer orphan-tool-result guard.
 *
 * WORKAROUND PROTECTED: `src/server/agent/transcript-sanitizer.ts` (restore-boundary
 * repair) + `src/server/agent/openai-orphan-tool-result-extension.ts`
 * (`before_provider_request` preflight guard). Doc: `docs/orphan-tool-result-hardening.md`.
 * Design doc: `docs/design/pi-fork-edit-safety.md` §1 ("Orphan tool-result hardening").
 *
 * WHY THIS EXISTS: pi (`@earendil-works/pi-coding-agent`, `dist/core/session-manager.js`)
 * performs ZERO orphan-tool-result pruning of its own. Its only related bookkeeping is
 * `firstKeptEntryId`, written on `appendCompaction()` as a plain marker of which entry
 * compaction retained -- nothing in pi ever validates, at restore or request-construction
 * time, that a persisted `toolResult` / `function_call_output` still has a matching,
 * non-aborted, non-errored producing tool call. Bobbit's own compaction/abort/error paths
 * can leave such orphans, which OpenAI Responses / Codex reject outright, wedging the
 * session. Bobbit's two-layer guard (sanitizer + provider-request preflight) exists
 * entirely because this vendor gap is real.
 *
 * This pin protects two claims:
 *  1. `firstKeptEntryId` is still produced with the same shape the sanitizer parses
 *     (`entry.type === "compaction"` + `entry.firstKeptEntryId`) -- if pi renames or
 *     restructures this, `transcript-sanitizer.ts`'s compaction-boundary resolution
 *     silently stops working and falls back to a cruder heuristic.
 *  2. pi's session-manager still does no orphan-tool-result validation of its own --
 *     if pi adds real pruning, Bobbit's two hardening layers become at best redundant
 *     and at worst double-filtering; either way that's a signal to revisit, not silently
 *     carry two guards against a gap pi has since closed.
 */

function packageRootFromResolved(specifier: string): string {
	const resolved = fileURLToPath(import.meta.resolve(specifier));
	let dir = path.dirname(resolved);
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not find package root for ${specifier} from ${resolved}`);
}

function installedSessionManagerFile(): string {
	const root = packageRootFromResolved("@earendil-works/pi-coding-agent");
	return path.join(root, "dist", "core", "session-manager.js");
}

// pi's session-manager.js uses "orphan" a few times for plain ENTRY-TREE bookkeeping
// (a label re-chain comment, and getTree() treating an entry with a broken parent
// chain as a root) -- general graph terminology, unrelated to tool-result validation.
// A line is "concerning" only if it pairs "orphan" with tool/call vocabulary, which
// would indicate pi has started validating tool-call/tool-result pairing itself.
const TOOL_CALL_VOCAB = /\b(tool|call)\b/i;

describe("Pi coding-agent orphan-tool-result vendor-behavior pin", () => {
	it("firstKeptEntryId is still bookkeeping-only on the compaction entry shape the sanitizer parses", () => {
		const sessionManagerFile = installedSessionManagerFile();
		assert.ok(
			fs.existsSync(sessionManagerFile),
			`installed pi-coding-agent session-manager.js missing: ${sessionManagerFile} -- if pi restructured ` +
				"its dist layout, re-locate appendCompaction and update this pin; " +
				"src/server/agent/transcript-sanitizer.ts depends on this exact entry shape.",
		);
		const source = fs.readFileSync(sessionManagerFile, "utf-8");

		const sigIndex = source.indexOf(
			"appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook) {",
		);
		assert.ok(
			sigIndex >= 0,
			"pi-coding-agent session-manager.js: appendCompaction() signature changed. " +
				"src/server/agent/transcript-sanitizer.ts (sanitizeTranscriptContent()) reads " +
				"entry.firstKeptEntryId off compaction entries this method produces -- re-verify the " +
				"produced entry shape before trusting compaction-boundary orphan resolution.",
		);

		// The entry object literal is built in the ~400 chars following the signature;
		// bound the scan so a match doesn't accidentally land in an unrelated method.
		const body = source.slice(sigIndex, sigIndex + 400);
		assert.ok(
			body.includes('type: "compaction",'),
			'pi-coding-agent session-manager.js: appendCompaction() no longer tags its entry type: "compaction". ' +
				"transcript-sanitizer.ts matches on entry.type === \"compaction\" to find the resolvable " +
				"firstKeptEntryId boundary -- without this tag it falls back to the legacy marker heuristic " +
				"for every session, silently degrading precision.",
		);
		assert.ok(
			body.includes("firstKeptEntryId,"),
			"pi-coding-agent session-manager.js: appendCompaction() no longer threads firstKeptEntryId onto " +
				"the persisted compaction entry. transcript-sanitizer.ts's exact-boundary orphan resolution " +
				"(as opposed to its legacy marker fallback) depends on this field being present verbatim.",
		);
	});

	it("pi's session-manager still performs no orphan-tool-result validation of its own", () => {
		const sessionManagerFile = installedSessionManagerFile();
		const source = fs.readFileSync(sessionManagerFile, "utf-8");

		const lines = source.split("\n");
		const orphanLines = lines.filter((line) => /orphan/i.test(line));
		const unexpected = orphanLines.filter((line) => TOOL_CALL_VOCAB.test(line));

		assert.deepEqual(
			unexpected,
			[],
			"pi-coding-agent session-manager.js now contains orphan-related code that also mentions " +
				`tool/call vocabulary: ${JSON.stringify(unexpected)}. ` +
				"This may mean pi has added its own orphan-tool-result pruning. Bobbit's two-layer guard " +
				"(src/server/agent/transcript-sanitizer.ts restore-boundary repair + " +
				"src/server/agent/openai-orphan-tool-result-extension.ts before_provider_request preflight, " +
				"see docs/orphan-tool-result-hardening.md) should be re-evaluated for redundancy or conflict " +
				"with the new vendor behavior, not left running unconditionally against a gap pi may have closed.",
		);
	});
});
