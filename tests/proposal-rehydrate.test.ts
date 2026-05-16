/**
 * Unit tests for the goal-proposal rehydrate shape contract.
 *
 * Covers the SERVER-side round-trip that backs the
 * `proposal_update {source:"rehydrate"}` event broadcast by
 * `src/server/ws/handler.ts`:
 *
 *   writeProposalFile(goal, fields)
 *     → parseProposalFile(...)
 *     → { fields: { title, cwd, workflow, options, spec } }
 *
 * The companion E2E (`tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`)
 * is `test.fixme`-quarantined for a CLIENT-side rehydrate bug — see
 * `docs/design/proposal-spec-rehydrate.md`. This unit suite proves the
 * server layer is NOT to blame: the spec field survives every shape the
 * goal-proposal frontmatter / body can take, and an empty spec is loudly
 * rejected at parse time rather than silently rehydrated as "".
 *
 * Design doc: docs/design/proposal-spec-rehydrate.md.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	parseProposalFile,
	proposalFilePath,
	readProposalFile,
	writeProposalFile,
} from "../src/server/proposals/proposal-files.ts";

let stateDir: string;

before(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-rehydrate-test-"));
});

after(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("goal proposal rehydrate — spec round-trip", () => {
	it("preserves a multi-line spec body containing markdown features", async () => {
		const sid = "sess-rehydrate-md";
		const spec = [
			"# Goal title",
			"",
			"Paragraph one with **bold** and `inline code`.",
			"",
			"> A blockquote line.",
			"> Continued blockquote.",
			"",
			"```ts",
			"export function f(x: number): number {",
			"  return x + 1;",
			"}",
			"```",
			"",
			"| col a | col b |",
			"|-------|-------|",
			"| 1     | 2     |",
			"",
			"Trailing paragraph.",
		].join("\n");

		await writeProposalFile(stateDir, sid, "goal", {
			title: "Markdown spec round-trip",
			spec,
		});

		const parsed = await parseProposalFile(stateDir, sid, "goal");
		assert.equal(parsed.ok, true, `parse failed: ${JSON.stringify(parsed)}`);
		if (!parsed.ok) return;

		// goalPlugin.serialize normalises a missing trailing newline to a
		// single one but leaves the rest of the body untouched. Account for
		// that one bit of normalisation; everything else must match.
		const expectedBody = spec.endsWith("\n") ? spec : spec + "\n";
		assert.equal(
			parsed.value.fields.spec,
			expectedBody,
			"spec body must round-trip byte-for-byte (modulo trailing newline)",
		);
	});

	it("is idempotent on a body that already ends with a single newline (write→parse→write byte-stable)", async () => {
		const sid = "sess-rehydrate-idempotent";
		const spec = "Body line one.\n\nBody line two.\n";
		const fields = {
			title: "Idempotent",
			cwd: "/tmp/x",
			workflow: "feature",
			options: "QA testing",
			spec,
		};

		await writeProposalFile(stateDir, sid, "goal", fields);
		const fp = proposalFilePath(stateDir, sid, "goal");
		const raw1 = fs.readFileSync(fp, "utf8");

		const parsed = await parseProposalFile(stateDir, sid, "goal");
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;

		// Re-write the parsed fields. The on-disk bytes must be identical.
		await writeProposalFile(stateDir, sid, "goal", {
			title: parsed.value.fields.title,
			cwd: parsed.value.fields.cwd,
			workflow: parsed.value.fields.workflow,
			options: parsed.value.fields.options,
			spec: parsed.value.fields.spec,
		});
		const raw2 = fs.readFileSync(fp, "utf8");
		assert.equal(raw2, raw1, "write→parse→write must be byte-stable");

		// And the canonical-form spec itself must still equal the original
		// (single trailing newline preserved, not doubled).
		assert.equal(parsed.value.fields.spec, spec);
	});

	it("rejects empty / whitespace-only spec with MISSING_REQUIRED_FIELD (no silent rehydrate of spec=\"\")", async () => {
		const sid = "sess-rehydrate-empty";
		const fp = proposalFilePath(stateDir, sid, "goal");
		fs.mkdirSync(path.dirname(fp), { recursive: true });

		// Hand-craft three flavours of empty body — serialize() would refuse
		// to produce any of them via writeProposalFile (it parses before
		// committing), so we write the raw file directly to assert the
		// READ-side guard.
		const flavours = [
			"---\ntitle: T\n---\n",
			"---\ntitle: T\n---\n\n",
			"---\ntitle: T\n---\n   \n\t\n",
		];

		for (const raw of flavours) {
			fs.writeFileSync(fp, raw, "utf8");
			const parsed = await parseProposalFile(stateDir, sid, "goal");
			assert.equal(parsed.ok, false, `expected parse failure for ${JSON.stringify(raw)}`);
			if (parsed.ok) continue;
			assert.equal(parsed.code, "MISSING_REQUIRED_FIELD");
			assert.equal(parsed.field, "spec");
		}
	});

	it("round-trips title + cwd + workflow + options + spec — every field the rehydrate broadcast carries", async () => {
		const sid = "sess-rehydrate-fields";
		const fields = {
			title: "All fields present",
			cwd: "/home/user/project",
			workflow: "feature",
			options: "QA testing, design doc",
			spec: "Spec body with at least one line.\n",
		};

		await writeProposalFile(stateDir, sid, "goal", fields);

		// Sanity: the on-disk file has frontmatter for the four metadata
		// fields and the spec sits below the closing `---`.
		const raw = await readProposalFile(stateDir, sid, "goal");
		assert.ok(raw && raw.startsWith("---\n"));
		assert.match(raw!, /title: All fields present/);
		assert.match(raw!, /cwd: \/home\/user\/project/);
		assert.match(raw!, /workflow: feature/);
		assert.match(raw!, /options: QA testing, design doc/);
		assert.match(raw!, /Spec body with at least one line\./);

		const parsed = await parseProposalFile(stateDir, sid, "goal");
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;

		// Exactly the keys the client-side rehydrate handler expects in
		// `proposal_update.fields`. Each must survive verbatim.
		assert.equal(parsed.value.fields.title, fields.title);
		assert.equal(parsed.value.fields.cwd, fields.cwd);
		assert.equal(parsed.value.fields.workflow, fields.workflow);
		assert.equal(parsed.value.fields.options, fields.options);
		assert.equal(parsed.value.fields.spec, fields.spec);
	});
});
