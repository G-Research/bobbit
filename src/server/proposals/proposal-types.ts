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

const goalPlugin: ProposalTypePlugin = {
	type: "goal",
	filename: "goal.md",
	requiredFields: ["title", "spec"],
	serialize(fields) {
		const fm: Record<string, unknown> = {};
		for (const k of ["title", "cwd", "workflow", "options"] as const) {
			if (fields[k] !== undefined && fields[k] !== null && fields[k] !== "") {
				fm[k] = fields[k];
			}
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
