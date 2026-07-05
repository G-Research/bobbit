#!/usr/bin/env node
// scripts/clf-evidence-report.mjs
//
// D6 — offline evidence-tooling consumer for the Classifier Framework lane's
// observe-only telemetry producers. See docs/design/classifier-framework-
// status.md's "Evidence tooling" ledger entry (added alongside this script):
// Wave 4 (model-tier) and Wave 5 (gate-risk)'s own status entries note "this
// wave builds no consumer for [the eventual decision] question — it only
// makes the label exist and accumulate." This script is that consumer, run
// OFFLINE against accumulated JSONL/JSON telemetry — it never runs inside the
// gateway process and never mutates anything it reads.
//
// Three data sources (read the producers, not this file, for the on-disk
// shape contract — this script treats their exported types as the source of
// truth and degrades gracefully if a shape changes underneath it):
//   1. tool-permission-audit-log.ts  — <stateDir>/tool-permission-audit/*.jsonl
//   2. context-trace-store.ts        — <stateDir>/session-context-trace/*.jsonl
//   3. cost-tracker.ts               — <stateDir>/session-cost-turns.json
//
// PRIVACY: this script never reads or prints prompt text, file contents, or
// diff content — only ids, hashes, counts, and symbolic labels, mirroring the
// classifiers' own identity/shape-only discipline. Nothing it reads carries
// prompt text in the first place (see the "thinking-router" section below for
// why that makes "prompt hashes" impossible, not just undesirable).
//
// Usage:
//   node scripts/clf-evidence-report.mjs [stateDir] [--cost-state-dir=<dir>]
//
// Default `stateDir` mirrors `bobbitStateDir()`'s resolution
// (src/server/bobbit-dir.ts) WITHOUT importing src/dist — this script has
// zero repo-internal module dependencies by design, so it never needs a build
// step to run, and can be pointed at any exported/copied state dir too:
//   BOBBIT_DIR / BOBBIT_PI_DIR env override, else
//   <repoRoot>/.bobbit/headquarters/state.
//
// KNOWN GAP (not a bug in this script, a property of the producers): both
// ToolPermissionAuditLog and ContextTraceStore are constructed with
// `bobbitStateDir()` regardless of which project is registered, but
// CostTracker uses a PER-PROJECT state dir (`<projectRoot>/.bobbit/state`)
// for any non-headquarters project (see project-context.ts). If your cost
// telemetry lives in a different directory than the audit/trace telemetry,
// pass `--cost-state-dir=<dir>` explicitly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure parsing helpers (unit-tested against synthetic fixtures — see
// tests/clf-evidence-report.test.ts). Nothing in this section touches fs.
// ---------------------------------------------------------------------------

/**
 * Parse newline-delimited JSON, skipping blank lines and corrupt partial
 * lines — mirrors ToolPermissionAuditLog.read()'s / ContextTraceStore
 * .readTrace()'s own "skip corrupt partial lines rather than failing reads"
 * discipline, so a torn last line (e.g. a crash mid-append) never crashes
 * this report.
 */
export function parseJsonl(raw) {
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip corrupt partial line
		}
	}
	return out;
}

/** True/false agreement rule for one tool-approve audit row: does the
 *  heuristic's `select`ed verdict match the actual human/system decision?
 *  Only meaningful for rows whose `toolApproveDecision.kind === "select"` —
 *  callers must filter first. */
function toolApproveAgrees(choice, decision) {
	return (choice === "allow" && decision === "granted") || (choice === "deny" && decision === "denied");
}

/**
 * Section (a) — tool-approve confusion matrix + disagreement list.
 *
 * `entries` is the flattened array of `ToolPermissionAuditEntry` rows
 * (tool-permission-audit-log.ts). Every row always has a real
 * `decision`/`source` (the actual human/system outcome); `toolApproveDecision`
 * is only present from CLF-W2 onward and is `{kind:"abstain"}` whenever no
 * classifier is registered for `(tool-call, tool-approve)` — which is the
 * production default today (Wave 2 ships the harness "dark", see
 * tool-approve-classifier.ts's header), so a real state dir may show zero
 * `select` verdicts even with many audit rows. That is the CORRECT signal,
 * not a bug in this report.
 */
export function aggregateToolApprove(entries, opts = {}) {
	const disagreementLimit = opts.disagreementLimit ?? 50;
	const result = {
		totalAsks: entries.length,
		bySource: { user: 0, auto: 0, timeout: 0 },
		byDecision: { granted: 0, denied: 0 },
		verdictCoverage: { select: 0, abstain: 0, none: 0 },
		confusion: { allowGranted: 0, allowDenied: 0, denyGranted: 0, denyDenied: 0 },
		disagreements: [],
		disagreementCount: 0,
	};
	for (const e of entries) {
		if (e.source === "user" || e.source === "auto" || e.source === "timeout") result.bySource[e.source]++;
		if (e.decision === "granted" || e.decision === "denied") result.byDecision[e.decision]++;

		const verdict = e.toolApproveDecision;
		if (!verdict) {
			result.verdictCoverage.none++;
			continue;
		}
		if (verdict.kind === "abstain") {
			result.verdictCoverage.abstain++;
			continue;
		}
		if (verdict.kind !== "select") continue; // malformed — ignore defensively
		result.verdictCoverage.select++;

		const choice = verdict.choice;
		const decision = e.decision;
		if (choice === "allow" && decision === "granted") result.confusion.allowGranted++;
		else if (choice === "allow" && decision === "denied") result.confusion.allowDenied++;
		else if (choice === "deny" && decision === "granted") result.confusion.denyGranted++;
		else if (choice === "deny" && decision === "denied") result.confusion.denyDenied++;

		if (!toolApproveAgrees(choice, decision)) {
			result.disagreementCount++;
			if (result.disagreements.length < disagreementLimit) {
				result.disagreements.push({
					ts: e.ts,
					sessionId: e.sessionId,
					toolName: e.toolName,
					toolGroup: e.toolGroup,
					heuristicChoice: choice,
					actualDecision: decision,
					source: e.source,
					rationale: verdict.rationale,
				});
			}
		}
	}
	return result;
}

/**
 * Flatten every `DecisionOutcome` recorded across a set of `TraceEntry` rows
 * (context-trace-store.ts), optionally filtered to one `(point, decisionKind)`
 * pair. `TraceEntry.decisions` is optional/additive (pre-CLF-W1a rows omit
 * it) — absence is treated as an empty array, same as the store's own
 * backward-compat-read contract.
 */
export function flattenDecisions(traceEntries, point, decisionKind) {
	const out = [];
	for (const entry of traceEntries) {
		const sessionId = entry.sessionId;
		for (const outcome of entry.decisions ?? []) {
			if (point !== undefined && outcome.point !== point) continue;
			if (decisionKind !== undefined && outcome.decisionKind !== decisionKind) continue;
			out.push({ ...outcome, sessionId });
		}
	}
	return out;
}

/**
 * Section (b) — thinking-router select/applied rates + a would-be
 * false-positive candidate list.
 *
 * "False-positive candidates" would ideally be selects whose prompt ALSO
 * matches a cheap meta-discussion heuristic (e.g. the user is talking ABOUT
 * `ultrathink` rather than invoking it) — but `DecisionOutcome` never carries
 * the prompt text (see `decision-types.ts`'s `DecisionOutcome` — only
 * `decision`/`consulted`/`ms`/`applied`), so there is no prompt content, and
 * therefore no prompt HASH either, to compute that against. This is a
 * privacy property of the upstream producer, not a gap in this script: it
 * makes cheap-detection impossible by construction (nothing to leak). This
 * function instead reports the matched RULE id (from the decision's
 * `rationale` string, e.g. "matched deterministic rule 'ultrathink'") per
 * select, which is enough to see whether one rule dominates selects without
 * ever touching prompt content.
 */
export function aggregateThinkingRouter(decisions, opts = {}) {
	const selectListLimit = opts.selectListLimit ?? 50;
	const result = {
		totalConsults: decisions.length,
		selects: 0,
		abstains: 0,
		appliedTrue: 0,
		appliedFalse: 0,
		appliedUnknown: 0,
		byRule: {},
		selectList: [],
	};
	for (const d of decisions) {
		if (d.decision?.kind === "select") {
			result.selects++;
			const rule = extractRuleId(d.decision.rationale) ?? "(unknown rule)";
			result.byRule[rule] = (result.byRule[rule] ?? 0) + 1;
			if (d.applied === true) result.appliedTrue++;
			else if (d.applied === false) result.appliedFalse++;
			else result.appliedUnknown++;
			if (result.selectList.length < selectListLimit) {
				result.selectList.push({
					ts: d.ts,
					sessionId: d.sessionId,
					rule,
					level: d.decision.choice,
					applied: d.applied,
				});
			}
		} else if (d.decision?.kind === "abstain") {
			result.abstains++;
		}
	}
	return result;
}

/** Extract the quoted rule id out of a `"matched deterministic rule 'xyz'"`
 *  rationale string (thinking-router-classifier.ts's own format). Returns
 *  `undefined` for any other/missing rationale shape rather than guessing. */
function extractRuleId(rationale) {
	if (typeof rationale !== "string") return undefined;
	const m = rationale.match(/matched deterministic rule '([^']+)'/);
	return m ? m[1] : undefined;
}

/**
 * Section (c) — generic proposed-label distribution for a single-choice
 * `(point, decisionKind)` classifier (model-tier, gate-risk). Note:
 * `DecisionOutcome` does not carry the classifier's input `arg` (only its
 * output `decision`), so a role/gate BREAKDOWN of the label distribution is
 * not derivable from this data source at all — see this file's header and
 * the model-tier/gate-risk classifier files' `Arg` types
 * (`ModelTierArg.roleName`, `GateRiskArg.changedFiles`) for where that
 * identity lives today (in the consult call, never persisted to the trace).
 * This function reports the AGGREGATE label distribution only; the report's
 * "by role/gate" framing is downgraded to an explicit limitation note.
 */
export function aggregateLabelDistribution(decisions) {
	const result = { total: decisions.length, selects: 0, abstains: 0, byLabel: {}, appliedTrue: 0, appliedFalse: 0, appliedUnknown: 0 };
	for (const d of decisions) {
		if (d.decision?.kind === "select") {
			result.selects++;
			const label = String(d.decision.choice);
			result.byLabel[label] = (result.byLabel[label] ?? 0) + 1;
			if (d.applied === true) result.appliedTrue++;
			else if (d.applied === false) result.appliedFalse++;
			else result.appliedUnknown++;
		} else if (d.decision?.kind === "abstain") {
			result.abstains++;
		}
	}
	return result;
}

/**
 * Section (d) — flatten `session-cost-turns.json`'s `{sessionId: RawTurnCost[]}`
 * shape into a single array, each row annotated with its sessionId (already
 * present on `RawTurnCost`, so this is really just a validating flatten).
 */
export function flattenCostTurns(costTurnsData) {
	const out = [];
	if (!costTurnsData || typeof costTurnsData !== "object" || Array.isArray(costTurnsData)) return out;
	for (const [sessionId, rows] of Object.entries(costTurnsData)) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			if (typeof row.totalCost !== "number") continue;
			out.push({
				sessionId: row.sessionId ?? sessionId,
				seq: row.seq,
				ts: row.ts,
				totalCost: row.totalCost,
				trigger: row.trigger,
			});
		}
	}
	return out;
}

/**
 * Per-session IQR-based spike-outlier detection over `totalCost`. A session
 * needs at least `minRows` turns before outlier detection is meaningful (a
 * 2-turn session has no useful spread); sessions below that are skipped
 * entirely rather than flagging everything or nothing arbitrarily.
 * Outlier threshold: `Q3 + 1.5 * IQR` (standard Tukey fence) — deterministic,
 * no magic per-repo tuning constant to keep in sync elsewhere.
 */
export function computeCostOutliers(turns, opts = {}) {
	const minRows = opts.minRows ?? 5;
	const limit = opts.limit ?? 50;
	const bySession = new Map();
	for (const t of turns) {
		if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
		bySession.get(t.sessionId).push(t);
	}
	const outliers = [];
	let sessionsConsidered = 0;
	for (const [sessionId, rows] of bySession) {
		if (rows.length < minRows) continue;
		sessionsConsidered++;
		const sorted = [...rows].map((r) => r.totalCost).sort((a, b) => a - b);
		const q1 = quantile(sorted, 0.25);
		const q3 = quantile(sorted, 0.75);
		const iqr = q3 - q1;
		const fence = q3 + 1.5 * iqr;
		if (fence <= 0) continue; // degenerate (e.g. all-zero costs) — nothing to flag
		for (const r of rows) {
			if (r.totalCost > fence) {
				outliers.push({ sessionId, seq: r.seq, ts: r.ts, totalCost: r.totalCost, sessionFence: fence, trigger: r.trigger });
			}
		}
	}
	outliers.sort((a, b) => b.totalCost - a.totalCost);
	return { outliers: outliers.slice(0, limit), outlierCount: outliers.length, sessionsConsidered };
}

function quantile(sortedNums, q) {
	if (sortedNums.length === 0) return 0;
	const pos = (sortedNums.length - 1) * q;
	const base = Math.floor(pos);
	const rest = pos - base;
	if (sortedNums[base + 1] !== undefined) {
		return sortedNums[base] + rest * (sortedNums[base + 1] - sortedNums[base]);
	}
	return sortedNums[base];
}

/**
 * Compaction-tagged cost share: what fraction of recorded turn-cost rows
 * carry a `trigger` starting with `compaction:` (see session-manager.ts's
 * `costTriggerFromEvent` — `compaction:auto` | `compaction:manual`), broken
 * down by the exact trigger tag.
 */
export function computeCompactionShare(turns) {
	const byTrigger = {};
	let compactionTagged = 0;
	for (const t of turns) {
		if (typeof t.trigger === "string") {
			byTrigger[t.trigger] = (byTrigger[t.trigger] ?? 0) + 1;
			if (t.trigger.startsWith("compaction:")) compactionTagged++;
		}
	}
	return {
		total: turns.length,
		compactionTagged,
		share: turns.length > 0 ? compactionTagged / turns.length : null,
		byTrigger,
	};
}

// ---------------------------------------------------------------------------
// Markdown rendering (pure — takes aggregate results, returns a string)
// ---------------------------------------------------------------------------

function pct(n, d) {
	if (!d) return "n/a";
	return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtTs(ts) {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return "?";
	return new Date(ts).toISOString();
}

function noDataLine(landedDate) {
	return `_No data yet — producer landed ${landedDate}._`;
}

export function renderReport(data, meta) {
	const lines = [];
	lines.push("# CLF evidence report");
	lines.push("");
	lines.push(`Generated: ${new Date(meta.generatedAt).toISOString()}`);
	lines.push(`State dir: \`${meta.stateDirLabel}\``);
	if (meta.costStateDirLabel !== meta.stateDirLabel) {
		lines.push(`Cost state dir: \`${meta.costStateDirLabel}\``);
	}
	lines.push("");
	lines.push(
		"Offline, read-only report over three observe-only telemetry producers " +
			"(tool-permission audit log, decision traces, per-turn cost rows). " +
			"See docs/design/classifier-framework-status.md's \"Evidence tooling\" entry.",
	);
	lines.push("");

	// (a) tool-approve
	lines.push("## (a) Tool-approve: heuristic vs. actual grant/deny");
	lines.push("");
	if (data.toolApprove.totalAsks === 0) {
		lines.push(noDataLine("2026-07-05 (tool-permission-audit-log.ts)"));
	} else {
		const ta = data.toolApprove;
		lines.push(`Total tool-permission asks: **${ta.totalAsks}**`);
		lines.push(
			`By source — user: ${ta.bySource.user}, auto: ${ta.bySource.auto}, timeout: ${ta.bySource.timeout}. ` +
				`By actual decision — granted: ${ta.byDecision.granted}, denied: ${ta.byDecision.denied}.`,
		);
		lines.push("");
		lines.push(
			`Heuristic verdict coverage — select: ${ta.verdictCoverage.select}, abstain: ${ta.verdictCoverage.abstain}, ` +
				`none recorded: ${ta.verdictCoverage.none} (Wave 2 ships the tool-approve classifier harness only — ` +
				"a real classifier is registered separately; zero `select` rows is expected until one is).",
		);
		lines.push("");
		if (ta.verdictCoverage.select === 0) {
			lines.push("_No heuristic `select` verdicts recorded — confusion matrix below is all-zero by construction._");
		}
		lines.push("Confusion matrix (heuristic choice → actual decision), over rows with a `select` verdict:");
		lines.push("");
		lines.push("| | actual: granted | actual: denied |");
		lines.push("|---|---|---|");
		lines.push(`| heuristic: allow | ${ta.confusion.allowGranted} (agree) | ${ta.confusion.allowDenied} (disagree) |`);
		lines.push(`| heuristic: deny | ${ta.confusion.denyGranted} (disagree) | ${ta.confusion.denyDenied} (agree) |`);
		lines.push("");
		lines.push(`Disagreements: **${ta.disagreementCount}** (showing up to ${ta.disagreements.length}):`);
		if (ta.disagreements.length > 0) {
			lines.push("");
			lines.push("| ts | sessionId | toolName | toolGroup | heuristic | actual | source |");
			lines.push("|---|---|---|---|---|---|---|");
			for (const d of ta.disagreements) {
				lines.push(`| ${fmtTs(d.ts)} | ${d.sessionId} | ${d.toolName} | ${d.toolGroup ?? "?"} | ${d.heuristicChoice} | ${d.actualDecision} | ${d.source} |`);
			}
		}
	}
	lines.push("");

	// (b) thinking-router
	lines.push("## (b) Thinking-router: select/applied rates");
	lines.push("");
	if (data.thinkingRouter.totalConsults === 0) {
		lines.push(noDataLine("2026-07-05 (thinking-router-classifier.ts, CLF-W1b decisions[] via CLF-W1a)"));
	} else {
		const tr = data.thinkingRouter;
		lines.push(`Total consults: **${tr.totalConsults}** — select rate: ${pct(tr.selects, tr.totalConsults)} (${tr.selects} selects, ${tr.abstains} abstains).`);
		lines.push(
			`Applied rate among selects: ${pct(tr.appliedTrue, tr.selects)} applied, ${pct(tr.appliedFalse, tr.selects)} not applied, ` +
				`${tr.appliedUnknown} with no applied flag recorded (observe-mode rows never set it — see decision-types.ts's ` +
				"`DecisionOutcome.applied` doc).",
		);
		lines.push("");
		lines.push("By matched rule:");
		for (const [rule, count] of Object.entries(tr.byRule)) {
			lines.push(`- \`${rule}\`: ${count}`);
		}
		lines.push("");
		lines.push(
			"Would-be false-positive candidates: not computable from this data source — `DecisionOutcome` never persists " +
				"the prompt text (see decision-types.ts), so there is no prompt hash to cross-check against a meta-discussion " +
				"heuristic either. Listing selects by matched rule + session id instead (no content, ever):",
		);
		if (tr.selectList.length > 0) {
			lines.push("");
			lines.push("| ts | sessionId | rule | level | applied |");
			lines.push("|---|---|---|---|---|");
			for (const s of tr.selectList) {
				lines.push(`| ${fmtTs(s.ts)} | ${s.sessionId} | ${s.rule} | ${s.level} | ${s.applied ?? "—"} |`);
			}
		}
	}
	lines.push("");

	// (c) model-tier + gate-risk
	lines.push("## (c) Model-tier + gate-risk: proposed-label distributions");
	lines.push("");
	lines.push(
		"_Limitation: `DecisionOutcome` records the classifier's OUTPUT label only, never its input `arg` " +
			"(`ModelTierArg.roleName`, `GateRiskArg.changedFiles`) — a by-role or by-gate breakdown is not derivable " +
			"from this data source. Reporting the aggregate label distribution only; a role/gate breakdown would require " +
			"the producer to persist (or re-derive) that identity, which is out of scope for this offline consumer._",
	);
	lines.push("");
	lines.push("### model-tier (`session-spawn` / `model-tier`)");
	if (data.modelTier.total === 0) {
		lines.push(noDataLine("2026-07-05 (model-tier-classifier.ts, CLF-W4)"));
	} else {
		lines.push(renderLabelDist(data.modelTier));
	}
	lines.push("");
	lines.push("### gate-risk (`gate-verify` / `risk`)");
	if (data.gateRisk.total === 0) {
		lines.push(noDataLine("2026-07-05 (gate-risk-classifier.ts, CLF-W5)"));
	} else {
		lines.push(renderLabelDist(data.gateRisk));
	}
	lines.push("");

	// (d) cost
	lines.push("## (d) Cost: per-turn spike outliers + compaction share");
	lines.push("");
	if (data.cost.compaction.total === 0) {
		lines.push(noDataLine("2026-07-05 (cost-tracker.ts per-turn rows / session-cost-turns.json)"));
	} else {
		const c = data.cost;
		lines.push(`Total turn-cost rows: **${c.compaction.total}**.`);
		lines.push(
			`Compaction-tagged share: ${pct(c.compaction.compactionTagged, c.compaction.total)} (${c.compaction.compactionTagged} rows).`,
		);
		if (Object.keys(c.compaction.byTrigger).length > 0) {
			lines.push("");
			lines.push("By trigger tag:");
			for (const [trigger, count] of Object.entries(c.compaction.byTrigger)) {
				lines.push(`- \`${trigger}\`: ${count}`);
			}
		}
		lines.push("");
		lines.push(
			`Spike outliers (Tukey fence, per-session, sessions with ≥5 turns only): ` +
				`**${c.outliers.outlierCount}** flagged across ${c.outliers.sessionsConsidered} eligible session(s), showing up to ${c.outliers.outliers.length}:`,
		);
		if (c.outliers.outliers.length > 0) {
			lines.push("");
			lines.push("| ts | sessionId | seq | totalCost | session fence | trigger |");
			lines.push("|---|---|---|---|---|---|");
			for (const o of c.outliers.outliers) {
				lines.push(`| ${fmtTs(o.ts)} | ${o.sessionId} | ${o.seq} | ${o.totalCost.toFixed(6)} | ${o.sessionFence.toFixed(6)} | ${o.trigger ?? "—"} |`);
			}
		}
	}
	lines.push("");

	return lines.join("\n") + "\n";
}

function renderLabelDist(agg) {
	const lines = [];
	lines.push(`Total consults: ${agg.total} — select rate: ${pct(agg.selects, agg.total)} (${agg.selects} selects, ${agg.abstains} abstains).`);
	lines.push(
		`Applied rate among selects: ${pct(agg.appliedTrue, agg.selects)} applied, ${pct(agg.appliedFalse, agg.selects)} not applied, ` +
			`${agg.appliedUnknown} with no applied flag recorded.`,
	);
	lines.push("");
	lines.push("Label distribution:");
	const labels = Object.entries(agg.byLabel).sort((a, b) => b[1] - a[1]);
	if (labels.length === 0) {
		lines.push("_(no selects)_");
	} else {
		for (const [label, count] of labels) {
			lines.push(`- \`${label}\`: ${count} (${pct(count, agg.selects)})`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// I/O (fs reads only — never a write). Kept thin so the functions above stay
// unit-testable without touching disk.
// ---------------------------------------------------------------------------

function readJsonlDir(dir) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		let raw;
		try {
			raw = fs.readFileSync(path.join(dir, name), "utf-8");
		} catch {
			continue;
		}
		out.push(...parseJsonl(raw));
	}
	return out;
}

function readJsonFile(file) {
	try {
		if (!fs.existsSync(file)) return undefined;
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

/** Mirrors bobbit-dir.ts's `headquartersDir()`/`bobbitStateDir()` resolution
 *  (BOBBIT_DIR / BOBBIT_PI_DIR env override, else
 *  `<repoRoot>/.bobbit/headquarters/state`) without importing src/dist. */
function defaultStateDir() {
	if (process.env.BOBBIT_DIR) return path.join(path.resolve(process.env.BOBBIT_DIR), "state");
	if (process.env.BOBBIT_PI_DIR) return path.join(path.resolve(process.env.BOBBIT_PI_DIR), "state");
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(scriptDir, "..");
	return path.join(repoRoot, ".bobbit", "headquarters", "state");
}

function parseArgs(argv) {
	let stateDir;
	let costStateDir;
	for (const arg of argv) {
		if (arg.startsWith("--cost-state-dir=")) {
			costStateDir = path.resolve(arg.slice("--cost-state-dir=".length));
		} else if (!arg.startsWith("--") && stateDir === undefined) {
			stateDir = path.resolve(arg);
		}
	}
	if (stateDir === undefined) stateDir = defaultStateDir();
	if (costStateDir === undefined) costStateDir = stateDir;
	return { stateDir, costStateDir };
}

function main() {
	const { stateDir, costStateDir } = parseArgs(process.argv.slice(2));

	const auditEntries = readJsonlDir(path.join(stateDir, "tool-permission-audit"));
	const traceEntries = readJsonlDir(path.join(stateDir, "session-context-trace"));
	const costTurnsData = readJsonFile(path.join(costStateDir, "session-cost-turns.json"));

	const thinkingDecisions = flattenDecisions(traceEntries, "user-prompt-submit", "thinking");
	const modelTierDecisions = flattenDecisions(traceEntries, "session-spawn", "model-tier");
	const gateRiskDecisions = flattenDecisions(traceEntries, "gate-verify", "risk");
	const costTurns = flattenCostTurns(costTurnsData);

	const data = {
		toolApprove: aggregateToolApprove(auditEntries),
		thinkingRouter: aggregateThinkingRouter(thinkingDecisions),
		modelTier: aggregateLabelDistribution(modelTierDecisions),
		gateRisk: aggregateLabelDistribution(gateRiskDecisions),
		cost: {
			outliers: computeCostOutliers(costTurns),
			compaction: computeCompactionShare(costTurns),
		},
	};

	const report = renderReport(data, {
		generatedAt: Date.now(),
		stateDirLabel: stateDir,
		costStateDirLabel: costStateDir,
	});
	process.stdout.write(report);
}

// Only run when invoked directly (`node scripts/clf-evidence-report.mjs`),
// never when imported for its pure functions by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
	main();
}
