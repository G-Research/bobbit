import { randomUUID } from "node:crypto";
import type { VerifyHandler, VerifyExecCtx, VerifyStepResult } from "./registry.js";
import type { VerifyStep, RubricItem } from "../workflow-store.js";

/**
 * `rubric-review` captures structured judgement against a declared rubric —
 * far better signal than a freeform llm-review prompt or a `metadata:` blob.
 *
 * Two reviewer modes:
 *
 *   reviewer: "llm"   — spawn a reviewer sub-agent. Prompt requires JSON
 *                       output matching the rubric schema. Handler parses,
 *                       evaluates `pass_when`, and produces a markdown
 *                       artifact rendering the rubric alongside the LLM's
 *                       reasoning.
 *
 *   reviewer: "human" — wait for a human to POST rubric values to
 *                       `/api/verify/rubric/:token`. Same callback-token
 *                       discipline as external-job (single-use, time-bounded,
 *                       validates goal/gate/signal triple).
 *
 * `pass_when` is a small expression evaluated against the rubric values. See
 * `evaluatePassWhen` below for the supported grammar — kept deliberately
 * minimal so the verdict is auditable without a sandbox.
 */

const DEFAULT_HUMAN_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 7d — research review can take a while.

interface PendingHuman {
	token: string;
	goalId: string;
	gateId: string;
	signalId: string;
	stepName: string;
	expiresAt: number;
	rubric: RubricItem[];
	passWhen?: string;
	resolve(result: VerifyStepResult): void;
}

const pendingHuman = new Map<string, PendingHuman>();

export interface RubricHumanCallbackBody {
	goalId: string;
	gateId: string;
	signalId: string;
	values: Record<string, string | number>;
	notes?: string;
}

export type RubricCallbackOutcome =
	| { ok: true }
	| { ok: false; status: number; error: string };

export function deliverRubricHumanCallback(token: string, body: RubricHumanCallbackBody): RubricCallbackOutcome {
	const entry = pendingHuman.get(token);
	if (!entry) return { ok: false, status: 404, error: "unknown or already-resolved token" };
	if (Date.now() > entry.expiresAt) {
		pendingHuman.delete(token);
		return { ok: false, status: 410, error: "token expired" };
	}
	if (entry.goalId !== body.goalId || entry.gateId !== body.gateId || entry.signalId !== body.signalId) {
		return { ok: false, status: 403, error: "token does not match goal/gate/signal triple" };
	}
	const validation = validateRubricValues(entry.rubric, body.values);
	if (!validation.ok) {
		return { ok: false, status: 400, error: validation.error };
	}
	pendingHuman.delete(token);
	const passed = entry.passWhen ? evaluatePassWhen(entry.passWhen, body.values) : true;
	entry.resolve({
		passed,
		output: renderRubricOutput(entry.rubric, body.values, body.notes, passed, entry.passWhen),
		artifact: {
			content: renderRubricArtifact(entry.rubric, body.values, body.notes),
			contentType: "text/markdown",
			metadata: rubricValuesAsMetadata(body.values),
		},
	});
	return { ok: true };
}

export function _clearPendingRubricForTests(): void {
	pendingHuman.clear();
}

export const rubricReviewHandler: VerifyHandler = {
	type: "rubric-review",
	async execute(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult> {
		if (!Array.isArray(step.rubric) || step.rubric.length === 0) {
			return { passed: false, output: "rubric-review step has no rubric items." };
		}
		if (step.reviewer === "human") {
			return runHumanRubric(ctx, step);
		}
		if (step.reviewer === "llm") {
			return runLlmRubric(ctx, step);
		}
		return { passed: false, output: `rubric-review step has invalid reviewer '${step.reviewer ?? ""}'.` };
	},
};

async function runHumanRubric(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult> {
	const timeoutSeconds = typeof step.timeout === "number" && step.timeout > 0 ? step.timeout : DEFAULT_HUMAN_TIMEOUT_SECONDS;
	const token = randomUUID();
	const expiresAt = Date.now() + timeoutSeconds * 1000;

	ctx.broadcast({
		type: "gate_verification_rubric_pending",
		goalId: ctx.goalId,
		gateId: ctx.gateId,
		signalId: ctx.signalId,
		stepName: step.name,
		token,
		expiresAt,
		rubric: step.rubric,
	});

	return new Promise<VerifyStepResult>(resolve => {
		const entry: PendingHuman = {
			token,
			goalId: ctx.goalId,
			gateId: ctx.gateId,
			signalId: ctx.signalId,
			stepName: step.name,
			expiresAt,
			rubric: step.rubric!,
			passWhen: step.pass_when,
			resolve,
		};
		pendingHuman.set(token, entry);
		const timer = setTimeout(() => {
			if (pendingHuman.delete(token)) {
				resolve({
					passed: false,
					output: `Rubric review timed out after ${timeoutSeconds}s. No callback was received on POST /api/verify/rubric/${token}.`,
				});
			}
		}, timeoutSeconds * 1000);
		if (typeof timer.unref === "function") timer.unref();
	});
}

async function runLlmRubric(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult> {
	if (!ctx.runLlmReview) {
		return { passed: false, output: "rubric-review/llm requires harness to expose runLlmReview." };
	}
	const rubricSchema = (step.rubric ?? []).map(rubricItemSchemaLine).join("\n");
	const prompt = [
		step.prompt ?? "Review the work against the rubric below.",
		"",
		"## Rubric",
		rubricSchema,
		"",
		step.pass_when ? `## Pass criterion\n\`${step.pass_when}\`\n` : "",
		"## Required output",
		"At the very end of your review, emit a fenced ```json``` block matching this shape:",
		"```json",
		"{",
		"  \"values\": {",
		...(step.rubric ?? []).map(r => `    "${r.id}": <value>,`),
		"  },",
		"  \"notes\": \"<optional freeform commentary>\"",
		"}",
		"```",
		"Numeric scales must be integers within range. Option lists must be one of the listed options. Text items are freeform strings.",
	].filter(Boolean).join("\n");

	const reviewResult = await ctx.runLlmReview({
		prompt,
		role: step.role,
		timeout: step.timeout,
	});

	if (!reviewResult.passed) {
		// Underlying LLM review failed (timeout, transport, etc.). Surface as-is.
		return reviewResult;
	}

	const parsed = extractRubricJson(reviewResult.output);
	if (!parsed.ok) {
		return {
			passed: false,
			output: `LLM did not emit a parseable rubric JSON block: ${parsed.error}`,
			sessionId: reviewResult.sessionId,
		};
	}

	const validation = validateRubricValues(step.rubric!, parsed.values);
	if (!validation.ok) {
		return {
			passed: false,
			output: `LLM emitted invalid rubric values: ${validation.error}`,
			sessionId: reviewResult.sessionId,
		};
	}

	const passed = step.pass_when ? evaluatePassWhen(step.pass_when, parsed.values) : true;
	return {
		passed,
		output: renderRubricOutput(step.rubric!, parsed.values, parsed.notes, passed, step.pass_when),
		sessionId: reviewResult.sessionId,
		artifact: {
			content: renderRubricArtifact(step.rubric!, parsed.values, parsed.notes, reviewResult.output),
			contentType: "text/markdown",
			metadata: rubricValuesAsMetadata(parsed.values),
		},
	};
}

// ── Schema / parsing / validation ────────────────────────────────────────

function rubricItemSchemaLine(item: RubricItem): string {
	if (item.scale) {
		return `- **${item.id}** (${item.label}): integer ${item.scale.min}..${item.scale.max}`;
	}
	if (item.options) {
		return `- **${item.id}** (${item.label}): one of [${item.options.map(o => `"${o}"`).join(", ")}]`;
	}
	if (item.kind === "text") {
		return `- **${item.id}** (${item.label}): freeform string`;
	}
	return `- **${item.id}** (${item.label}): string`;
}

interface ParsedRubric {
	ok: true;
	values: Record<string, string | number>;
	notes?: string;
}
interface ParseFailure {
	ok: false;
	error: string;
}

function extractRubricJson(output: string): ParsedRubric | ParseFailure {
	const fence = /```json\s*([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let lastBlock: string | undefined;
	while ((match = fence.exec(output)) !== null) {
		lastBlock = match[1];
	}
	if (!lastBlock) return { ok: false, error: "no ```json block found in output." };
	try {
		const parsed = JSON.parse(lastBlock) as Record<string, unknown>;
		if (!parsed.values || typeof parsed.values !== "object") {
			return { ok: false, error: "`values` field missing or not an object." };
		}
		const cleaned: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(parsed.values as Record<string, unknown>)) {
			if (typeof v === "string" || typeof v === "number") cleaned[k] = v;
		}
		return {
			ok: true,
			values: cleaned,
			notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
		};
	} catch (e) {
		return { ok: false, error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

function validateRubricValues(rubric: RubricItem[], values: Record<string, string | number>): { ok: true } | { ok: false; error: string } {
	for (const item of rubric) {
		const v = values[item.id];
		if (v === undefined) return { ok: false, error: `missing value for '${item.id}'.` };
		if (item.scale) {
			if (typeof v !== "number" || !Number.isInteger(v) || v < item.scale.min || v > item.scale.max) {
				return { ok: false, error: `'${item.id}' must be an integer in [${item.scale.min}, ${item.scale.max}].` };
			}
		} else if (item.options) {
			if (typeof v !== "string" || !item.options.includes(v)) {
				return { ok: false, error: `'${item.id}' must be one of [${item.options.join(", ")}].` };
			}
		} else if (item.kind === "text") {
			if (typeof v !== "string") return { ok: false, error: `'${item.id}' must be a string.` };
		}
	}
	return { ok: true };
}

/**
 * Minimal expression evaluator for `pass_when`. Supports:
 *   - identifiers (rubric value ids)
 *   - numeric literals
 *   - quoted string literals ("foo" or 'foo')
 *   - comparisons: >= > <= < == != =
 *   - logical: AND OR (case-insensitive); not supported because parens add complexity.
 *
 * No parens, no precedence — splits on top-level AND/OR left-to-right. This is
 * intentional: rubric pass criteria are tiny ("novelty >= 3 AND feasibility != 'low'");
 * anything more elaborate belongs in a real expression library, not here.
 */
export function evaluatePassWhen(expr: string, values: Record<string, string | number>): boolean {
	const norm = expr.replace(/\s+/g, " ").trim();
	const tokens = norm.split(/\b(AND|OR|and|or)\b/);
	if (tokens.length === 1) return evaluateClause(tokens[0]!, values);
	let acc = evaluateClause(tokens[0]!, values);
	for (let i = 1; i < tokens.length; i += 2) {
		const op = tokens[i]!.toUpperCase();
		const next = evaluateClause(tokens[i + 1]!, values);
		acc = op === "AND" ? (acc && next) : (acc || next);
	}
	return acc;
}

function evaluateClause(clause: string, values: Record<string, string | number>): boolean {
	const m = clause.trim().match(/^([A-Za-z_][\w-]*)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/);
	if (!m) return false;
	const [, id, op, rhsRaw] = m;
	const lhs = values[id];
	if (lhs === undefined) return false;
	const rhs = parseLiteral(rhsRaw.trim());
	switch (op) {
		case ">=": return typeof lhs === "number" && typeof rhs === "number" && lhs >= rhs;
		case "<=": return typeof lhs === "number" && typeof rhs === "number" && lhs <= rhs;
		case ">":  return typeof lhs === "number" && typeof rhs === "number" && lhs > rhs;
		case "<":  return typeof lhs === "number" && typeof rhs === "number" && lhs < rhs;
		case "==":
		case "=":  return lhs === rhs;
		case "!=": return lhs !== rhs;
		default: return false;
	}
}

function parseLiteral(s: string): string | number {
	if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
	const q = s.match(/^"([^"]*)"$|^'([^']*)'$/);
	if (q) return q[1] ?? q[2] ?? "";
	return s;
}

function renderRubricOutput(rubric: RubricItem[], values: Record<string, string | number>, notes: string | undefined, passed: boolean, passWhen?: string): string {
	const lines = [
		`${passed ? "Rubric passed" : "Rubric failed"}${passWhen ? ` (pass_when: \`${passWhen}\`)` : ""}.`,
		"",
	];
	for (const item of rubric) {
		lines.push(`- ${item.label}: ${values[item.id]}`);
	}
	if (notes) lines.push("", `Notes: ${notes}`);
	return lines.join("\n");
}

function renderRubricArtifact(rubric: RubricItem[], values: Record<string, string | number>, notes: string | undefined, llmTrace?: string): string {
	const sections = [
		"# Rubric Review",
		"",
		"| Item | Value |",
		"|---|---|",
		...rubric.map(item => `| ${item.label} (\`${item.id}\`) | ${values[item.id]} |`),
	];
	if (notes) sections.push("", "## Notes", notes);
	if (llmTrace) sections.push("", "## LLM Reasoning", llmTrace);
	return sections.join("\n");
}

function rubricValuesAsMetadata(values: Record<string, string | number>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(values)) {
		out[k] = String(v);
	}
	return out;
}
