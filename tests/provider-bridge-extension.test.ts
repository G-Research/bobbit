/**
 * Unit tests for the provider-bridge extension codegen (Extension Platform G1.4).
 *
 * Covers:
 *   1. Codegen string shape — delimiters, gateway URL/token reads with
 *      state-file fallback, AbortController + 2500/5000 timeout paths,
 *      `before_agent_start` + `session_before_compact` subscriptions, and the
 *      systemPrompt-only mutation (never event.prompt).
 *   2. Parse-validity + round-trip import of the generated source.
 *   3. `stripDelimitedTail` idempotency (no dynamic-context growth turn-over-turn).
 *   4. The no-provider helper: bridge is only warranted when an enabled provider
 *      declares `beforePrompt` or `beforeCompact`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import {
	DYNAMIC_CONTEXT_START,
	DYNAMIC_CONTEXT_END,
	stripDelimitedTail,
	providersDeclareTurnHooks,
	generateProviderBridgeExtension,
} from "../src/server/agent/provider-bridge-extension.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbx-"));

after(() => {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("generateProviderBridgeExtension", () => {
	const source = generateProviderBridgeExtension("sess-123");

	it("contains both dynamic-context delimiters", () => {
		assert.ok(source.includes(DYNAMIC_CONTEXT_START), "expected start delimiter");
		assert.ok(source.includes(DYNAMIC_CONTEXT_END), "expected end delimiter");
	});

	it("reads gateway URL/token from env with state-file fallback", () => {
		assert.ok(source.includes("BOBBIT_GATEWAY_URL"), "expected BOBBIT_GATEWAY_URL env read");
		assert.ok(source.includes("BOBBIT_TOKEN"), "expected BOBBIT_TOKEN env read");
		assert.ok(source.includes("BOBBIT_DIR"), "expected BOBBIT_DIR fallback base");
		assert.ok(source.includes('"gateway-url"'), "expected gateway-url state file fallback");
		assert.ok(source.includes('"token"'), "expected token state file fallback");
	});

	it("uses AbortController with 2500ms and 5000ms timeouts", () => {
		assert.ok(source.includes("AbortController"), "expected AbortController");
		assert.ok(source.includes("2500"), "expected before-prompt 2500ms timeout");
		assert.ok(source.includes("5000"), "expected before-compact 5000ms timeout");
	});

	it("does NOT downgrade TLS verification process-wide", () => {
		// Security: the bridge must never disable TLS for all agent outbound
		// HTTPS — that defeats the inherited NODE_EXTRA_CA_CERTS pinning path.
		assert.ok(
			!source.includes("NODE_TLS_REJECT_UNAUTHORIZED"),
			"generated source must not touch NODE_TLS_REJECT_UNAUTHORIZED",
		);
		assert.ok(
			!/process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=/.test(source),
			"generated source must not assign a process-wide TLS downgrade",
		);
	});

	it("subscribes before_agent_start and session_before_compact", () => {
		assert.ok(source.includes('pi.on("before_agent_start"'), "expected before_agent_start subscription");
		assert.ok(source.includes('pi.on("session_before_compact"'), "expected session_before_compact subscription");
	});

	it("posts to the per-turn provider-hook routes", () => {
		assert.ok(source.includes("/provider-hooks/before-prompt"), "expected before-prompt route");
		assert.ok(source.includes("/provider-hooks/before-compact"), "expected before-compact route");
	});

	it("mutates only systemPrompt and forwards prompt read-only", () => {
		// The non-negotiable invariant: the user's message text is never rewritten.
		assert.ok(source.includes("systemPrompt:"), "expected to return a systemPrompt field");
		assert.ok(source.includes("event.prompt"), "expected event.prompt forwarded as read-only input");
		assert.ok(!/return\s*\{\s*prompt:/.test(source), "must NOT return a mutated prompt");
	});

	it("embeds the session id", () => {
		assert.ok(source.includes('"sess-123"'), "expected the session id baked into the source");
	});

	it("emits no TypeScript error diagnostics", () => {
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
			reportDiagnostics: true,
		});
		const errors = (transpiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
		const msg = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
		assert.equal(errors.length, 0, `Expected no error diagnostics, got:\n${msg}`);
	});

	it("transpiled module loads and default-exports a function", async () => {
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
		});
		const file = path.join(tmpDir, "provider-bridge.cjs");
		fs.writeFileSync(file, transpiled.outputText, "utf-8");
		const mod = await import(pathToFileURL(file).href);
		assert.equal(typeof mod.default, "function");
	});
});

describe("stripDelimitedTail", () => {
	const tail = `\n${DYNAMIC_CONTEXT_START}\nDEMO_BEFORE_PROMPT hi\n${DYNAMIC_CONTEXT_END}`;

	it("returns input unchanged when no region present", () => {
		assert.equal(stripDelimitedTail("SYSTEM PROMPT"), "SYSTEM PROMPT");
	});

	it("is idempotent: strip+append twice yields exactly one region", () => {
		const base = "SYSTEM PROMPT";
		const once = stripDelimitedTail(base) + tail;
		const twice = stripDelimitedTail(once) + tail;
		assert.equal(once, twice, "second turn must not grow the region");

		const count = (s: string) => s.split(DYNAMIC_CONTEXT_START).length - 1;
		assert.equal(count(twice), 1, "exactly one start delimiter after two applications");
		assert.equal(twice.split(DYNAMIC_CONTEXT_END).length - 1, 1, "exactly one end delimiter");
	});

	it("strips a dangling region missing its end delimiter", () => {
		const dangling = `SYSTEM PROMPT\n${DYNAMIC_CONTEXT_START}\nhalf open`;
		assert.equal(stripDelimitedTail(dangling), "SYSTEM PROMPT");
	});

	it("preserves content after the region", () => {
		const sp = `HEAD${tail}\nTAIL-AFTER`;
		assert.equal(stripDelimitedTail(sp), "HEAD\nTAIL-AFTER");
	});
});

describe("providersDeclareTurnHooks", () => {
	const mk = (hooks: string[]): Pick<ProviderContribution, "hooks"> => ({ hooks });

	it("false for empty provider list", () => {
		assert.equal(providersDeclareTurnHooks([]), false);
	});

	it("false when no provider declares a per-turn hook", () => {
		assert.equal(
			providersDeclareTurnHooks([mk(["sessionSetup"]), mk(["afterTurn", "sessionShutdown"])]),
			false,
		);
	});

	it("true when a provider declares beforePrompt", () => {
		assert.equal(providersDeclareTurnHooks([mk(["sessionSetup"]), mk(["beforePrompt"])]), true);
	});

	it("true when a provider declares beforeCompact", () => {
		assert.equal(providersDeclareTurnHooks([mk(["beforeCompact"])]), true);
	});
});
