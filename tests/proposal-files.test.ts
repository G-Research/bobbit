/**
 * Unit tests for src/server/proposals/proposal-files.ts.
 *
 * Covers: write/read/parse/edit/delete round-trip per type, atomic-write
 * rollback on parse failure, and path-traversal rejection.
 *
 * Design doc: docs/design/editable-proposals.md §9.1.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	deleteProposalFile,
	editProposalFile,
	listProposalFiles,
	parseProposalFile,
	proposalFilePath,
	readProposalFile,
	writeProposalFile,
	type ProposalType,
} from "../src/server/proposals/proposal-files.ts";

let stateDir: string;
const sid = "sess-abc_123";

before(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-files-test-"));
});

after(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

function sha(p: string): string {
	const buf = fs.readFileSync(p);
	return createHash("sha256").update(buf).digest("hex");
}

describe("proposalFilePath", () => {
	it("places goal as .md and others as .yaml", () => {
		assert.match(proposalFilePath(stateDir, sid, "goal"), /goal\.md$/);
		for (const t of ["project", "workflow", "role", "tool", "staff"] as ProposalType[]) {
			assert.match(proposalFilePath(stateDir, sid, t), new RegExp(`${t}\\.yaml$`));
		}
	});

	it("rejects unsafe sessionId", () => {
		assert.throws(() => proposalFilePath(stateDir, "../etc", "goal"), /Unsafe sessionId/);
		assert.throws(() => proposalFilePath(stateDir, "a/b", "goal"), /Unsafe sessionId/);
		assert.throws(() => proposalFilePath(stateDir, "a.b", "goal"), /Unsafe sessionId/);
	});

	it("rejects unknown type", () => {
		assert.throws(() => proposalFilePath(stateDir, sid, "bogus" as ProposalType), /Unknown proposal type/);
	});
});

describe("goal proposal round-trip", () => {
	it("writes, reads, parses with frontmatter", async () => {
		await writeProposalFile(stateDir, sid, "goal", {
			title: "My Goal",
			cwd: "/home/x/proj",
			workflow: "feature",
			options: "QA testing",
			spec: "Body markdown\n\nMore lines.",
		});
		const raw = await readProposalFile(stateDir, sid, "goal");
		assert.ok(raw && raw.startsWith("---\n"), "must have frontmatter");
		assert.match(raw!, /title: My Goal/);
		assert.match(raw!, /Body markdown/);
		const parsed = await parseProposalFile(stateDir, sid, "goal");
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.value.fields.title, "My Goal");
			assert.equal(parsed.value.fields.workflow, "feature");
			assert.match(String(parsed.value.fields.spec), /Body markdown/);
		}
	});

	it("missing title yields MISSING_REQUIRED_FIELD on parse", async () => {
		// Hand-craft a goal file with empty title
		const fp = proposalFilePath(stateDir, sid, "goal");
		fs.writeFileSync(fp, "---\ntitle: \"\"\n---\nsome body\n");
		const parsed = await parseProposalFile(stateDir, sid, "goal");
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.equal(parsed.code, "MISSING_REQUIRED_FIELD");
	});
});

describe("yaml proposals round-trip", () => {
	const cases: Array<{ type: ProposalType; fields: Record<string, unknown> }> = [
		{ type: "project", fields: { name: "P", root_path: "/tmp/p" } },
		{ type: "workflow", fields: { id: "wf-1", name: "WF", gates: [] } },
		{ type: "role", fields: { name: "r", label: "Role", prompt: "do x" } },
		{ type: "tool", fields: { tool: "t", action: "create", content: "yaml: 1" } },
		{ type: "staff", fields: { name: "s", prompt: "you are…" } },
	];

	for (const c of cases) {
		it(`${c.type} write/read/parse/delete`, async () => {
			await writeProposalFile(stateDir, sid, c.type, c.fields);
			const raw = await readProposalFile(stateDir, sid, c.type);
			assert.ok(raw && raw.length > 0);
			const parsed = await parseProposalFile(stateDir, sid, c.type);
			assert.equal(parsed.ok, true, JSON.stringify(parsed));
			if (parsed.ok) {
				for (const [k, v] of Object.entries(c.fields)) {
					assert.deepEqual(parsed.value.fields[k], v, `field ${k}`);
				}
			}
			await deleteProposalFile(stateDir, sid, c.type);
			const after = await readProposalFile(stateDir, sid, c.type);
			assert.equal(after, undefined);
			// Idempotent
			await deleteProposalFile(stateDir, sid, c.type);
		});
	}
});

describe("editProposalFile semantics", () => {
	const editSid = "sess-edit-1";

	it("FILE_NOT_FOUND when no draft exists", async () => {
		const r = await editProposalFile(stateDir, editSid, "goal", "x", "y");
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal((r as any).code, "FILE_NOT_FOUND");
	});

	it("OLD_TEXT_NOT_FOUND when not present", async () => {
		await writeProposalFile(stateDir, editSid, "project", { name: "P", root_path: "/tmp/x" });
		const r = await editProposalFile(stateDir, editSid, "project", "DOES_NOT_EXIST", "z");
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal((r as any).code, "OLD_TEXT_NOT_FOUND");
	});

	it("OLD_TEXT_NOT_UNIQUE when matches twice", async () => {
		// craft a project yaml with a duplicated substring
		const fp = proposalFilePath(stateDir, editSid, "project");
		fs.writeFileSync(fp, "name: P\nroot_path: /tmp/x\nextra1: dup\nextra2: dup\n");
		const r = await editProposalFile(stateDir, editSid, "project", "dup", "uniq");
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal((r as any).code, "OLD_TEXT_NOT_UNIQUE");
	});

	it("happy path replaces and parses", async () => {
		await writeProposalFile(stateDir, editSid, "project", { name: "Original", root_path: "/tmp/x" });
		const r = await editProposalFile(stateDir, editSid, "project", "Original", "Renamed");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.match(r.newContent, /name: Renamed/);
			assert.equal(r.parsed.fields.name, "Renamed");
		}
	});

	it("malformed edit rolls back on YAML_PARSE_ERROR; on-disk file unchanged", async () => {
		const sidR = "sess-rollback";
		await writeProposalFile(stateDir, sidR, "project", { name: "P", root_path: "/tmp/x" });
		const fp = proposalFilePath(stateDir, sidR, "project");
		const before = sha(fp);
		// Replace a character with something that breaks YAML structure
		// Insert an unclosed YAML flow sequence
		const r = await editProposalFile(stateDir, sidR, "project", "name: P", "name: [unclosed");
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(["YAML_PARSE_ERROR", "STRUCTURAL_VALIDATION_FAILED", "MISSING_REQUIRED_FIELD"].includes((r as any).code));
		}
		const after = sha(fp);
		assert.equal(before, after, "file content must be unchanged on failed edit");
		// .tmp must not linger
		assert.equal(fs.existsSync(fp + ".tmp"), false);
	});

	it("malformed edit rolls back on MISSING_REQUIRED_FIELD", async () => {
		const sidR = "sess-rollback-missing";
		await writeProposalFile(stateDir, sidR, "project", { name: "P", root_path: "/tmp/x" });
		const fp = proposalFilePath(stateDir, sidR, "project");
		const before = sha(fp);
		// Delete the name line entirely
		const r = await editProposalFile(stateDir, sidR, "project", "name: P\n", "");
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal((r as any).code, "MISSING_REQUIRED_FIELD");
		}
		assert.equal(sha(fp), before);
	});
});

describe("listProposalFiles", () => {
	it("returns [] when dir missing", async () => {
		const out = await listProposalFiles(stateDir, "no-such-session");
		assert.deepEqual(out, []);
	});

	it("returns the types written", async () => {
		const sidL = "sess-list";
		await writeProposalFile(stateDir, sidL, "goal", { title: "T", spec: "S body" });
		await writeProposalFile(stateDir, sidL, "role", { name: "n", label: "L", prompt: "P" });
		const out = await listProposalFiles(stateDir, sidL);
		assert.deepEqual(out.sort(), ["goal", "role"]);
	});
});
