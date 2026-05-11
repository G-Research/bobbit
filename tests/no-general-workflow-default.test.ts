/**
 * Pinning test: no source file under src/server/agent/ or src/app/ may
 * reference the literal string "general" (or 'general') as a default workflow
 * id. This regression-pins the "Robust goal workflow UX" goal — workflow
 * resolution must be: explicit id → first workflow in store → error. The
 * literal "general" lives only in seed/test fixtures.
 *
 * The role named "general" is unrelated and explicitly allowlisted below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const SCAN_DIRS = [
	join(ROOT, "src", "server", "agent"),
	join(ROOT, "src", "app"),
];

/** Per-file allowlist for non-workflow uses of the literal "general". */
const FILE_ALLOWLIST = new Set<string>([
	// Doc comment showing an example error-message that mentions a workflow id.
	"src/server/agent/workflow-validator.ts",
]);

/**
 * Lines we know reference the *role* named "general" (not the workflow).
 * Each entry is the exact line text (trimmed) of the allowed occurrence.
 * If a fix legitimately requires touching one of these, update the entry —
 * but make sure the new line still describes the role and not a workflow.
 */
const ROLE_LITERAL_ALLOWLIST = new Set<string>([
	// session-manager.ts — these are all about the "general" role, not workflow id.
	`return this.roleManager.getRole(roleName || (assistantType ? "assistant" : "general"));`,
	`// Use explicit role, or fall back to "general" role (implicit default for all sessions)`,
	`const roleName = session.role || "general";`,
	`// Restore tool activation. Roleless normal sessions still use the general`,
	// session-setup.ts — role name fallback, not workflow id.
	`const roleName = plan.roleName || "general";`,
]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			listSourceFiles(p, out);
		} else if (st.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(name)) {
			out.push(p);
		}
	}
	return out;
}

interface Hit {
	file: string;
	line: number;
	text: string;
}

function findGeneralHits(): Hit[] {
	const hits: Hit[] = [];
	const re = /["']general["']/;
	for (const dir of SCAN_DIRS) {
		for (const file of listSourceFiles(dir)) {
			const text = readFileSync(file, "utf8");
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const ln = lines[i];
				if (!re.test(ln)) continue;
				hits.push({ file: relative(ROOT, file).split(sep).join("/"), line: i + 1, text: ln.trim() });
			}
		}
	}
	return hits;
}

/** Workflow-defaulting offence patterns. A hit is an offender only if it
 *  matches at least one of these — narrows the scan to lines that actually
 *  fall back to the literal "general" workflow id at runtime. */
const OFFENCE_PATTERNS: RegExp[] = [
	/workflowId[^\n]*["']general["']/,
	/["']general["'][^\n]*workflowId/,
	/["']general["']\s*\|\|/,
	/\|\|\s*["']general["']/,
	/workflow[^\n]*["']general["']/i,
	/["']general["'][^\n]*workflow/i,
];

describe("no 'general' as workflow default in source", () => {
	it("no source file under src/server/agent/ or src/app/ defaults to workflow 'general'", () => {
		const hits = findGeneralHits();
		const offenders: Hit[] = [];
		for (const h of hits) {
			// Per-file allowlist (doc examples, etc.).
			if (FILE_ALLOWLIST.has(h.file)) continue;
			// Allowlisted role-related lines.
			if (ROLE_LITERAL_ALLOWLIST.has(h.text)) continue;
			// Comments referring to the absence of the magic default are explicitly fine.
			if (/no "general" magic|\bno "general" workflow magic\b/i.test(h.text)) continue;
			// Settings-tab enumeration: lines listing many quoted tab ids side by side
			// (e.g. `"shortcuts", "general", ..., "workflows", ...`). The match against
			// `/workflow.*general/` is coincidental — they're sibling string literals.
			if (/["']shortcuts["'].*["']general["']/.test(h.text)) continue;
			// Must match at least one workflow-defaulting pattern to count.
			if (!OFFENCE_PATTERNS.some(re => re.test(h.text))) continue;
			offenders.push(h);
		}
		if (offenders.length > 0) {
			const detail = offenders
				.map(o => `  ${o.file}:${o.line}  ${o.text}`)
				.join("\n");
			assert.fail(
				`Found ${offenders.length} unexpected reference(s) to literal "general"/'general' in workflow-defaulting source:\n${detail}\n\n` +
				"Workflow resolution must be: explicit id → first workflow in store → error. " +
				"If your line legitimately refers to the role named 'general', add its exact " +
				"trimmed line text to ROLE_LITERAL_ALLOWLIST in this test.",
			);
		}
	});
});
