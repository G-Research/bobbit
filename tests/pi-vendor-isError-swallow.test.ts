import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Vendor-behavior compatibility pin for the tool-result error bridge.
 *
 * WORKAROUND PROTECTED: `src/server/agent/tool-result-error-bridge-extension.ts`
 * (applied at spawn: `session-setup.ts:958`; re-applied on respawn/role-reassignment:
 * `session-manager.ts:2740`). Design doc: `docs/design/pi-fork-edit-safety.md` §1
 * ("Tool-result error bridge").
 *
 * WHY THIS EXISTS: pi's agent loop (`@earendil-works/pi-agent-core`,
 * `dist/agent-loop.js`, `executePreparedToolCall`) sets a tool result's
 * `isError` purely from whether `tool.execute()` THREW, never from the
 * resolved payload's own `isError`/`is_error` flag. A Bobbit tool that
 * resolves normally with `{ isError: true, ... }` (the MCP-style
 * report-a-failure-without-throwing shape) is therefore persisted and
 * broadcast by pi as a SUCCESSFUL tool result. Bobbit's bridge compensates by
 * wrapping tool registration and converting a returned `isError`/`is_error`
 * payload into a thrown error before pi ever sees it resolve.
 *
 * If a pi upgrade changes `executePreparedToolCall` to also inspect the
 * resolved result's own error flag, this pin still passes harmlessly (the
 * anchors below only assert the CURRENT buggy shape is present); if pi
 * upgrades AWAY from that shape (e.g. renames the function, or the resolve
 * path no longer unconditionally forces `isError: false`), this test fails
 * loudly instead of the bridge silently becoming a no-op or, worse, silently
 * double-converting an already-correct result.
 *
 * The bridge's own compensation behavior (wrapping registered handlers,
 * converting `isError`/`is_error` payloads into thrown errors) is pinned
 * separately in `tests/tool-result-error-bridge-extension.test.ts`; this file
 * only pins the vendor half of the contract.
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

function installedAgentLoopFile(): string {
	const root = packageRootFromResolved("@earendil-works/pi-agent-core");
	return path.join(root, "dist", "agent-loop.js");
}

describe("Pi agent-core isError-swallow vendor-behavior pin", () => {
	it("pi's executePreparedToolCall still forces isError:false on any execute() that resolves", () => {
		const agentLoopFile = installedAgentLoopFile();
		assert.ok(
			fs.existsSync(agentLoopFile),
			`installed pi-agent-core agent-loop.js missing: ${agentLoopFile} -- if pi restructured its dist layout, ` +
				"re-locate executePreparedToolCall and update this pin; the tool-result error bridge " +
				"(src/server/agent/tool-result-error-bridge-extension.ts) depends on this exact vendor behavior.",
		);
		const source = fs.readFileSync(agentLoopFile, "utf-8");

		assert.ok(
			source.includes("async function executePreparedToolCall(prepared, signal, emit) {"),
			"pi-agent-core agent-loop.js: executePreparedToolCall signature changed or was removed. " +
				"This is the vendor function whose isError-from-throw-only behavior the tool-result error " +
				"bridge (src/server/agent/tool-result-error-bridge-extension.ts:1-166) is built to compensate " +
				"for. Re-verify the isError-swallowing behavior against the new shape before relying on the bridge.",
		);

		assert.ok(
			source.includes("return { result, isError: false };"),
			"pi-agent-core agent-loop.js no longer unconditionally returns isError:false when tool.execute() " +
				"resolves. This is the exact vendor bug the tool-result error bridge " +
				"(src/server/agent/tool-result-error-bridge-extension.ts:1-166, applied at session-setup.ts:958 " +
				"and session-manager.ts:2740) exists to work around -- if pi fixed this upstream, the bridge " +
				"(and the defensive client-side comment in src/ui/tools/renderers/ActivateSkillRenderer.ts:52-59) " +
				"may now be redundant and should be re-evaluated, not silently left in place.",
		);

		// Contrast case: confirm the catch path still unconditionally marks a THROWN
		// execute() as errored, so the bridge's "convert to a throw" compensation
		// strategy still produces isError:true end-to-end.
		assert.ok(
			source.includes("isError: true,") && source.indexOf("catch (error) {", source.indexOf("executePreparedToolCall")) > -1,
			"pi-agent-core agent-loop.js: expected a catch-path that marks thrown execute() errors as " +
				"isError:true. The tool-result error bridge's compensation strategy (throw instead of resolve) " +
				"only works if pi still honors thrown errors this way.",
		);
	});
});
