// src/server/agent/gate-risk-classifier.ts
//
// CLF-W5 — gate-risk classifier, OBSERVE-ONLY. Mirrors CLF-W4's model-tier
// classifier (model-tier-classifier.ts) exactly: a brand-new decision point
// (`gate-verify`, added to `DECISION_POINTS` in decision-types.ts), a pure
// deterministic rule-table classifier, registered unconditionally at gateway
// construction (server.ts) with NO enforce/apply mode this wave, and a
// consult site that never reads the result back.
//
// WHAT IT PROPOSES: a symbolic RISK LABEL (`"low" | "medium" | "high"`),
// computed ONLY from the shape of the changeset being verified — changed-file
// count, path classes (src/server vs src/ui/src/app vs tests vs docs), and a
// small explicit high-risk-surface list. NO diff content, NO commit messages,
// NO file contents, NO prompt content, NO model calls — zero tokens, same
// identity/shape-only discipline as `ModelTierArg`/`ToolApproveArg`.
//
// WHY THIS EXISTS (VER-05 / the Fable program's dark-flags reconciliation,
// 2026-07-05): the seeded `solo-fast` workflow (seed-default-workflows.ts)
// is a deterministic, opt-in-per-goal fast path (build/check/unit + one
// consolidated review, no e2e, no doc gate) that measures a real -12.8%
// wall-clock / -75% review-token win on the pass path — but "there is NO
// risk-classification logic anywhere; selection is purely human/agent
// choice" (RECONCILIATION-2026-07-05.md's VER-05 section). Auto-selecting
// solo-fast for a diff the classifier calls "low" risk would be the natural
// next step, but doing that BEFORE any evidence exists about what real
// changesets actually look like would be a guess, not a decision. This
// classifier is that evidence-gatherer: it runs on every real gate
// verification, from the moment this PR merges, and accumulates the
// would-have-chosen label distribution — without ever touching workflow
// selection. See seed-default-workflows.ts's own comment seam (search
// "CLF-W5") for the auto-selection door this wave deliberately leaves closed.
//
// CONSERVATIVE BY CONSTRUCTION: `matchesHighRiskSurface` uses an explicit,
// hand-curated list of paths known to gate correctness/security-sensitive
// behavior (session lifecycle, the verification harness itself, the server
// entrypoint, auth) — reused verbatim, not inferred. A file is EXACT-matched
// against a listed file path or PREFIX-matched against a listed directory
// (trailing `/`) — never a loose substring — so e.g. a
// `session-manager.test.ts` change (a different, lower-risk file) does not
// spuriously trip the same rule as `session-manager.ts` itself.
//
// Everything else is a total function of shape, not an "abstain when
// unsure" cascade like the model-tier/tool-approve rule tables: once a real
// changed-file list is known, EVERY changeset gets a label (see
// `classifyGateRisk`'s doc comment for why `abstain` is reserved for "the
// signal itself is unavailable", not "the label is ambiguous").
import type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionPoint } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";

/** The (point, kind) pair this classifier is registered at. */
export const GATE_RISK_POINT: DecisionPoint = "gate-verify";
export const GATE_RISK_KIND = "risk";
export const GATE_RISK_CLASSIFIER_ID = "builtin.gate-risk";

/** Symbolic risk label — never a numeric score, never diff content. */
export type GateRiskLevel = "low" | "medium" | "high";

/** One of the four coarse path buckets a changed file is classified into. */
export type GateRiskPathClass = "server" | "ui" | "tests" | "docs" | "other";

/**
 * Argument shape passed to the gate-risk classifier's `evaluate()` — identity
 * /shape only, same minimalism as `ModelTierArg`/`ToolApproveArg`.
 *
 * `changedFiles` is a flat list of repo-relative paths (as `git diff
 * --name-only` reports them) — no diff hunks, no file contents. `undefined`
 * means the signal could not be computed this run (e.g. the git call at the
 * consult site failed) and MUST abstain; `[]` is itself a valid, fully-known
 * "zero files changed" signal and gets a real label.
 */
export interface GateRiskArg {
	changedFiles?: string[];
}

/** Bucket a single repo-relative path into a coarse path class. Order matters:
 *  `tests/` and doc paths are checked before `src/server`/`src/ui`/`src/app`
 *  so a doc file living anywhere is never miscounted as source. */
export function classifyGateRiskPath(file: string): GateRiskPathClass {
	if (file.startsWith("tests/")) return "tests";
	if (file.startsWith("docs/") || file.endsWith(".md")) return "docs";
	if (file.startsWith("src/server/")) return "server";
	if (file.startsWith("src/ui/") || file.startsWith("src/app/")) return "ui";
	return "other";
}

/**
 * Hand-curated, deliberately small list of correctness/security-sensitive
 * surfaces. A trailing `/` entry is a directory PREFIX match; anything else
 * is an EXACT file-path match — see this file's header for why exact/prefix
 * (never substring) matching matters.
 */
export const HIGH_RISK_SURFACES: readonly string[] = [
	"src/server/agent/session-manager.ts",
	"src/server/agent/verification-harness.ts",
	"src/server/server.ts",
	"src/server/auth/",
];

function matchesHighRiskSurface(file: string): boolean {
	return HIGH_RISK_SURFACES.some((surface) => (surface.endsWith("/") ? file.startsWith(surface) : file === surface));
}

/** Changeset size above which a diff is flagged "medium" purely on volume,
 *  independent of which paths it touches. Deliberately conservative/coarse —
 *  this is a telemetry-gathering wave, not a tuned threshold; revisit once
 *  real label-distribution data exists. */
export const LARGE_CHANGESET_FILE_THRESHOLD = 15;

/**
 * Pure rule-table function — zero tokens, zero I/O, fully synchronous.
 *
 * Rule precedence (first match wins):
 *  1. `abstain` — `changedFiles` is `undefined` (signal unavailable).
 *  2. `select(high)` — any changed file matches `HIGH_RISK_SURFACES`.
 *  3. `select(medium)` — changeset size exceeds `LARGE_CHANGESET_FILE_THRESHOLD`.
 *  4. `select(medium)` — at least one `src/server/` file changed and ZERO
 *     `tests/` files changed in the same changeset (server behavior changing
 *     with no accompanying test signal).
 *  5. `select(low)` — everything else, including the empty changeset.
 *
 * Unlike the model-tier/tool-approve rule tables, this one never abstains
 * once `changedFiles` is known — a risk label is a total function of shape,
 * there is no "role not on the table" equivalent to defer on.
 */
export function classifyGateRisk(arg: GateRiskArg): Decision<GateRiskLevel> {
	const files = arg.changedFiles;
	if (!files) return { kind: "abstain" };

	const hitSurface = files.find(matchesHighRiskSurface);
	if (hitSurface !== undefined) {
		return {
			kind: "select",
			choice: "high",
			confidence: 1,
			rationale: `matched deterministic rule 'high-risk-surface': changed file "${hitSurface}" is on the explicit high-risk surface list`,
		};
	}

	if (files.length > LARGE_CHANGESET_FILE_THRESHOLD) {
		return {
			kind: "select",
			choice: "medium",
			confidence: 1,
			rationale: `matched deterministic rule 'large-changeset': ${files.length} changed file(s) exceeds the ${LARGE_CHANGESET_FILE_THRESHOLD}-file threshold`,
		};
	}

	const classes = files.map(classifyGateRiskPath);
	const serverFileCount = classes.filter((c) => c === "server").length;
	const testFileCount = classes.filter((c) => c === "tests").length;
	if (serverFileCount > 0 && testFileCount === 0) {
		return {
			kind: "select",
			choice: "medium",
			confidence: 1,
			rationale: `matched deterministic rule 'server-change-no-tests': ${serverFileCount} src/server/ file(s) changed with 0 tests/ file(s) in the same changeset`,
		};
	}

	return {
		kind: "select",
		choice: "low",
		confidence: 1,
		rationale: `matched deterministic rule 'default-low': ${files.length} changed file(s), no high-risk surface, no large-changeset/server-without-tests signal`,
	};
}

function isGateRiskArg(value: unknown): value is GateRiskArg {
	if (!value || typeof value !== "object") return false;
	const changedFiles = (value as GateRiskArg).changedFiles;
	return changedFiles === undefined || (Array.isArray(changedFiles) && changedFiles.every((f) => typeof f === "string"));
}

/**
 * The built-in conservative classifier — CLF-W5's real customer at
 * `(gate-verify, risk)`. A malformed/missing `arg` abstains rather than
 * throwing, matching every other classifier in this lane's discipline.
 */
export const gateRiskClassifier: DecisionClassifier<GateRiskLevel> = {
	id: GATE_RISK_CLASSIFIER_ID,
	evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<GateRiskLevel> {
		if (!isGateRiskArg(arg)) return { kind: "abstain" };
		return classifyGateRisk(arg);
	},
};

/**
 * Registers the built-in gate-risk classifier at `(gate-verify, risk)`.
 * Called ONCE at gateway construction (`server.ts`), same pattern as
 * `registerModelTierClassifier` — registered unconditionally (no enable
 * flag) since this classifier has no apply mode to gate; recording telemetry
 * is the entire point of this wave. Returns the unregister function for
 * symmetry/tests; production code never calls it.
 */
export function registerGateRiskClassifier(hub: LifecycleHub): () => void {
	return hub.registerDecisionClassifier<GateRiskLevel>(GATE_RISK_POINT, GATE_RISK_KIND, gateRiskClassifier);
}

/**
 * Gathers the ONLY signal this classifier consumes: the flat list of
 * repo-relative changed file paths between `origin/<baseBranch>` and `HEAD`
 * in `cwd` — mirroring `computeReviewDiffArtifact`'s own `origin/<branch>
 * ...HEAD` ref shape (verification-harness.ts) so this reuses the exact same
 * "what counts as the diff" convention the review-prompt diff artifact
 * already uses, rather than inventing a second one. `package-lock.json` is
 * excluded for the same reason `computeReviewDiffArtifact` excludes it — a
 * lockfile-only diff is not a meaningful shape signal.
 *
 * Returns `undefined` (never throws) on ANY git failure — unresolvable
 * `baseBranch`, no `origin` remote, timeout, not-a-git-repo — so the caller's
 * classifier consult abstains cleanly instead of the whole gate-verify run
 * failing over a telemetry signal.
 */
export async function gatherGateRiskChangedFiles(cwd: string, baseBranch: string): Promise<string[] | undefined> {
	try {
		const { execFile: execFileCb } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFileCb);
		const baseRef = `origin/${baseBranch}`;
		const { stdout } = await execFileAsync(
			"git",
			["diff", "--name-only", `${baseRef}...HEAD`, "--", ".", ":!package-lock.json"],
			{ cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
		);
		return stdout
			.toString()
			.split(/\r?\n/)
			.filter(Boolean);
	} catch {
		return undefined;
	}
}
