// Pack SERVER route module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// ESM (`export const routes`), loaded by the gateway RouteRegistry/RouteDispatcher
// and EXECUTED inside the confined worker. Pack server code is TRUSTED (the tool/MCP
// tier), so `node:child_process` + `node:fs` are ambient, `process.cwd()` is the
// SERVER-derived session working dir (worker threads can't `chdir`, so the bootstrap
// overrides `process.cwd` for tool parity), and any spawned `git` child is SIGKILLed
// on terminate-on-timeout (resource isolation). The git working dir is server-derived
// from the bound session, never caller-supplied.
//
// ── LIVE CHANGESET RECOMPUTE (design §D2.3 — the reversal of the prior revision) ──
// The bespoke route `src/server/pr-walkthrough/routes.ts` COMPUTES the changeset
// bundle at request time: it shells out to `git` (execFile), parses the unified
// diff, assembles the changeset header, and runs LLM card synthesis. This pack route
// re-expresses the STRUCTURAL part of that LIVE in the confined worker — the SAME
// `git diff`/`--name-status`/`--shortstat` + diff parse + `synthesizeFallbackCards`
// logic — so `bundle` returns a REAL, freshly-computed changeset for the requested
// base/head, including PRs created AFTER the pack was installed (a static seeded
// fixture could only replay PRs known at publish time).
//
// ── THE GIT WORKING DIR IS SERVER-DERIVED, NEVER CALLER-SUPPLIED (security) ──
// The repo root is ALWAYS the worker's own `process.cwd()` — i.e. the bound
// session's working dir, server-resolved from the persisted session. This module
// does NOT accept a caller-controlled `repoDir` (from query, body, or store) as the
// git cwd: a session scoped to this pack must not be able to point the route at
// ANOTHER local repo the gateway can reach (that would disclose diffs/metadata from
// other projects and bypass session-working-dir confinement). The caller chooses
// WHICH base/head to diff; the SERVER chooses WHICH repo (the session worktree).
//
// ── THE SYNTHESIS SPLIT (design §D2.3) ──
// LLM card synthesis needs MODEL CREDENTIALS + an agent loop. Rather than re-derive
// that inference inside this route, this pack keeps synthesis at agent-tool/submit
// time (where the agent already has its model creds) and has the route serve the
// persisted result. So LLM synthesis does NOT run in this route. The split:
//   • The STRUCTURAL changeset + deterministic fallback cards are COMPUTED LIVE
//     here (git).
//   • LLM-ENHANCED cards are produced at AGENT-TOOL/submit time
//     (`submit_pr_walkthrough_yaml`, normal agent creds, NOT this worker) and
//     PERSISTED via the `publish` route to `host.store`, keyed by the changeset id.
//   • This `bundle` route, when the computed changeset id HAS stored cards, READS
//     them via `host.store.get` and renders them (full parity); when none exist it
//     returns the correct non-LLM (fallback) walkthrough it just computed.
// `host.store.*` is pack-scoped server-side by the SERVER-derived packId (cross-pack
// reads rejected) — so this module never names a packId or a path.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

// PRODUCTION-FAITHFUL SYNTHESIS (design built-in-first-party-packs §8.4): the pack
// runs the SAME YAML→cards synthesis as the deleted built-in via the pure shared
// module, bundled (with its `yaml` dep) to the sibling lib/yaml-to-cards.mjs by
// build:packs. The `publish` route validates + maps the RAW submitted production
// YAML (pr + walkthrough.{…}, NOT a `{cards}` shortcut) against the LIVE-computed
// diff blocks, so the pack reaches REAL parity with the built-in viewer. This is a
// pack-root-confined relative import (the routes module graph is allowed to import
// sibling pack files in the confined worker).
import { mapYamlToWalkthroughPayload, validatePrWalkthroughYaml } from "./yaml-to-cards.mjs";

const STORE_SCHEMA_VERSION = 1;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;

const jobKey = (jobId) => `job/${jobId}`;
// LLM-enhanced cards persisted at submit time are keyed by the STRUCTURAL changeset
// id (base..head) so a freshly-recomputed bundle for the same range finds them.
const cardsKey = (changesetId) => `cards/${b64url(changesetId)}`;

// ── host.agents reviewer migration (design Decisions C/D/E) — pack-store keys. ──
// The reviewer child is a real, isolated, read-only principal minted by the `run`
// route via host.agents.spawn (replacing the old host.session.postMessage hijack).
// Routing/idempotency live entirely in these pack-scoped keys (the legacy
// WalkthroughAgentStore + submit-proof secret are gone):
//   binding/<childSessionId>            → { jobId, changesetId, baseSha, headSha,
//                                            parentSessionId, canonicalKey, target,
//                                            status, kickedOff }
//   reviewer/<parentSessionId>/<b64key> → { childSessionId, jobId }   (idempotency index)
//   submitted/<jobId>                   → { yaml, baseSha, headSha, submittedAt }
// NO launch-bundle key — the analysis bundle is resolved server-side by the bundle
// endpoint (design §6). status ∈ running|submitted|ready|error (TERMINAL = the last three).
const bindingKey = (childSessionId) => `binding/${childSessionId}`;
const reviewerKey = (parentSessionId, canonicalKey) => `reviewer/${parentSessionId}/${b64url(canonicalKey)}`;
const submittedKey = (jobId) => `submitted/${jobId}`;

// MODULE-SCOPED in-flight launch map — the analogue of the deleted launchInFlight
// mutex. The routes module is a worker SINGLETON, so this Map persists across
// host.callRoute("run") invocations and serializes near-simultaneous same-target
// launches: a second concurrent `run` for `${parent}\0${canonicalKey}` awaits the
// first's promise and returns its result (created:false). Cleared in `finally`.
const inFlightLaunches = new Map();

// host.agents reviewer-launch retry bound (Decision E): clearly-transient spawn
// errors are auto-retried (short backoff) so a blip never surfaces; non-transient
// codes like ROLE_TOOLS_UNRESOLVED are NOT retried.
const SPAWN_MAX_ATTEMPTS = 2;

function b64url(value) {
	return Buffer.from(String(value), "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeJobId(value) {
	// No more shared litmus literal: the panel derives the REAL jobId from the
	// submitted doc's `pr` (changesetIdForGithub). The neutral fallback is only used
	// when a bare deep-link carries no jobId AND no persisted pointer exists.
	return typeof value === "string" && value.trim() ? value.trim() : "pr-walkthrough";
}

function strOf(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const routes = {
	// LIVE changeset recompute + persisted-card read. Two modes:
	//   • baseSha + headSha present → recompute the REAL changeset LIVE via `git`
	//     (in the confined worker, declared git/fs) and serve it + any stored cards.
	//   • only jobId → load the persisted job pointer (base/head written by
	//     `publish`) and recompute live from it (store-rehydration); else empty.
	// NEVER a raw fetch — the panel reaches this only via host.callRoute.
	//
	// SECURITY (the git working dir is SERVER-DERIVED, never caller-supplied): the
	// repo root is ALWAYS the worker's own cwd() — i.e. the bound session's working
	// dir, server-resolved from the persisted session (server.ts routeWorkingDir).
	// We do NOT accept a caller-controlled `repoDir` from query/body/store as the git
	// cwd: an authenticated session scoped to this pack must not be able to point the
	// route at ANOTHER local repo the gateway can reach (that would disclose diffs /
	// metadata from other projects and bypass session-working-dir confinement). Any
	// `repoDir` a caller sends is IGNORED in favour of the session worktree.
	bundle: async (ctx, req) => {
		const q = (req && req.query) || {};
		const jobId = normalizeJobId(q.jobId);
		let baseSha = strOf(q.baseSha);
		let headSha = strOf(q.headSha);

		// jobId-only: rehydrate base/head from the persisted job pointer so a deep-link
		// carrying only the jobId still recomputes the SAME changeset live. The repo
		// root is NOT rehydrated from the pointer — it is always the session worktree.
		if ((!baseSha || !headSha)) {
			const job = await ctx.host.store.get(jobKey(jobId));
			if (job && typeof job === "object") {
				baseSha = baseSha || strOf(job.baseSha);
				headSha = headSha || strOf(job.headSha);
			}
		}

		if (!baseSha || !headSha) {
			// No base/head to recompute from and no persisted pointer — the viewer
			// shows an explicit empty state (a real launcher injects the current
			// branch's base/head; the litmus drives a sha-carrying deep-link).
			return { found: false, jobId };
		}

		// ALWAYS the session worktree (the worker's server-resolved cwd) — never a
		// caller path. A base/head that does not exist in the session worktree fails
		// `git rev-parse --verify` below (no other-repo data is ever returned).
		const live = await resolveLocalChangeset(workerCwd(), baseSha, headSha);

		// Prefer the synthesized production cards persisted at submit time (keyed by
		// changeset id); else the deterministic fallback cards computed in-worker above.
		// When stored cards exist we also serve the STORED changeset (it carries the PR
		// title/metadata from the production YAML) over the bare local changeset.
		const stored = await ctx.host.store.get(cardsKey(live.changesetId));
		const hasStored = stored && Array.isArray(stored.cards) && stored.cards.length > 0;
		return {
			found: true,
			live: true,
			jobId,
			changesetId: live.changesetId,
			changeset: hasStored && stored.changeset ? stored.changeset : live.changeset,
			cards: hasStored ? stored.cards : live.cards,
			warnings: live.warnings,
			cardsSource: hasStored ? "stored-synthesis" : "fallback",
			persistedAt: hasStored ? stored.persistedAt : undefined,
		};
	},

	// Submit-time persistence seam — PRODUCTION-FAITHFUL synthesis (design §8.4).
	// The agent's submit_pr_walkthrough_yaml emits the RICH production YAML (pr +
	// walkthrough.{context,merge_assessment,design_decisions,review_chunks,…}); the
	// panel hands that RAW yaml text here as `{ yaml, jobId, baseSha, headSha }`. This
	// route (confined worker, ambient git/fs) then runs the SAME synthesis the deleted
	// built-in ran:
	//   1. RECOMPUTE the LIVE changeset (`git`) against the session worktree — both to
	//      key the store per-real-changeset AND to feed real diff blocks to the mapper.
	//   2. validate + map the YAML → PrWalkthroughCard[] via the bundled shared module
	//      (DiffReferenceMapper resolves relevant_hunks/anchors against the live diff).
	//   3. persist the synthesized cards keyed by the LIVE changeset id (the same key
	//      `bundle` recomputes), plus a job pointer { changesetId, baseSha, headSha } so
	//      a jobId-only deep-link can rehydrate the base/head. No `repoDir` is ever
	//      persisted (the git root is the server-derived session worktree).
	// `persistedAt` is stamped ONCE per changeset (a re-publish keeps the original
	// stamp) so `bundle` returns a stable timestamp across reloads — the
	// store-rehydration parity proof. An invalid YAML returns a structured schema
	// error (the panel surfaces it; nothing is persisted).
	publish: async (ctx, req) => {
		const body = (req && req.body) || {};
		const jobId = normalizeJobId(body.jobId);
		let baseSha = strOf(body.baseSha);
		let headSha = strOf(body.headSha);

		// Rehydrate base/head from the job pointer when a re-publish omits them.
		if (!baseSha || !headSha) {
			const job = await ctx.host.store.get(jobKey(jobId));
			if (job && typeof job === "object") {
				baseSha = baseSha || strOf(job.baseSha);
				headSha = headSha || strOf(job.headSha);
			}
		}

		// LIVE changeset recompute against the session worktree (server-derived cwd).
		// Provides BOTH the per-real-changeset store key and the parsed diff blocks the
		// synthesis maps relevant_hunks / suggested-comment anchors against.
		let live;
		if (baseSha && headSha) {
			live = await resolveLocalChangeset(workerCwd(), baseSha, headSha);
		}
		const changesetId = (live && live.changesetId)
			|| strOf(body.changesetId)
			|| (baseSha && headSha ? changesetIdForLocal(baseSha, headSha) : undefined)
			|| jobId;

		// Job pointer — lets a jobId-only deep-link rehydrate base/head. NEVER a repoDir.
		await ctx.host.store.put(jobKey(jobId), {
			schemaVersion: STORE_SCHEMA_VERSION,
			jobId,
			changesetId,
			baseSha,
			headSha,
		});

		// Validate + map the RAW production YAML through the SHARED synthesis.
		const yamlText = strOf(body.yaml);
		if (!yamlText) {
			const keys = await ctx.host.store.list("");
			return { ok: true, jobId, changesetId, persistedAt: undefined, cardCount: 0, keys };
		}
		const validation = validatePrWalkthroughYaml(yamlText);
		if (!validation.ok) {
			// Structured schema error — the panel renders the validation message; we
			// persist NOTHING (the bundle then falls back to the structural cards).
			return { ok: false, error: "YAML_SCHEMA_INVALID", summary: validation.summary, jobId, changesetId };
		}
		const parsedDiff = live
			? { diffBlocks: live.blocks, changeset: live.changeset, warnings: live.warnings }
			: {};
		const result = mapYamlToWalkthroughPayload(validation.document, parsedDiff);
		const cards = Array.isArray(result.cards) ? result.cards : [];
		const warnings = Array.isArray(result.warnings) ? result.warnings : [];

		// Persist synthesized cards keyed by the LIVE changeset id; persistedAt once.
		const existing = await ctx.host.store.get(cardsKey(changesetId));
		const persistedAt = typeof body.persistedAt === "number"
			? body.persistedAt
			: (existing && typeof existing.persistedAt === "number" ? existing.persistedAt : Date.now());
		await ctx.host.store.put(cardsKey(changesetId), {
			schemaVersion: STORE_SCHEMA_VERSION,
			changesetId,
			// Persist the synthesized changeset too (it carries the production PR
			// title/metadata) so `bundle` renders the real header, not the bare sha range.
			changeset: result.changeset,
			cards,
			warnings,
			persistedAt,
		});

		const keys = await ctx.host.store.list("");
		return { ok: true, jobId, changesetId, persistedAt, cardCount: cards.length, keys };
	},

	// ── run ──────────────────────────────────────────────────────────────────────
	// Mints a REAL, isolated, read-only reviewer child via host.agents.spawn (NOT
	// host.session.postMessage — the user's own agent is never driven). Input:
	//   { prUrl } | { owner, repo, prNumber } | { baseSha, headSha }
	// Idempotent (one reviewer per parent+target, concurrency-deduped) and
	// failure-atomic (compensates on any post-spawn failure). The bound owner is
	// ctx.sessionId (host.agents children are owner-scoped). Returns either
	//   { ok:true, created, jobId, childSessionId, changesetId, baseSha, headSha, status } or
	//   { ok:false, retryable, error, code }   (the panel surfaces a "Run again" affordance).
	run: async (ctx, req) => {
		const body = (req && req.body) || {};
		const parent = strOf(ctx && ctx.sessionId);
		if (!parent) return { ok: false, retryable: false, error: "missing bound session", code: "NO_SESSION" };

		// When the body carries NO usable explicit target (the primary launch path:
		// every shipped launcher navigates to a bare #/ext/pr-walkthrough, so onRun
		// posts an empty runBody), resolve the current branch's open GitHub PR from
		// the SERVER-DERIVED worker cwd via gh/git. An explicit target in the body
		// always wins (deep-links / tests); only resolve-from-branch when absent.
		let targetInput = body;
		if (!hasExplicitTarget(body)) {
			const resolved = await resolveCurrentBranchTarget(workerCwd());
			if (!resolved.ok) return resolved;
			targetInput = resolved.target;
		}

		let target;
		try {
			target = await canonicalizeTarget(targetInput, workerCwd());
		} catch (e) {
			return { ok: false, retryable: false, error: messageOf(e), code: "INVALID_TARGET" };
		}
		const canonicalKey = target.canonicalKey;
		const launchKey = `${parent}\0${canonicalKey}`;

		// Step 1b: concurrency dedupe — await an in-flight launch for the same key.
		const pending = inFlightLaunches.get(launchKey);
		if (pending) {
			const result = await pending;
			return { ...result, created: false };
		}
		const promise = launchReviewer(ctx, parent, target, canonicalKey);
		inFlightLaunches.set(launchKey, promise);
		try {
			return await promise;
		} finally {
			inFlightLaunches.delete(launchKey);
		}
	},

	// ── status ───────────────────────────────────────────────────────────────────
	// BINDING-AUTHORITATIVE poll. Input { childSessionId, jobId }. Loads the binding
	// FIRST and verifies jobId + parentSessionId===ctx.sessionId before reading
	// anything else (no probing an arbitrary job's submitted marker). Completion is
	// the pack-store submitted-YAML marker, NOT the agent's idle status. Returns
	//   { phase:"running", agentStatus } | { phase:"submitted", yaml, baseSha, headSha }
	//   | { phase:"error", agentStatus?, error }.
	status: async (ctx, req) => {
		const body = (req && req.body) || {};
		const childSessionId = strOf(body.childSessionId);
		const jobId = strOf(body.jobId);
		const store = ctx.host.store;
		if (!childSessionId || !jobId) {
			return { phase: "error", error: "childSessionId and jobId are required" };
		}

		// Verify the caller owns the bound job; on mismatch read NOTHING else.
		const binding = await store.get(bindingKey(childSessionId));
		if (!binding || typeof binding !== "object"
			|| binding.jobId !== jobId
			|| binding.parentSessionId !== ctx.sessionId) {
			return { phase: "error", error: "unknown or mismatched binding" };
		}

		const submitted = await store.get(submittedKey(binding.jobId));
		let agentStatus = "preparing";
		try { agentStatus = (await ctx.host.agents.status(childSessionId)).status; }
		catch { agentStatus = "terminated"; }

		if (submitted && typeof submitted === "object") {
			// Redundant safety net — submit-yaml already server-dismisses the reviewer.
			try { await ctx.host.agents.dismiss(childSessionId); } catch { /* idempotent */ }
			return { phase: "submitted", yaml: submitted.yaml, baseSha: submitted.baseSha, headSha: submitted.headSha };
		}
		if (agentStatus === "terminated") {
			// Errored without submitting: mark the binding terminal and dismiss (the
			// PRIMARY cleanup driver on this path; dismiss stamps the generic
			// childTerminal marker server-side so a pre-poll restart still reaps it).
			await store.put(bindingKey(childSessionId), { ...binding, status: "error" });
			try { await ctx.host.agents.dismiss(childSessionId); } catch { /* best-effort */ }
			return { phase: "error", agentStatus, error: "The reviewer terminated without producing a walkthrough." };
		}
		return { phase: "running", agentStatus };
	},
};

// ── The worker's process.cwd() — the server-derived session working dir (the
//    bootstrap overrides process.cwd for tool parity, since worker threads can't
//    chdir). Guarded so a load in an unusual environment never throws. ──
function workerCwd() {
	try {
		return typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : ".";
	} catch {
		return ".";
	}
}

// ── LIVE git changeset resolution (re-expresses resolveLocalFallback +
//    parseUnifiedDiff + applyNameStatus + parseShortstat + synthesizeFallbackCards
//    from src/server/pr-walkthrough/routes.ts, ported verbatim so the rendered
//    shapes match PrWalkthroughPanel.ts at parity). ──

async function resolveLocalChangeset(cwd, baseSha, headSha) {
	const fullBase = (await git(cwd, ["rev-parse", "--verify", `${baseSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid baseSha: ${baseSha}`);
	})).trim();
	const fullHead = (await git(cwd, ["rev-parse", "--verify", `${headSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid headSha: ${headSha}`);
	})).trim();
	const diff = await git(cwd, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--binary", "--unified=80", fullBase, fullHead]);
	const nameStatus = await git(cwd, ["diff", "--name-status", "-M", "-C", fullBase, fullHead]);
	const shortstat = await git(cwd, ["diff", "--shortstat", fullBase, fullHead]).catch(() => "");
	const warnings = [];
	const blocks = parseUnifiedDiff(diff, warnings);
	applyNameStatus(blocks, nameStatus);
	const stats = parseShortstat(shortstat, blocks.length);
	const changeset = {
		baseSha: fullBase,
		headSha: fullHead,
		provider: "local",
		title: `${shortSha(fullBase)}..${shortSha(fullHead)}`,
		filesChanged: stats.filesChanged,
		additions: stats.additions,
		deletions: stats.deletions,
	};
	const cards = synthesizeFallbackCards(changeset, blocks, warnings);
	// `blocks` is exposed so the `publish` route can feed the LIVE parsed diff into
	// the shared YAML→cards synthesis (real DiffReferenceMapper hunk/anchor mapping).
	return { changesetId: changesetIdForLocal(fullBase, fullHead), changeset, cards, warnings, blocks };
}

function git(cwd, args) {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (err, stdout) => {
			if (err) reject(err);
			else resolve(typeof stdout === "string" ? stdout : String(stdout));
		});
	});
}

// `gh` (GitHub CLI) runs in the SERVER-DERIVED worker cwd, same ambient model as
// `git` — never a caller-supplied dir. Rejects (non-zero exit) when there is no
// open PR for the current branch, which the caller maps to a NO_PR result.
function gh(cwd, args) {
	return new Promise((resolve, reject) => {
		execFile("gh", args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (err, stdout) => {
			if (err) reject(err);
			else resolve(typeof stdout === "string" ? stdout : String(stdout));
		});
	});
}

function parseUnifiedDiff(diff, warnings) {
	const lines = diff.split(/\r?\n/);
	const blocks = [];
	let block;
	let hunk;
	let oldLine = 0;
	let newLine = 0;
	let hunkIndex = -1;

	for (const raw of lines) {
		if (raw.startsWith("diff --git ")) {
			const match = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
			const filePath = (match && match[2]) || raw.replace(/^diff --git\s+/, "");
			block = { id: `block-${blocks.length + 1}-${slug(filePath)}`, filePath, oldPath: match && match[1], status: "modified", hunks: [] };
			blocks.push(block);
			hunk = undefined;
			hunkIndex = -1;
			continue;
		}
		if (!block) continue;
		if (raw.startsWith("new file mode")) block.status = "added";
		else if (raw.startsWith("deleted file mode")) block.status = "deleted";
		else if (raw.startsWith("rename from ")) { block.oldPath = raw.slice("rename from ".length); block.status = "renamed"; }
		else if (raw.startsWith("rename to ")) { block.filePath = raw.slice("rename to ".length); block.id = block.id.replace(/-[^-]*$/, `-${slug(block.filePath)}`); }
		else if (raw.startsWith("copy from ")) { block.oldPath = raw.slice("copy from ".length); block.status = "copied"; }
		else if (raw.startsWith("Binary files ")) {
			block.status = "binary";
			warnings.push({ code: "binary-file", severity: "warning", message: `Binary file cannot be rendered: ${block.filePath}`, filePath: block.filePath });
		}
		else if (raw.startsWith("--- ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("a/")) block.oldPath = p.slice(2);
		}
		else if (raw.startsWith("+++ ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("b/")) block.filePath = p.slice(2);
		}
		else if (raw.startsWith("@@ ")) {
			const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			oldLine = match ? Number(match[1]) : 0;
			newLine = match ? Number(match[2]) : 0;
			hunkIndex += 1;
			hunk = { id: `${block.id}-h${hunkIndex + 1}`, header: raw, lines: [] };
			block.hunks.push(hunk);
		}
		else if (hunk && (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-"))) {
			const lineIndex = hunk.lines.length;
			const prefix = raw[0];
			const text = raw.slice(1);
			if (prefix === " ") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "context", oldLine, newLine, kind: "context", text });
				oldLine += 1;
				newLine += 1;
			} else if (prefix === "+") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "new", newLine, kind: "add", text });
				newLine += 1;
			} else {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "old", oldLine, kind: "del", text });
				oldLine += 1;
			}
		}
	}
	// A modified file's `--- a/X` / `+++ b/X` headers set oldPath === filePath. The
	// shared DiffReferenceMapper indexes a block under BOTH paths, so a redundant
	// oldPath double-indexes it and breaks the sole-hunk lenient match (suggested-
	// comment anchors then fail to map). Keep oldPath ONLY for true renames/copies.
	for (const block of blocks) {
		if (block.oldPath && block.oldPath === block.filePath) block.oldPath = undefined;
	}
	return blocks;
}

function applyNameStatus(blocks, nameStatus) {
	for (const line of nameStatus.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const code = parts[0];
		const status = code.startsWith("R") ? "renamed"
			: code.startsWith("C") ? "copied"
			: code === "A" ? "added"
			: code === "D" ? "deleted"
			: code === "M" ? "modified"
			: undefined;
		const filePath = parts[parts.length - 1];
		const block = blocks.find((item) => item.filePath === filePath || item.oldPath === filePath);
		if (block && status) {
			block.status = block.status === "binary" ? "binary" : status;
			if ((status === "renamed" || status === "copied") && parts[1]) block.oldPath = parts[1];
		}
	}
}

function parseShortstat(shortstat, fallbackFiles) {
	const filesMatch = shortstat.match(/(\d+) files? changed/);
	const addMatch = shortstat.match(/(\d+) insertions?\(\+\)/);
	const delMatch = shortstat.match(/(\d+) deletions?\(-\)/);
	return {
		filesChanged: Number(filesMatch ? filesMatch[1] : fallbackFiles),
		additions: Number(addMatch ? addMatch[1] : 0),
		deletions: Number(delMatch ? delMatch[1] : 0),
	};
}

function synthesizeFallbackCards(changeset, files, warnings) {
	const prContext = strOf(changeset.prBody);
	const why = prContext ? prContext.replace(/\s+/g, " ").slice(0, 220) : (changeset.prTitle || changeset.title || "No PR description was available.");
	const context = changeset.prTitle || changeset.title || "No additional PR context was provided.";
	const cards = [{
		id: "orientation-summary",
		phaseId: "orientation",
		title: "PR context",
		navLabel: "Orientation",
		summary: `Why this PR was raised: ${why}`,
		rationale: `Context to understand the PR: ${context}`,
		diffBlocks: [],
		checklist: ["Testing strategy: No testing strategy was specified in the PR description.", ...warnings.slice(0, 2).map((w) => (w.filePath ? `${w.filePath}: ${w.message}` : w.message))],
	}];
	if (files.length > 0) {
		const reviewBlocks = files.filter((file) => file.status !== "binary");
		cards.push({
			id: "significant-files",
			phaseId: "significant",
			title: "Changed files",
			navLabel: deriveNavLabel("Changed files"),
			summary: `Review ${reviewBlocks.length || files.length} diff-backed file${(reviewBlocks.length || files.length) === 1 ? "" : "s"}.`,
			diffBlocks: reviewBlocks.length ? reviewBlocks : files,
		});
		cards.push({
			id: "audit-coverage",
			phaseId: "audit",
			title: "Audit remaining coverage",
			navLabel: deriveNavLabel("Audit remaining coverage"),
			summary: "Final pass over the resolved diff and any unreviewable files.",
			diffBlocks: files,
			cardSuggestions: warnings.map((w) => w.message),
		});
	}
	return cards;
}

// Ported from src/shared/pr-walkthrough/nav-label.ts (deriveNavLabel) so rail
// labels match the bespoke walkthrough; the pack module cannot import server code
// (pack-root confinement), so the small helper is inlined.
const NAV_LABEL_MAX_WORDS = 3;
const NAV_LABEL_MAX_CHARS = 24;
function deriveNavLabel(title) {
	const trimmed = (title || "").trim();
	if (trimmed.length === 0) return "";
	let head = trimmed;
	const separator = /\s-\s|[:—]/.exec(trimmed);
	if (separator) {
		const prefix = trimmed.slice(0, separator.index).trim();
		if (prefix.length > 0) head = prefix;
	}
	const label = head.split(/\s+/).slice(0, NAV_LABEL_MAX_WORDS).join(" ");
	if (label.length > NAV_LABEL_MAX_CHARS) return `${label.slice(0, NAV_LABEL_MAX_CHARS - 1)}…`;
	return label;
}

function changesetIdForLocal(baseSha, headSha) {
	return `${shortSha(baseSha)}..${shortSha(headSha)}`;
}

function shortSha(sha) {
	return String(sha || "").slice(0, 7);
}

function slug(value) {
	const clean = String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return clean || "file";
}

// ── host.agents reviewer launch (run route helpers) ─────────────────────────────────
// Steps 2–5 of the run route (§3.2): idempotency → spawn(deferInitialPrompt) →
// write binding + reviewer index → kickoff prompt → flip kickedOff. All post-spawn
// steps are wrapped in ONE try/catch that COMPENSATES (dismiss child + tombstone
// both keys) on any failure, so a retry starts clean.
async function launchReviewer(ctx, parent, target, canonicalKey) {
	const store = ctx.host.store;
	const kickoff = buildKickoffPrompt(target);

	// Step 2: idempotency — reuse a LIVE reviewer; clear a stale (terminated) index.
	const existing = await store.get(reviewerKey(parent, canonicalKey));
	if (existing && typeof existing === "object" && existing.childSessionId) {
		let agentStatus = "terminated";
		try { agentStatus = (await ctx.host.agents.status(existing.childSessionId)).status; }
		catch { agentStatus = "terminated"; }
		if (agentStatus !== "terminated") {
			const binding = await store.get(bindingKey(existing.childSessionId));
			if (binding && typeof binding === "object" && binding.kickedOff === false) {
				// Bound-but-not-started child: re-issue the deterministic kickoff so the
				// panel never polls a never-started child forever.
				await ctx.host.agents.prompt(existing.childSessionId, kickoff);
				await store.put(bindingKey(existing.childSessionId), { ...binding, kickedOff: true });
			}
			return {
				ok: true,
				created: false,
				jobId: existing.jobId,
				childSessionId: existing.childSessionId,
				changesetId: binding ? binding.changesetId : undefined,
				baseSha: binding ? binding.baseSha : undefined,
				headSha: binding ? binding.headSha : undefined,
				status: binding ? binding.status : "running",
			};
		}
		await softDelete(store, reviewerKey(parent, canonicalKey));
	}

	// Step 3: spawn the visible, NOT-yet-started reviewer (bounded auto-retry).
	const jobId = `prw-${randomUUID()}`;
	const changesetId = changesetIdForTarget(target);
	let childSessionId;
	try {
		const spawned = await spawnReviewerWithRetry(ctx, {
			role: "pr-reviewer",
			readOnly: true,
			lifecycle: "full",
			deferInitialPrompt: true,
			instructions: kickoff,
			context: contextForTarget(target),
		});
		childSessionId = spawned && spawned.childSessionId;
	} catch (e) {
		return { ok: false, retryable: true, error: messageOf(e), code: spawnErrorCode(e) };
	}
	if (!childSessionId) {
		return { ok: false, retryable: true, error: "spawn returned no childSessionId", code: "SPAWN_FAILED" };
	}

	// Step 4: all post-spawn steps in ONE try/catch — COMPENSATE on any failure.
	const bindingBase = {
		jobId,
		changesetId,
		baseSha: target.baseSha,
		headSha: target.headSha,
		parentSessionId: parent,
		canonicalKey,
		target,
		status: "running",
	};
	try {
		await store.put(bindingKey(childSessionId), { ...bindingBase, kickedOff: false });
		await store.put(reviewerKey(parent, canonicalKey), { childSessionId, jobId });
		await ctx.host.agents.prompt(childSessionId, kickoff);
		await store.put(bindingKey(childSessionId), { ...bindingBase, kickedOff: true });
	} catch (e) {
		try { await ctx.host.agents.dismiss(childSessionId); } catch { /* no orphaned visible child */ }
		await softDelete(store, bindingKey(childSessionId));
		await softDelete(store, reviewerKey(parent, canonicalKey));
		return { ok: false, retryable: true, error: messageOf(e), code: "LAUNCH_FAILED" };
	}

	// Step 5
	return {
		ok: true,
		created: true,
		jobId,
		childSessionId,
		changesetId,
		baseSha: target.baseSha,
		headSha: target.headSha,
		status: "running",
	};
}

async function spawnReviewerWithRetry(ctx, spawnOpts) {
	let lastErr;
	for (let attempt = 0; attempt < SPAWN_MAX_ATTEMPTS; attempt++) {
		try {
			return await ctx.host.agents.spawn(spawnOpts);
		} catch (e) {
			lastErr = e;
			if (isNonTransientSpawnError(e)) throw e;
			if (attempt < SPAWN_MAX_ATTEMPTS - 1) await sleep(150 * (attempt + 1));
		}
	}
	throw lastErr;
}

function isNonTransientSpawnError(err) {
	return /ROLE_TOOLS_UNRESOLVED/.test(messageOf(err));
}

function spawnErrorCode(err) {
	return /ROLE_TOOLS_UNRESOLVED/.test(messageOf(err)) ? "ROLE_TOOLS_UNRESOLVED" : "SPAWN_FAILED";
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The host.store API exposes only get/put/list (NO delete), so a logical delete is
// a null tombstone: store.get returns null for a null-valued key, which every
// reader here treats as "absent". Bounded by the per-pack key quota.
async function softDelete(store, key) {
	try { await store.put(key, null); } catch { /* best-effort */ }
}

function messageOf(err) {
	return err && err.message ? String(err.message) : String(err);
}

function contextForTarget(target) {
	const out = { target: target.canonicalKey };
	if (target.prUrl) out.prUrl = target.prUrl;
	return out;
}

// Ported from buildKickoffPrompt (walkthrough-agent-manager.ts) — the PER-TARGET
// kickoff. The REQUIRED_YAML_SCHEMA_PROMPT is NOT repeated here: the pr-reviewer
// role's promptTemplate carries it (design Decision B static/per-target split).
function buildKickoffPrompt(target) {
	return [
		`Review target: ${target.canonicalKey}`,
		target.prUrl ? `PR URL: ${target.prUrl}` : undefined,
		target.baseSha && target.headSha ? `Range: ${target.baseSha}..${target.headSha}` : undefined,
		"Start by calling read_pr_walkthrough_bundle in manifest mode, then say you are beginning the investigation with an approximate progress percentage.",
		"Treat the persisted bundle as authoritative for PR body, SHAs, stats, files, hunks, warnings, and limits.",
		"Populate the panel only by calling submit_pr_walkthrough_yaml with valid YAML. Stay available after success.",
	].filter(Boolean).join("\n");
}

// Whether the run body carries a target the caller chose explicitly (a deep-link
// or test). When false, the run route resolves the current branch's open GitHub
// PR instead (the primary launch path). A bare prUrl/prNumber or a baseSha+headSha
// pair counts as explicit; an empty body does not.
function hasExplicitTarget(body) {
	if (!body || typeof body !== "object") return false;
	if (strOf(body.prUrl)) return true;
	if (numberValue(body.prNumber) !== undefined) return true;
	if (strOf(body.baseSha) && strOf(body.headSha)) return true;
	return false;
}

// Resolve the current branch's open GitHub PR from the SERVER-DERIVED worker cwd
// (never caller-supplied — same confinement as bundle's git cwd). Uses `gh` for the
// PR metadata + `git` for the SHAs, then hands the assembled fields to
// canonicalizeTarget (the caller) to build the github canonical target/changeset.
// Returns { ok:false, code:"NO_PR" } when the branch has no open GitHub PR so the
// panel can surface a clear "open a PR first" message. The walkthrough is
// GitHub-PR-only; local base/head targets are not resolved here.
async function resolveCurrentBranchTarget(cwd) {
	const noPr = {
		ok: false,
		retryable: false,
		error: "No open GitHub PR for the current branch. Open a PR, then run the walkthrough.",
		code: "NO_PR",
	};

	let pr;
	try {
		const out = await gh(cwd, ["pr", "view", "--json", "number,url,headRefOid,baseRefName,headRefName"]);
		pr = JSON.parse(String(out).trim());
	} catch {
		return noPr; // gh non-zero / no PR for branch / gh unavailable
	}
	if (!pr || typeof pr !== "object" || !Number.isInteger(pr.number)) return noPr;

	// owner/repo from `gh repo view`, falling back to the origin remote.
	let owner;
	let repo;
	try {
		const repoOut = await gh(cwd, ["repo", "view", "--json", "owner,name"]);
		const repoJson = JSON.parse(String(repoOut).trim());
		owner = repoJson && repoJson.owner ? strOf(repoJson.owner.login) : undefined;
		repo = repoJson ? strOf(repoJson.name) : undefined;
	} catch { /* fall back to origin remote below */ }
	if (!owner || !repo) {
		const inferred = await inferGithubRepository(cwd);
		if (inferred) {
			owner = owner || inferred.owner;
			repo = repo || inferred.repo;
		}
	}

	// headSha: the PR head commit (headRefOid), else the worktree HEAD.
	let headSha = strOf(pr.headRefOid);
	if (!headSha) {
		headSha = await git(cwd, ["rev-parse", "HEAD"]).then((s) => s.trim()).catch(() => undefined);
	}
	// baseSha: the PR base branch tip — prefer origin/<base>, else the local ref,
	// else the merge-base with HEAD.
	let baseSha;
	const baseRef = strOf(pr.baseRefName);
	if (baseRef) {
		baseSha = await git(cwd, ["rev-parse", `origin/${baseRef}`]).then((s) => s.trim()).catch(() => undefined);
		if (!baseSha) baseSha = await git(cwd, ["rev-parse", baseRef]).then((s) => s.trim()).catch(() => undefined);
		if (!baseSha && headSha) {
			baseSha = await git(cwd, ["merge-base", `origin/${baseRef}`, "HEAD"]).then((s) => s.trim()).catch(() => undefined);
		}
	}

	return {
		ok: true,
		target: {
			owner,
			repo,
			prNumber: pr.number,
			prUrl: strOf(pr.url),
			baseSha,
			headSha,
		},
	};
}

// Ported PURE target canonicalization (canonicalizeTarget from
// walkthrough-agent-manager.ts). The pack worker cannot import src/server or
// src/shared (pack-root confinement), so the logic is inlined. canonicalKey is the
// idempotency key; number-only GitHub targets infer owner/repo/host from the
// SERVER-DERIVED session worktree's origin remote (never caller-supplied).
async function canonicalizeTarget(input, cwd) {
	const prUrl = strOf(input.prUrl);
	const parsed = prUrl ? parseGithubPrUrl(prUrl) : undefined;
	let owner = strOf(input.owner) || (parsed && parsed.owner);
	let repo = strOf(input.repo) || (parsed && parsed.repo);
	const number = numberValue(input.prNumber) ?? (parsed ? parsed.number : undefined);
	const baseSha = strOf(input.baseSha);
	const headSha = strOf(input.headSha);
	let host = normalizeGithubHost(parsed && parsed.host);

	if (number !== undefined && (!owner || !repo)) {
		const inferred = await inferGithubRepository(cwd);
		if (inferred) {
			owner = owner || inferred.owner;
			repo = repo || inferred.repo;
			host = normalizeGithubHost(inferred.host);
		}
	}

	if (owner && repo && number !== undefined) {
		const url = prUrl || `https://${host}/${owner}/${repo}/pull/${number}`;
		const canonicalKey = host === "github.com"
			? `github:${owner}/${repo}#${number}`
			: `github:${host}/${owner}/${repo}#${number}`;
		return { provider: "github", prUrl: url, owner, repo, number, baseSha, headSha, host, canonicalKey };
	}
	if (number !== undefined) {
		return { provider: "github", prUrl, number, baseSha, headSha, host: "github.com", canonicalKey: `github:unknown/unknown#${number}` };
	}
	if (baseSha && headSha) {
		return { provider: "local", baseSha, headSha, canonicalKey: `local:${baseSha}..${headSha}` };
	}
	throw new Error("A GitHub PR URL/number or local baseSha/headSha is required");
}

// Ported changesetIdForTarget: github → changesetIdForGithub (matches
// src/shared/pr-walkthrough/ids.ts), local → changesetIdForLocal (already inlined).
function changesetIdForTarget(target) {
	if (target.provider === "github") {
		return changesetIdForGithub(target.owner || "unknown", target.repo || "unknown", target.number ?? "unknown", target.headSha);
	}
	return changesetIdForLocal(target.baseSha || "unknown", target.headSha || "unknown");
}

function changesetIdForGithub(owner, repo, number, headSha) {
	return `github:${String(owner).trim()}/${String(repo).trim()}#${String(number).trim()}:${headSha ? shortSha(headSha) : "unknown"}`;
}

function parseGithubPrUrl(input) {
	try {
		const url = new URL(input);
		const host = url.hostname.replace(/\.$/, "").toLowerCase();
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length >= 4 && parts[2] === "pull") {
			const number = Number(parts[3]);
			if (Number.isInteger(number) && number > 0) return { owner: parts[0], repo: parts[1], number, host };
		}
	} catch { /* not a URL */ }
	return undefined;
}

function normalizeGithubHost(host) {
	const normalized = (host || "github.com").replace(/\.$/, "").toLowerCase();
	return normalized === "www.github.com" ? "github.com" : normalized;
}

function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

// Infer owner/repo/host from the session worktree's origin remote (server-derived
// cwd, never caller-supplied) for number-only GitHub launches.
async function inferGithubRepository(cwd) {
	try {
		const out = await git(cwd, ["remote", "get-url", "origin"]);
		return parseGithubRemoteUrl(String(out).trim());
	} catch {
		return undefined;
	}
}

function parseGithubRemoteUrl(url) {
	if (!url) return undefined;
	// scp-like: git@host:owner/repo(.git)
	const scp = url.match(/^[^@]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
	if (scp) return { host: scp[1].toLowerCase(), owner: scp[2], repo: scp[3] };
	try {
		const u = new URL(url);
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length >= 2) {
			return { host: u.hostname.replace(/\.$/, "").toLowerCase(), owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
		}
	} catch { /* not a URL */ }
	return undefined;
}
