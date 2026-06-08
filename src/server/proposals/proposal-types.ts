/**
 * Per-type plugins for proposal-files. Each plugin owns:
 *   - filename on disk
 *   - serialize(fields) — write canonical content from a propose_* args object
 *   - parse(content)    — read content back into a typed projection
 *   - requiredFields    — minimum keys for STRUCTURAL_VALIDATION_FAILED check
 *
 * Goal proposals use markdown + YAML frontmatter; everything else uses
 * native YAML. We intentionally do not depend on `gray-matter` (not in
 * deps) and hand-roll a tiny `---\n…\n---\n` parser.
 *
 * Design doc: docs/design/editable-proposals.md §3, §4.
 */
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
// Note: type-only import to avoid runtime cycle with proposal-files.ts.
import type {
	ParseError,
	ParseResult,
	ProposalType,
	TypedProposal,
} from "./proposal-files.js";

export interface ProposalTypePlugin {
	type: ProposalType;
	filename: string;
	serialize(fields: Record<string, unknown>): string;
	parse(content: string): ParseResult;
	requiredFields: readonly string[];
}

// ── Goal: markdown + YAML frontmatter ──────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Frontmatter keys preserved by the goal proposal's serializer. Anything
 * not listed here is dropped at write time. When extending the propose_goal
 * tool with a new top-level field, add the key here AND validate any
 * nested structure inside `validateGoalInlineFields` below.
 *
 * `inlineWorkflow` and `inlineRoles` are optional snapshots that ride
 * through the proposal pipeline untouched — they get applied to the goal
 * record at acceptance time (POST /api/goals body.workflow + body.inlineRoles).
 */
const GOAL_FRONTMATTER_KEYS = [
	"title",
	"cwd",
	"workflow",          // string workflow id (looked up against the project workflow store)
	"options",
	"inlineWorkflow",    // full Workflow object (snapshotted onto goal.workflow, bypasses store)
	"inlineRoles",       // Record<roleName, Role> (snapshotted onto goal.inlineRoles)
	"parentGoalId",      // optional parent goal id — when set, the created goal becomes a subgoal
	"subgoalsAllowed",   // boolean — allow the team-lead to spawn sub-goals (Sub-goals tab toggle)
	"maxNestingDepth",   // number — per-goal sub-goal nesting cap (clamped to the global ceiling)
	"divergencePolicy",  // "strict"|"balanced"|"autonomous" — root-only plan-change autonomy
	"maxConcurrentChildren", // number [1,8] — root-only concurrent child-team cap
] as const;

/**
 * Structural validation for the two optional inline fields. Returns null
 * when valid (or when the field is absent — both are optional). Returns a
 * STRUCTURAL_VALIDATION_FAILED ParseError when present but malformed.
 */
function validateGoalInlineFields(fields: Record<string, unknown>): ParseError | null {
	const iw = fields.inlineWorkflow;
	if (iw !== undefined && iw !== null) {
		if (!isPlainObject(iw)) {
			return {
				ok: false,
				code: "STRUCTURAL_VALIDATION_FAILED",
				message: "inlineWorkflow must be an object with `id`, `name`, and `gates[]`",
			};
		}
		if (typeof iw.id !== "string" || iw.id.trim() === "") {
			return {
				ok: false,
				code: "STRUCTURAL_VALIDATION_FAILED",
				message: "inlineWorkflow.id must be a non-empty string",
			};
		}
		if (!Array.isArray(iw.gates)) {
			return {
				ok: false,
				code: "STRUCTURAL_VALIDATION_FAILED",
				message: "inlineWorkflow.gates must be an array",
			};
		}
	}
	const ir = fields.inlineRoles;
	if (ir !== undefined && ir !== null) {
		if (!isPlainObject(ir)) {
			return {
				ok: false,
				code: "STRUCTURAL_VALIDATION_FAILED",
				message: "inlineRoles must be a Record<roleName, Role>",
			};
		}
		for (const [roleName, role] of Object.entries(ir)) {
			if (!isPlainObject(role)) {
				return {
					ok: false,
					code: "STRUCTURAL_VALIDATION_FAILED",
					message: `inlineRoles[${roleName}] must be an object`,
				};
			}
			for (const required of ["name", "label", "promptTemplate"] as const) {
				const v = (role as Record<string, unknown>)[required];
				if (typeof v !== "string" || v.trim() === "") {
					return {
						ok: false,
						code: "STRUCTURAL_VALIDATION_FAILED",
						message: `inlineRoles[${roleName}].${required} must be a non-empty string`,
					};
				}
			}
		}
	}

	// Per-goal nesting + orchestration scalars. All optional; validated only
	// when present so an agent can pre-set what a human sets on the Sub-goals
	// tab. Acceptance (POST /api/goals) re-clamps and applies root-only gating.
	const sa = fields.subgoalsAllowed;
	if (sa !== undefined && sa !== null && typeof sa !== "boolean") {
		return { ok: false, code: "STRUCTURAL_VALIDATION_FAILED", message: "subgoalsAllowed must be a boolean" };
	}
	const mnd = fields.maxNestingDepth;
	if (mnd !== undefined && mnd !== null && (typeof mnd !== "number" || !Number.isInteger(mnd) || mnd < 1)) {
		return { ok: false, code: "STRUCTURAL_VALIDATION_FAILED", message: "maxNestingDepth must be an integer >= 1" };
	}
	const dp = fields.divergencePolicy;
	if (dp !== undefined && dp !== null && dp !== "strict" && dp !== "balanced" && dp !== "autonomous") {
		return { ok: false, code: "STRUCTURAL_VALIDATION_FAILED", message: "divergencePolicy must be one of: strict, balanced, autonomous" };
	}
	const mcc = fields.maxConcurrentChildren;
	if (mcc !== undefined && mcc !== null && (typeof mcc !== "number" || !Number.isInteger(mcc) || mcc < 1 || mcc > 8)) {
		return { ok: false, code: "STRUCTURAL_VALIDATION_FAILED", message: "maxConcurrentChildren must be an integer in [1, 8]" };
	}
	return null;
}

const goalPlugin: ProposalTypePlugin = {
	type: "goal",
	filename: "goal.md",
	requiredFields: ["title", "spec"],
	serialize(fields) {
		const fm: Record<string, unknown> = {};
		for (const k of GOAL_FRONTMATTER_KEYS) {
			const v = fields[k];
			if (v === undefined || v === null) continue;
			// Skip empty strings (legacy "" -> drop), empty plain objects
			// (e.g. `inlineRoles: {}` shouldn't write a noisy `inlineRoles: {}`
			// line), and empty arrays. Non-empty objects/arrays/strings ride
			// through as native YAML — no JSON-stringification.
			if (typeof v === "string" && v === "") continue;
			if (Array.isArray(v) && v.length === 0) continue;
			if (isPlainObject(v) && Object.keys(v).length === 0) continue;
			fm[k] = v;
		}
		const fmYaml = Object.keys(fm).length > 0 ? yamlStringify(fm).trimEnd() : "";
		const spec = typeof fields.spec === "string" ? fields.spec : "";
		const body = spec.endsWith("\n") || spec === "" ? spec : spec + "\n";
		return `---\n${fmYaml}${fmYaml ? "\n" : ""}---\n${body}`;
	},
	parse(content) {
		const m = FRONTMATTER_RE.exec(content);
		if (!m) {
			return {
				ok: false,
				code: "FRONTMATTER_MALFORMED",
				message: "goal proposal must begin with YAML frontmatter delimited by --- lines",
			};
		}
		const [, fmText, body] = m;
		let fm: unknown;
		try {
			fm = fmText.trim() === "" ? {} : yamlParse(fmText);
		} catch (err: any) {
			return {
				ok: false,
				code: "FRONTMATTER_MALFORMED",
				message: `frontmatter YAML parse error: ${err?.message ?? String(err)}`,
			};
		}
		if (!isPlainObject(fm)) {
			return {
				ok: false,
				code: "FRONTMATTER_MALFORMED",
				message: "frontmatter must parse to an object",
			};
		}
		const fields: Record<string, unknown> = { ...fm, spec: body };
		if (typeof fields.title !== "string" || fields.title.trim() === "") {
			return {
				ok: false,
				code: "MISSING_REQUIRED_FIELD",
				field: "title",
				message: "goal proposal frontmatter must include a non-empty `title`",
			};
		}
		if (typeof fields.spec !== "string" || fields.spec.trim() === "") {
			return {
				ok: false,
				code: "MISSING_REQUIRED_FIELD",
				field: "spec",
				message: "goal proposal must have a non-empty body (spec)",
			};
		}
		const inlineErr = validateGoalInlineFields(fields);
		if (inlineErr) return inlineErr;
		return { ok: true, value: { type: "goal", fields } };
	},
};

// ── Generic YAML helper for the other 5 types ──────────────────────────

function makeYamlPlugin(opts: {
	type: ProposalType;
	requiredFields: readonly string[];
}): ProposalTypePlugin {
	return {
		type: opts.type,
		filename: `${opts.type}.yaml`,
		requiredFields: opts.requiredFields,
		serialize(fields) {
			// Filter undefined; preserve native types (no JSON-stringification).
			const clean: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(fields)) {
				if (v !== undefined) clean[k] = v;
			}
			return yamlStringify(clean);
		},
		parse(content): ParseResult {
			let parsed: unknown;
			try {
				parsed = yamlParse(content);
			} catch (err: any) {
				const e: ParseError = {
					ok: false,
					code: "YAML_PARSE_ERROR",
					message: `YAML parse error: ${err?.message ?? String(err)}`,
				};
				if (err && typeof err === "object") {
					const pos = (err as any).linePos?.[0];
					if (pos && typeof pos.line === "number") e.line = pos.line;
					if (pos && typeof pos.col === "number") e.col = pos.col;
				}
				return e;
			}
			if (parsed === null || parsed === undefined) {
				return {
					ok: false,
					code: "STRUCTURAL_VALIDATION_FAILED",
					message: `${opts.type} proposal must be a non-empty YAML mapping`,
				};
			}
			if (!isPlainObject(parsed)) {
				return {
					ok: false,
					code: "STRUCTURAL_VALIDATION_FAILED",
					message: `${opts.type} proposal must parse to a YAML mapping (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
				};
			}
			for (const f of opts.requiredFields) {
				const v = (parsed as Record<string, unknown>)[f];
				if (v === undefined || v === null || v === "") {
					return {
						ok: false,
						code: "MISSING_REQUIRED_FIELD",
						field: f,
						message: `${opts.type} proposal missing required field: ${f}`,
					};
				}
			}
			const value: TypedProposal = { type: opts.type, fields: parsed as Record<string, unknown> };
			return { ok: true, value };
		},
	};
}

const projectPlugin = makeYamlPlugin({
	type: "project",
	requiredFields: ["name", "root_path"],
});

const rolePlugin = makeYamlPlugin({
	type: "role",
	requiredFields: ["name", "label", "prompt"],
});

const toolPlugin = makeYamlPlugin({
	type: "tool",
	requiredFields: ["tool", "action", "content"],
});

const staffPlugin = makeYamlPlugin({
	type: "staff",
	requiredFields: ["name", "prompt"],
});

const REGISTRY: Record<ProposalType, ProposalTypePlugin> = {
	goal: goalPlugin,
	project: projectPlugin,
	role: rolePlugin,
	tool: toolPlugin,
	staff: staffPlugin,
};

export function getProposalTypePlugin(type: ProposalType): ProposalTypePlugin {
	const p = REGISTRY[type];
	if (!p) throw new Error(`No proposal-type plugin for ${type}`);
	return p;
}
