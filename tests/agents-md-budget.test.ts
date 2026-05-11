/**
 * AGENTS.md byte-budget — pinning test.
 *
 * AGENTS.md is loaded into the system prompt of every agent turn (server-side
 * via `resolveSystemPromptPath`, plus often again as project-context). Every
 * byte is paid on every uncached prompt. We deliberately keep this file small
 * and general:
 *
 *   - no specific recipes (those live in docs/<topic>.md)
 *   - no symptom→fix debugging entries (those live in docs/debugging.md)
 *   - no "never reintroduce X" prose pretending to prevent regressions
 *     (tests prevent regressions; prose just hopes the next agent reads it)
 *
 * If a new feature warrants a constraint, write a pinning test for it. Don't
 * grow this file.
 *
 * Budget chosen ≈ 6 KB to give modest headroom over the current trimmed
 * version (~5.8 KB) without inviting drift. If you legitimately need to bust
 * this budget, justify in the PR and bump the constant — but first ask whether
 * the new content belongs in docs/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const AGENTS_MD = path.resolve(import.meta.dirname, "..", "AGENTS.md");
const MAX_BYTES = 6 * 1024;

describe("AGENTS.md byte budget", () => {
	it(`AGENTS.md stays under ${MAX_BYTES} bytes (loaded into every agent turn)`, () => {
		const buf = readFileSync(AGENTS_MD);
		assert.ok(
			buf.byteLength <= MAX_BYTES,
			`AGENTS.md is ${buf.byteLength} bytes; budget is ${MAX_BYTES}. ` +
				`Move detail into docs/<topic>.md and link from AGENTS.md.`,
		);
	});

	it("AGENTS.md does not contain a Recipes or Debugging index section", () => {
		const text = readFileSync(AGENTS_MD, "utf8");
		// These section headings used to host 150+ specific entries that
		// were moved to docs/. If they reappear here, the index has crept back.
		assert.ok(!/^## Recipes\b/m.test(text), "AGENTS.md must not contain a `## Recipes` section — move entries to docs/<topic>.md");
		assert.ok(!/^## Debugging\b/m.test(text), "AGENTS.md must not contain a `## Debugging` section — move entries to docs/debugging.md");
	});
});
