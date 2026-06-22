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
import { mapYamlToWalkthroughPayload, parsePrWalkthroughYamlValue, validatePrWalkthroughYaml } from "./yaml-to-cards.mjs";

const STORE_SCHEMA_VERSION = 1;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;

const jobKey = (jobId) => `job/${jobId}`;
// LLM-enhanced cards persisted at submit time are keyed by the STRUCTURAL changeset
// id (base..head) so a freshly-recomputed bundle for the same range finds them.
const cardsKey = (changesetId) => `cards/${b64url(changesetId)}`;

// ── host.agents reviewer migration (design Decisions C/D/E) — pack-store keys. ──
// The reviewer child is a real, isolated, read-only principal minted by the `run`
// route via host.agents.spawn (replacing the old host.session.postMessage hijack).
// Routing lives entirely in these pack-scoped keys (the legacy WalkthroughAgentStore
// + submit-proof secret are gone):
//   binding/<childSessionId> → { jobId, changesetId, baseSha, headSha,
//                                parentSessionId, canonicalKey, target,
//                                status, kickedOff }
//   submitted/<jobId>        → { yaml, baseSha, headSha, submittedAt }
// ALWAYS-FRESH (launch UX correction): there is NO `reviewer/<parent>/<key>`
// idempotency index and NO `last/<owner>` pointer any more. Every `run` spawns a
// NEW reviewer (the only double-spawn guard is the client's within-gesture guard);
// the walkthrough is viewable ONLY inside the reviewer child session, so no
// owner-scoped recover pointer exists. status ∈ running|submitted|error.
const bindingKey = (childSessionId) => `binding/${childSessionId}`;
const submittedKey = (jobId) => `submitted/${jobId}`;
const reviewerIndexKey = (sessionId) => `reviewers/${sessionId}`;
const reviewPrefix = (jobId) => `reviews/${jobId}/`;
const reviewBindingKey = (jobId, childSessionId) => `${reviewPrefix(jobId)}binding/${childSessionId}`;
const draftPrefix = (jobId) => `${reviewPrefix(jobId)}draft/`;
const finalPrefix = (jobId) => `${reviewPrefix(jobId)}final/`;
const stagingPrefix = (jobId) => `${reviewPrefix(jobId)}staging/`;
const chunkPrefix = (jobId) => `${draftPrefix(jobId)}chunks/`;
const chunkKey = (jobId, chunkId) => `${chunkPrefix(jobId)}${chunkId}`;
const draftStatusKey = (jobId) => `${draftPrefix(jobId)}status`;
const draftCheckpointKey = (jobId) => `${draftPrefix(jobId)}checkpoint`;
const finalPayloadKey = (jobId) => `${finalPrefix(jobId)}payload`;

const DRAFT_QUOTA = (jobId) => ({ quotaScope: { prefix: draftPrefix(jobId), profile: "review-draft" } });
const FINAL_QUOTA = (jobId) => ({ quotaScope: { prefix: finalPrefix(jobId), profile: "review-final" } });
const REVIEW_BINDING_QUOTA = (jobId) => ({ quotaScope: { prefix: reviewPrefix(jobId), profile: "default" } });
const REVIEWER_INDEX_QUOTA = (sessionId) => ({ quotaScope: { prefix: reviewerIndexKey(sessionId), profile: "default" } });
const CHUNK_ID_PATTERN = /^(?:metadata|context|merge_assessment|omissions_and_followups|audit|display|document|decision:[A-Za-z0-9_.-]+|chunk:[A-Za-z0-9_.-]+)$/;
const DEFAULT_PHASE_ORDER = ["orientation", "design", "significant", "other", "audit"];

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

		const finalAccess = await authorizeReviewAccess(ctx.host.store, jobId, ctx);
		const finalPayload = finalAccess.authorized ? await ctx.host.store.get(finalPayloadKey(jobId)) : null;
		if (isFinalPayload(finalPayload)) {
			return finalBundleResult(finalPayload, jobId);
		}
		if (!finalAccess.authorized && await hasFinalPayload(ctx.host.store, jobId)) {
			return { found: false, jobId, code: "PRW_REVIEW_UNAUTHORIZED", error: "This session is not authorized to read that PR walkthrough." };
		}

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
		try {
			if (body.op === "submitChunk") return await submitPrWalkthroughChunk(ctx, body);
			if (body.op === "submissionStatus") return await readPrWalkthroughSubmissionStatus(ctx, body);
			if (body.op === "finalizeSubmission") return await finalizePrWalkthroughSubmission(ctx, body);
			if (body.op === "submitYaml") return await submitPrWalkthroughYamlCompat(ctx, body);
			return await publishYamlCompat(ctx, body);
		} catch (err) {
			return structuredErrorResult(err, body);
		}
	},

	// ── run ──────────────────────────────────────────────────────────────────────
	// Mints a REAL, isolated, read-only reviewer child via host.agents.spawn (NOT
	// host.session.postMessage — the user's own agent is never driven). Input:
	//   { prUrl } | { owner, repo, prNumber } | { baseSha, headSha }
	// Failure-atomic (compensates on any post-spawn failure). The bound owner is
	// ctx.sessionId (host.agents children are owner-scoped).
	//
	// ALWAYS-FRESH (launch UX correction, Q4): every `run` spawns a NEW reviewer,
	// even for the SAME PR — there is no target-based idempotency dedup any more (the
	// old reviewerKey index + cross-worker reconcile are gone). Multiple reviewers per
	// PR are allowed; the user terminates extras. The ONLY double-spawn protection is
	// the client launcher's within-gesture guard (a single click cannot double-spawn).
	//
	// Returns either
	//   { ok:true, created:true, jobId, childSessionId, changesetId, baseSha, headSha, status } or
	//   { ok:false, retryable, error, code }   (the launcher surfaces the inline error).
	run: async (ctx, req) => {
		const body = (req && req.body) || {};
		const parent = strOf(ctx && ctx.sessionId);
		if (!parent) return { ok: false, retryable: false, error: "missing bound session", code: "NO_SESSION" };

		// When the body carries NO usable explicit target (the primary launch path:
		// every launch surface calls `run` with an EMPTY body via the spawn launcher),
		// resolve the current branch's open GitHub PR from the SERVER-DERIVED worker cwd
		// via gh/git. An explicit target in the body always wins (deep-links / tests);
		// only resolve-from-branch when absent.
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
		// The walkthrough is GitHub-PR-only: the production YAML schema requires
		// pr.provider "github" and submit-yaml enforces target.provider === pr.provider,
		// so a LOCAL ({baseSha,headSha}-only) target would spawn a reviewer that can
		// NEVER submit. Reject it BEFORE any spawn/binding write. (A github target via
		// prUrl/owner/repo/number — possibly with SHAs — is still accepted, and the
		// resolve-from-current-branch path above still applies when no target is given.)
		if (target.provider !== "github") {
			return { ok: false, retryable: false, error: "PR walkthrough supports GitHub pull requests only.", code: "LOCAL_UNSUPPORTED" };
		}
		const canonicalKey = target.canonicalKey;
		// ALWAYS-FRESH: spawn a brand-new reviewer on every call (no dedup index, no
		// in-flight await). The client within-gesture guard prevents a double-click.
		return await launchReviewer(ctx, parent, target, canonicalKey);
	},

	// ── status ───────────────────────────────────────────────────────────────────
	// BINDING-AUTHORITATIVE poll. Input { childSessionId, jobId }. Loads the binding
	// FIRST and verifies jobId + (parentSessionId===ctx.sessionId OR the caller IS
	// the bound child) before reading anything else (no probing an arbitrary job's
	// submitted marker). Completion is the pack-store submitted-YAML marker, NOT the
	// agent's idle status. Returns
	//   { phase:"running", agentStatus? } | { phase:"submitted", yaml, baseSha, headSha }
	//   | { phase:"error", agentStatus?, error }.
	//
	// FINDING 2 — the CHILD-SELF poll. The server host API only permits
	// host.agents.status for children OWNED by the bound session. When the reviewer
	// CHILD polls its OWN pane (ctx.sessionId === childSessionId, i.e. isChild &&
	// !isOwner), `ctx.host.agents.status(childSessionId)` is DENIED — caught here as
	// "terminated" — which would mark the LIVE reviewer's binding `error` and return
	// phase:"error" even though the reviewer is alive. So for the child-self caller we
	// do NOT call host.agents.status: the phase is derived PURELY from the submitted
	// marker (submitted if present, else running). The OWNER path is unchanged (it
	// still uses host.agents.status to detect terminated-without-submit → error).
	status: async (ctx, req) => {
		const body = (req && req.body) || {};
		const childSessionId = strOf(body.childSessionId);
		const requestedJobId = strOf(body.jobId);
		const store = ctx.host.store;
		if (!childSessionId || !requestedJobId) {
			return { phase: "error", error: "childSessionId and jobId are required", code: "PRW_STATUS_REQUEST_INVALID" };
		}

		const binding = await loadReviewerBinding(store, childSessionId, requestedJobId);
		const isOwner = !!binding && binding.parentSessionId === ctx.sessionId;
		const isChild = childSessionId === ctx.sessionId;
		if (!binding || binding.jobId !== requestedJobId || !(isOwner || isChild)) {
			return { phase: "error", error: "unknown or mismatched binding", code: "PRW_MISSING_BINDING" };
		}
		if (ctx?.sessionArchived === true) {
			return { phase: "error", code: "PRW_REVIEWER_ARCHIVED", error: "The reviewer session is archived.", jobId: binding.jobId };
		}

		const finalPayload = await store.get(finalPayloadKey(binding.jobId));
		if (isFinalPayload(finalPayload)) {
			return finalSubmittedStatus(finalPayload, binding);
		}
		const legacySubmitted = await store.get(submittedKey(binding.jobId));
		if (legacySubmitted && typeof legacySubmitted === "object" && strOf(legacySubmitted.yaml)) {
			return { phase: "submitted", yaml: legacySubmitted.yaml, baseSha: binding.baseSha ?? legacySubmitted.baseSha, headSha: binding.headSha ?? legacySubmitted.headSha, jobId: binding.jobId };
		}

		const chunkSummary = await summarizeChunks(store, binding.jobId);
		if (chunkSummary.chunks.length > 0) {
			return { phase: "draft", jobId: binding.jobId, chunkSummary, baseSha: binding.baseSha, headSha: binding.headSha };
		}

		if (isChild && !isOwner) return { phase: "running" };

		let agentStatus = "preparing";
		try { agentStatus = (await ctx.host.agents.status(childSessionId)).status; }
		catch { agentStatus = "terminated"; }
		if (agentStatus === "terminated") {
			try { await store.put(reviewBindingKey(binding.jobId, childSessionId), { ...binding, status: "error" }, REVIEW_BINDING_QUOTA(binding.jobId)); } catch { /* status reporting must not fail on store quota */ }
			return { phase: "error", agentStatus, error: "The reviewer terminated without producing a walkthrough.", code: "PRW_REVIEWER_TERMINATED" };
		}
		return { phase: "running", agentStatus };
	},

	// ── recover ──────────────────────────────────────────────────────────────────
	// CHILD-SELF reload recovery. The walkthrough is viewable ONLY inside the reviewer
	// sub-agent session. On a browser reload of that child session `byJob` is empty, so
	// the child pane re-resolves the submitted YAML from its OWN
	// binding/<childSessionId> (no new store key): read the submitted YAML keyed by
	// that binding's jobId; the panel re-publishes it idempotently and re-renders the
	// cards. Authorization-correct — only the bound child can resolve its own
	// binding/<me>, and the submitted YAML is keyed by that binding's verified jobId.
	// There is NO owner branch any more (no owner-session surface, no last/<owner>
	// pointer); keyed by ctx.sessionId; never auto-invoked from a non-child pane.
	recover: async (ctx, _req) => {
		const me = strOf(ctx && ctx.sessionId);
		if (!me) return { found: false, code: "PRW_REVIEW_MISSING" };
		const store = ctx.host.store;
		const selfBinding = await loadReviewerBinding(store, me);
		if (!selfBinding) return { found: false, code: "PRW_REVIEW_MISSING", error: "Walkthrough data expired or was cleaned up. Start a new walkthrough." };
		const finalPayload = await store.get(finalPayloadKey(selfBinding.jobId));
		if (isFinalPayload(finalPayload)) {
			return {
				found: true,
				finalized: true,
				jobId: selfBinding.jobId,
				changesetId: finalPayload.changesetId,
				finalizedAt: finalPayload.finalizedAt,
				yaml: finalPayload.yaml,
				baseSha: finalPayload.baseSha ?? selfBinding.baseSha,
				headSha: finalPayload.headSha ?? selfBinding.headSha,
			};
		}
		const legacySubmitted = await store.get(submittedKey(selfBinding.jobId));
		if (legacySubmitted && typeof legacySubmitted === "object" && strOf(legacySubmitted.yaml)) {
			return {
				found: true,
				jobId: selfBinding.jobId,
				yaml: legacySubmitted.yaml,
				baseSha: selfBinding.baseSha ?? legacySubmitted.baseSha,
				headSha: selfBinding.headSha ?? legacySubmitted.headSha,
			};
		}
		const chunkSummary = await summarizeChunks(store, selfBinding.jobId);
		if (chunkSummary.chunks.length > 0) {
			return { found: false, phase: "draft", jobId: selfBinding.jobId, chunkSummary, code: "PRW_REVIEW_DRAFT", error: "Walkthrough analysis is saved but not finalized yet." };
		}
		return { found: false, phase: "running", jobId: selfBinding.jobId, baseSha: selfBinding.baseSha, headSha: selfBinding.headSha, code: "PRW_REVIEW_RUNNING" };
	},
};

function prwError(code, error, details, status = 400) {
	const err = new Error(error);
	err.code = code;
	err.details = details;
	err.status = status;
	return err;
}

function structuredErrorResult(err, body = {}) {
	const message = messageOf(err);
	const code = err && typeof err === "object" && typeof err.code === "string"
		? err.code
		: (/quota|too large|maxTotalBytes|STORE_QUOTA/i.test(message) ? "STORE_QUOTA_EXCEEDED" : "PRW_ROUTE_FAILED");
	return { ok: false, code, error: message, details: err && typeof err === "object" ? err.details : undefined, jobId: normalizeJobId(body.jobId) };
}

function isObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseYamlValue(yamlText, label = "YAML") {
	const text = String(yamlText ?? "").trim();
	if (!text) return null;
	try {
		const value = parsePrWalkthroughYamlValue(text);
		return value === undefined ? null : value;
	} catch (err) {
		throw prwError("PRW_CHUNK_INVALID", `${label} must be valid YAML.`, { message: messageOf(err) });
	}
}

function validateChunkId(sectionId) {
	const id = strOf(sectionId);
	if (!id || !CHUNK_ID_PATTERN.test(id)) {
		throw prwError("PRW_CHUNK_ID_INVALID", "section_id must be metadata, context, merge_assessment, omissions_and_followups, audit, display, document, decision:<id>, or chunk:<id>.", { sectionId });
	}
	return id;
}

function chunkKind(id) {
	if (id.startsWith("decision:")) return "decision";
	if (id.startsWith("chunk:")) return "review_chunk";
	if (id === "omissions_and_followups") return "omissions";
	return id;
}

function lightValidateChunk(id, yamlText) {
	const value = parseYamlValue(yamlText, id);
	if ((id === "omissions_and_followups") && !Array.isArray(value)) throw prwError("PRW_CHUNK_INVALID", "omissions_and_followups must be a YAML array.");
	if ((id.startsWith("decision:") || id.startsWith("chunk:")) && !isObject(value)) throw prwError("PRW_CHUNK_INVALID", `${id} must be a YAML mapping.`);
	if (["metadata", "context", "merge_assessment", "audit", "display"].includes(id) && !isObject(value)) throw prwError("PRW_CHUNK_INVALID", `${id} must be a YAML mapping.`);
	if (id === "document") {
		const validation = validatePrWalkthroughYaml(String(yamlText));
		if (!validation.ok) throw prwError("PRW_SCHEMA_INVALID", "PR walkthrough document failed validation.", validation.summary);
	}
	return value;
}

async function loadReviewerBinding(store, sessionId, expectedJobId) {
	const indexed = await store.get(reviewerIndexKey(sessionId));
	const indexedJobId = indexed && typeof indexed === "object" ? strOf(indexed.jobId) : undefined;
	const jobId = expectedJobId || indexedJobId;
	if (jobId) {
		const scoped = await store.get(reviewBindingKey(jobId, sessionId));
		if (scoped && typeof scoped === "object") return scoped;
	}
	const legacy = await store.get(bindingKey(sessionId));
	if (legacy && typeof legacy === "object") return legacy;
	return undefined;
}

async function resolveReviewerBinding(ctx, body = {}) {
	const sessionId = strOf(ctx && ctx.sessionId);
	if (!sessionId) throw prwError("PRW_MISSING_BINDING", "No bound reviewer session is available.", undefined, 403);
	const binding = await loadReviewerBinding(ctx.host.store, sessionId, strOf(body.jobId));
	if (!binding || !strOf(binding.jobId)) throw prwError("PRW_MISSING_BINDING", "Caller is not a bound PR-walkthrough reviewer.", undefined, 403);
	return { sessionId, binding };
}

function ctxPrincipals(ctx) {
	return new Set([
		strOf(ctx?.sessionId),
		strOf(ctx?.ownerSessionId),
		strOf(ctx?.principalId),
		strOf(ctx?.userId),
		strOf(ctx?.host?.principal?.id),
	].filter(Boolean));
}

function bindingAuthorizes(binding, reviewerSessionId, principals, jobId) {
	if (!binding || typeof binding !== "object") return false;
	const bindingJobId = strOf(binding.jobId);
	if (bindingJobId && bindingJobId !== jobId) return false;
	for (const principal of principals) {
		if (principal === reviewerSessionId) return true;
		if (principal === strOf(binding.parentSessionId)) return true;
		if (principal === strOf(binding.ownerSessionId)) return true;
		if (principal === strOf(binding.intendedOwnerSessionId)) return true;
	}
	return false;
}

async function authorizeReviewAccess(store, jobId, ctx) {
	const principals = ctxPrincipals(ctx);
	const sessionId = strOf(ctx?.sessionId);
	if (principals.size === 0) return { authorized: false };
	if (sessionId) {
		const direct = await loadReviewerBinding(store, sessionId, jobId);
		if (bindingAuthorizes(direct, sessionId, principals, jobId)) return { authorized: true, binding: direct };
	}
	const scopedPrefix = `${reviewPrefix(jobId)}binding/`;
	const scopedKeys = await store.list(scopedPrefix).catch(() => []);
	if (Array.isArray(scopedKeys)) {
		for (const key of scopedKeys) {
			const reviewerSessionId = key.startsWith(scopedPrefix) ? key.slice(scopedPrefix.length) : undefined;
			if (!reviewerSessionId || reviewerSessionId.includes("/")) continue;
			const binding = await store.get(key).catch(() => null);
			if (bindingAuthorizes(binding, reviewerSessionId, principals, jobId)) return { authorized: true, binding };
		}
	}
	const legacyKeys = await store.list("binding/").catch(() => []);
	if (Array.isArray(legacyKeys)) {
		for (const key of legacyKeys) {
			const reviewerSessionId = key.startsWith("binding/") ? key.slice("binding/".length) : undefined;
			if (!reviewerSessionId || reviewerSessionId.includes("/")) continue;
			const binding = await store.get(key).catch(() => null);
			if (bindingAuthorizes(binding, reviewerSessionId, principals, jobId)) return { authorized: true, binding };
		}
	}
	return { authorized: false };
}

async function hasFinalPayload(store, jobId) {
	return isFinalPayload(await store.get(finalPayloadKey(jobId)).catch(() => null));
}

async function submitPrWalkthroughChunk(ctx, body) {
	const { binding } = await resolveReviewerBinding(ctx, body);
	const id = validateChunkId(body.section_id ?? body.sectionId);
	const yamlText = typeof body.yaml === "string" ? body.yaml : undefined;
	if (!yamlText) throw prwError("PRW_CHUNK_INVALID", "yaml is required.");
	lightValidateChunk(id, yamlText);
	const record = { schemaVersion: STORE_SCHEMA_VERSION, id, kind: chunkKind(id), yaml: yamlText, updatedAt: Date.now(), bytes: Buffer.byteLength(yamlText, "utf-8") };
	await ctx.host.store.put(chunkKey(binding.jobId, id), record, DRAFT_QUOTA(binding.jobId));
	const chunkSummary = await summarizeChunks(ctx.host.store, binding.jobId);
	await ctx.host.store.put(draftStatusKey(binding.jobId), { schemaVersion: STORE_SCHEMA_VERSION, jobId: binding.jobId, updatedAt: Date.now(), chunkSummary }, DRAFT_QUOTA(binding.jobId));
	return { ok: true, status: "chunk_saved", jobId: binding.jobId, chunk: summarizeChunkRecord(record), chunkSummary };
}

async function readPrWalkthroughSubmissionStatus(ctx, body = {}) {
	const { binding } = await resolveReviewerBinding(ctx, body);
	const finalPayload = await ctx.host.store.get(finalPayloadKey(binding.jobId));
	const chunkSummary = await summarizeChunks(ctx.host.store, binding.jobId);
	return {
		ok: true,
		jobId: binding.jobId,
		phase: isFinalPayload(finalPayload) ? "submitted" : (chunkSummary.chunks.length ? "draft" : "running"),
		finalized: isFinalPayload(finalPayload),
		finalizedAt: isFinalPayload(finalPayload) ? finalPayload.finalizedAt : undefined,
		chunkSummary,
	};
}

async function submitPrWalkthroughYamlCompat(ctx, body) {
	const { binding } = await resolveReviewerBinding(ctx, body);
	const existing = await readChunkRecords(ctx.host.store, binding.jobId);
	const sectionChunks = existing.filter((record) => record.id !== "document");
	if (sectionChunks.length > 0) {
		throw prwError(
			"PRW_CHUNK_CONFLICT",
			"submit_pr_walkthrough_yaml cannot be used after incremental chunks have been saved; continue with finalize_pr_walkthrough_submission or start a new review.",
			{ savedChunks: sectionChunks.map((record) => record.id) },
		);
	}
	const saved = await submitPrWalkthroughChunk(ctx, { ...body, section_id: "document", jobId: binding.jobId });
	const finalized = await finalizePrWalkthroughSubmission(ctx, { ...body, jobId: binding.jobId });
	return { ...finalized, savedChunk: saved.chunk };
}

async function finalizePrWalkthroughSubmission(ctx, body = {}) {
	const { binding } = await resolveReviewerBinding(ctx, body);
	const assembled = await assembleSubmission(ctx.host.store, binding);
	const finalPayload = await buildFinalPayload(ctx, binding, assembled.yaml, body);
	await ctx.host.store.put(finalPayloadKey(binding.jobId), finalPayload, FINAL_QUOTA(binding.jobId));
	await bestEffortDeletePrefix(ctx.host.store, stagingPrefix(binding.jobId));
	await bestEffortDeletePrefix(ctx.host.store, draftPrefix(binding.jobId));
	try { await ctx.host.store.put(bindingKey(ctx.sessionId), { ...binding, status: "submitted" }); } catch { /* legacy marker best-effort */ }
	return { ok: true, status: "submitted", jobId: binding.jobId, changesetId: finalPayload.changesetId, finalizedAt: finalPayload.finalizedAt, cardCount: finalPayload.cardCount };
}

async function publishYamlCompat(ctx, body) {
	const jobId = normalizeJobId(body.jobId);
	const yamlText = strOf(body.yaml);
	const access = await authorizeReviewAccess(ctx.host.store, jobId, ctx);
	if (!yamlText) {
		if (!access.authorized) return { ok: true, jobId, changesetId: strOf(body.changesetId) || jobId, cardCount: 0 };
		const finalPayload = await ctx.host.store.get(finalPayloadKey(jobId));
		return { ok: true, jobId, changesetId: isFinalPayload(finalPayload) ? finalPayload.changesetId : strOf(body.changesetId) || jobId, persistedAt: isFinalPayload(finalPayload) ? finalPayload.persistedAt : undefined, cardCount: isFinalPayload(finalPayload) ? finalPayload.cardCount : 0 };
	}
	if (access.authorized) {
		const finalPayload = await buildFinalPayload(ctx, access.binding || await bindingForPublish(ctx.host.store, jobId, body), yamlText, body);
		await ctx.host.store.put(finalPayloadKey(jobId), finalPayload, FINAL_QUOTA(jobId));
		return { ok: true, jobId, changesetId: finalPayload.changesetId, persistedAt: finalPayload.persistedAt, finalizedAt: finalPayload.finalizedAt, cardCount: finalPayload.cardCount };
	}
	const legacyBinding = await bindingForPublish(ctx.host.store, jobId, body, { skipFinalPayload: true });
	const legacyPayload = await buildFinalPayload(ctx, legacyBinding, yamlText, { ...body, skipExistingFinalRead: true });
	await writeLegacyPublishArtifacts(ctx.host.store, jobId, legacyPayload);
	return { ok: true, jobId, changesetId: legacyPayload.changesetId, persistedAt: legacyPayload.persistedAt, finalizedAt: legacyPayload.finalizedAt, cardCount: legacyPayload.cardCount, legacy: true };
}

async function bindingForPublish(store, jobId, body, opts = {}) {
	const existingFinal = opts.skipFinalPayload ? null : await store.get(finalPayloadKey(jobId));
	const legacyJob = await store.get(jobKey(jobId));
	return {
		jobId,
		changesetId: strOf(body.changesetId) || (isFinalPayload(existingFinal) ? existingFinal.changesetId : undefined) || (legacyJob && typeof legacyJob === "object" ? strOf(legacyJob.changesetId) : undefined) || jobId,
		baseSha: strOf(body.baseSha) || (legacyJob && typeof legacyJob === "object" ? strOf(legacyJob.baseSha) : undefined),
		headSha: strOf(body.headSha) || (legacyJob && typeof legacyJob === "object" ? strOf(legacyJob.headSha) : undefined),
		target: undefined,
	};
}

async function writeLegacyPublishArtifacts(store, jobId, payload) {
	await store.put(cardsKey(payload.changesetId), {
		schemaVersion: STORE_SCHEMA_VERSION,
		changesetId: payload.changesetId,
		changeset: payload.changeset,
		cards: payload.cards,
		warnings: payload.warnings || [],
		persistedAt: payload.persistedAt,
	});
	await store.put(jobKey(jobId), {
		schemaVersion: STORE_SCHEMA_VERSION,
		jobId,
		changesetId: payload.changesetId,
		baseSha: payload.baseSha,
		headSha: payload.headSha,
		persistedAt: payload.persistedAt,
	});
}

async function readChunkRecords(store, jobId) {
	const keys = await store.list(chunkPrefix(jobId));
	const records = [];
	for (const key of keys) {
		const rec = await store.get(key);
		if (rec && typeof rec === "object" && strOf(rec.id) && typeof rec.yaml === "string") records.push(rec);
	}
	return records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function summarizeChunks(store, jobId) {
	const records = await readChunkRecords(store, jobId);
	const chunks = records.map(summarizeChunkRecord);
	const ids = chunks.map((c) => c.id);
	const missing = [];
	for (const required of ["metadata", "context", "merge_assessment", "audit"]) if (!ids.includes(required) && !ids.includes("document")) missing.push(required);
	const audit = records.find((record) => record.id === "audit");
	const auditChecklist = audit ? auditChecklistItems(audit.yaml) : [];
	if (!ids.includes("document") && !ids.some((id) => id.startsWith("chunk:")) && auditChecklist.length === 0) missing.push("chunk:<id> or audit.reviewer_checklist");
	return { chunks, missing, nextRequired: missing[0], hasDocument: ids.includes("document"), finalized: false };
}

function auditChecklistItems(yamlText) {
	try {
		const auditValue = parseYamlValue(yamlText, "audit");
		return Array.isArray(auditValue?.reviewer_checklist) ? auditValue.reviewer_checklist : [];
	} catch {
		return [];
	}
}

function summarizeChunkRecord(record) {
	return { id: record.id, kind: record.kind, updatedAt: record.updatedAt, bytes: record.bytes };
}

async function assembleSubmission(store, binding) {
	const records = await readChunkRecords(store, binding.jobId);
	if (records.length === 0) throw prwError("PRW_FINALIZE_INCOMPLETE", "No PR walkthrough chunks have been saved yet.");
	const document = records.find((r) => r.id === "document");
	if (document) {
		if (records.length > 1) throw prwError("PRW_CHUNK_CONFLICT", "document chunk cannot be finalized together with section chunks.");
		return { yaml: document.yaml, source: "document" };
	}
	const byId = new Map(records.map((r) => [r.id, r]));
	const required = ["metadata", "context", "merge_assessment", "audit"];
	const missing = required.filter((id) => !byId.has(id));
	const reviewChunks = records.filter((r) => r.id.startsWith("chunk:"));
	const auditChecklist = byId.has("audit") ? auditChecklistItems(byId.get("audit").yaml) : [];
	if (reviewChunks.length === 0 && auditChecklist.length === 0) missing.push("chunk:<id> or audit.reviewer_checklist");
	if (missing.length > 0) throw prwError("PRW_FINALIZE_INCOMPLETE", "Saved chunks are incomplete for finalization.", { missing });

	const decisions = records.filter((r) => r.id.startsWith("decision:")).map((r) => listItemYamlWithStableId(r, "decision:", 4));
	const chunks = reviewChunks.map((r) => listItemYamlWithStableId(r, "chunk:", 4));
	const chunkIds = reviewChunks.map((r) => r.id.slice("chunk:".length)).sort();
	const docParts = [
		"schema_version: 1",
		"pr:",
		mergedPrYaml(byId.get("metadata"), binding, 2),
		"walkthrough:",
		"  context:",
		indentYaml(byId.get("context").yaml, 4),
		"  merge_assessment:",
		indentYaml(byId.get("merge_assessment").yaml, 4),
		"  design_decisions:",
		decisions.length ? decisions.join("\n") : "    []",
		"  review_chunks:",
		chunks.length ? chunks.join("\n") : "    []",
		"  omissions_and_followups:",
		byId.has("omissions_and_followups") ? indentYaml(byId.get("omissions_and_followups").yaml, 4) : "    []",
		"  audit:",
		indentYaml(byId.get("audit").yaml, 4),
		"  display:",
		byId.has("display") ? indentYaml(byId.get("display").yaml, 4) : defaultDisplayYaml(chunkIds, 4),
	];
	return { yaml: docParts.filter(Boolean).join("\n") + "\n", source: "chunks" };
}

function listItemYamlWithStableId(record, prefix, indent) {
	const stableId = record.id.slice(prefix.length);
	const item = parseYamlValue(record.yaml, record.id);
	if (!isObject(item)) throw prwError("PRW_CHUNK_INVALID", `${record.id} must be a mapping.`);
	if (item.id !== undefined && item.id !== stableId) throw prwError("PRW_CHUNK_INVALID", `${record.id} item id must equal ${stableId}.`, { expected: stableId, actual: item.id });
	let yaml = String(record.yaml || "").trimEnd();
	if (item.id === undefined) yaml = `id: ${yamlScalar(stableId)}\n${yaml}`;
	return listItemYaml(yaml, indent);
}

function trustedPrFields(binding) {
	const target = binding.target && typeof binding.target === "object" ? binding.target : {};
	const out = {};
	if (target.provider) out.provider = target.provider;
	if (target.owner) out.owner = target.owner;
	if (target.repo) out.repo = target.repo;
	if (target.number !== undefined) out.number = target.number;
	if (target.prUrl) out.url = target.prUrl;
	if (binding.baseSha) out.base_sha = binding.baseSha;
	if (binding.headSha) out.head_sha = binding.headSha;
	return out;
}

function mergedPrYaml(metadataRecord, binding, indent) {
	const metadata = parseYamlValue(metadataRecord?.yaml, "metadata");
	if (!isObject(metadata)) throw prwError("PRW_CHUNK_INVALID", "metadata must be a YAML mapping.");
	return yamlBlock({ ...metadata, ...trustedPrFields(binding) }, indent);
}

function yamlScalar(value) {
	if (value === null) return "null";
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return JSON.stringify(String(value));
}

function yamlKey(key) {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(String(key));
}

function yamlBlock(value, spaces) {
	const pad = " ".repeat(spaces);
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]`;
		return value.map((item) => {
			if (isObject(item) || Array.isArray(item)) return `${pad}-\n${yamlBlock(item, spaces + 2)}`;
			return `${pad}- ${yamlScalar(item)}`;
		}).join("\n");
	}
	if (isObject(value)) {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		if (entries.length === 0) return `${pad}{}`;
		return entries.map(([key, item]) => {
			if (Array.isArray(item)) {
				if (item.length === 0) return `${pad}${yamlKey(key)}: []`;
				return `${pad}${yamlKey(key)}:\n${yamlBlock(item, spaces + 2)}`;
			}
			if (isObject(item)) {
				const nested = Object.entries(item).some(([, nestedItem]) => nestedItem !== undefined);
				return nested ? `${pad}${yamlKey(key)}:\n${yamlBlock(item, spaces + 2)}` : `${pad}${yamlKey(key)}: {}`;
			}
			return `${pad}${yamlKey(key)}: ${yamlScalar(item)}`;
		}).join("\n");
	}
	return `${pad}${yamlScalar(value)}`;
}

function indentYaml(yamlText, spaces) {
	const pad = " ".repeat(spaces);
	const text = String(yamlText ?? "").trimEnd();
	if (!text) return `${pad}{}`;
	return text.split(/\r?\n/).map((line) => line.trim() ? `${pad}${line}` : line).join("\n");
}

function listItemYaml(yamlText, spaces) {
	const pad = " ".repeat(spaces);
	const childPad = " ".repeat(spaces + 2);
	const lines = String(yamlText ?? "").trimEnd().split(/\r?\n/);
	if (lines.length === 0 || !lines[0].trim()) return `${pad}- {}`;
	return [`${pad}- ${lines[0]}`, ...lines.slice(1).map((line) => line.trim() ? `${childPad}${line}` : line)].join("\n");
}

function defaultDisplayYaml(chunkIds, spaces) {
	const pad = " ".repeat(spaces);
	const itemPad = " ".repeat(spaces + 2);
	return [
		`${pad}phase_order:`,
		...DEFAULT_PHASE_ORDER.map((phase) => `${itemPad}- ${phase}`),
		`${pad}chunk_order:`,
		...(chunkIds.length ? chunkIds.map((id) => `${itemPad}- ${yamlScalar(id)}`) : [`${itemPad}[]`]),
	].join("\n");
}

async function buildFinalPayload(ctx, binding, yamlText, body = {}) {
	const validation = validatePrWalkthroughYaml(yamlText, binding.target ? { target: binding.target } : undefined);
	if (!validation.ok) throw prwError("PRW_SCHEMA_INVALID", "PR walkthrough YAML failed validation.", validation.summary);
	let baseSha = strOf(binding.baseSha) || strOf(body.baseSha) || strOf(validation.document?.pr?.base_sha);
	let headSha = strOf(binding.headSha) || strOf(body.headSha) || strOf(validation.document?.pr?.head_sha);
	let live;
	if (baseSha && headSha) {
		try { live = await resolveLocalChangeset(workerCwd(), baseSha, headSha); }
		catch { live = undefined; }
	}
	const parsedDiff = live ? { diffBlocks: live.blocks, changeset: live.changeset, warnings: live.warnings } : {};
	const result = mapYamlToWalkthroughPayload(validation.document, parsedDiff);
	const cards = Array.isArray(result.cards) ? result.cards : [];
	const warnings = Array.isArray(result.warnings) ? result.warnings : [];
	const changesetId = strOf(body.changesetId) || strOf(binding.changesetId) || (live && live.changesetId) || changesetIdFromDocument(validation.document, baseSha, headSha) || binding.jobId;
	const existing = body.skipExistingFinalRead ? null : await ctx.host.store.get(finalPayloadKey(binding.jobId));
	const persistedAt = existing && typeof existing.persistedAt === "number" ? existing.persistedAt : Date.now();
	const finalizedAt = Date.now();
	return { schemaVersion: STORE_SCHEMA_VERSION, jobId: binding.jobId, changesetId, baseSha, headSha, yaml: yamlText, changeset: result.changeset, cards, warnings, persistedAt, finalizedAt, cardCount: cards.length };
}

function changesetIdFromDocument(document, baseSha, headSha) {
	const pr = document && typeof document === "object" ? document.pr : undefined;
	if (pr && pr.provider === "github" && pr.owner && pr.repo && pr.number !== undefined) return changesetIdForGithub(pr.owner, pr.repo, pr.number, pr.head_sha || headSha);
	return baseSha && headSha ? changesetIdForLocal(baseSha, headSha) : undefined;
}

function isFinalPayload(value) {
	return value && typeof value === "object" && typeof value.yaml === "string" && Array.isArray(value.cards);
}

function finalBundleResult(payload, jobId) {
	return { found: true, live: false, jobId, changesetId: payload.changesetId, changeset: payload.changeset, cards: payload.cards, warnings: payload.warnings || [], cardsSource: "stored-final", persistedAt: payload.persistedAt, finalizedAt: payload.finalizedAt };
}

function finalSubmittedStatus(payload, binding) {
	return { phase: "submitted", finalized: true, yaml: payload.yaml, baseSha: payload.baseSha ?? binding.baseSha, headSha: payload.headSha ?? binding.headSha, jobId: payload.jobId, changesetId: payload.changesetId, finalizedAt: payload.finalizedAt };
}

async function bestEffortDeletePrefix(store, prefix) {
	try {
		if (typeof store.deletePrefix === "function") await store.deletePrefix(prefix);
	} catch { /* best-effort cleanup */ }
}

async function bestEffortDelete(store, key) {
	try {
		if (typeof store.delete === "function") await store.delete(key);
		else await softDelete(store, key);
	} catch { /* best-effort cleanup */ }
}

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
// ALWAYS-FRESH launch (launch UX correction, Q4): spawn(deferInitialPrompt) → write
// binding → kickoff prompt → flip kickedOff. There is NO idempotency/reuse and NO
// reviewer index any more — every call spawns a brand-new reviewer. The post-spawn
// steps are wrapped in ONE try/catch that COMPENSATES (dismiss child + tombstone the
// binding) on any failure, so a retry starts clean. The session is titled
// "PR Walkthrough" via the spawn `title` opt (server-host-api passthrough).
async function launchReviewer(ctx, parent, target, canonicalKey) {
	const store = ctx.host.store;
	const kickoff = buildKickoffPrompt(target);

	// ALWAYS-FRESH: no idempotency/reuse lookup — every call spawns a NEW reviewer.
	// Spawn the visible, NOT-yet-started reviewer (bounded auto-retry). canonicalKey is
	// recorded on the binding (below) for diagnostics only — it is no longer an index.
	const jobId = `prw-${randomUUID()}`;
	const changesetId = changesetIdForTarget(target);
	let childSessionId;
	try {
		const spawned = await spawnReviewerWithRetry(ctx, {
			role: "pr-reviewer",
			readOnly: true,
			lifecycle: "full",
			// Session/sidebar title for the reviewer child (additive server-host-api opt).
			title: "PR Walkthrough",
			deferInitialPrompt: true,
			instructions: kickoff,
			context: contextForTarget(target),
			// NON-SECRET tool-scoping env: restores the legacy launched-PR `gh` scoping
			// (extension.ts getReadonlyPolicyOptions reads these to reject cross-PR /
			// cross-repo `gh` reads). Plain metadata only — it never widens the reviewer's
			// owner-inherited sandbox/credential scope.
			toolEnv: toolEnvForTarget(target),
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
		const reviewerIndex = {
			schemaVersion: STORE_SCHEMA_VERSION,
			jobId,
			parentSessionId: parent,
			changesetId,
			baseSha: target.baseSha,
			headSha: target.headSha,
			createdAt: Date.now(),
		};
		await store.put(reviewerIndexKey(childSessionId), reviewerIndex, REVIEWER_INDEX_QUOTA(childSessionId));
		await store.put(reviewBindingKey(jobId, childSessionId), { ...bindingBase, kickedOff: false }, REVIEW_BINDING_QUOTA(jobId));
		await ctx.host.agents.prompt(childSessionId, kickoff);
		await store.put(reviewBindingKey(jobId, childSessionId), { ...bindingBase, kickedOff: true }, REVIEW_BINDING_QUOTA(jobId));
	} catch (e) {
		try { await ctx.host.agents.dismiss(childSessionId); } catch { /* no orphaned visible child */ }
		await bestEffortDelete(store, reviewerIndexKey(childSessionId));
		await bestEffortDelete(store, reviewBindingKey(jobId, childSessionId));
		await bestEffortDelete(store, bindingKey(childSessionId));
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

// NON-SECRET tool-scoping env for the reviewer child: the launched-PR identity
// the readonly_bash policy uses to scope `gh` reads to THIS PR (extension.ts
// getReadonlyPolicyOptions reads BOBBIT_WALKTHROUGH_TARGET_*). Mirrors the legacy
// launcher's env exactly. Only emitted for a github target with owner/repo/number
// (the run route rejects non-github targets before spawn).
function toolEnvForTarget(target) {
	if (!target || target.provider !== "github") return undefined;
	if (!target.owner || !target.repo || target.number === undefined) return undefined;
	return {
		BOBBIT_WALKTHROUGH_TARGET_PROVIDER: "github",
		BOBBIT_WALKTHROUGH_TARGET_OWNER: String(target.owner),
		BOBBIT_WALKTHROUGH_TARGET_REPO: String(target.repo),
		BOBBIT_WALKTHROUGH_TARGET_NUMBER: String(target.number),
	};
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
		"Save durable progress as you go with submit_pr_walkthrough_chunk, check read_pr_walkthrough_submission_status after compaction/retry, then call finalize_pr_walkthrough_submission when complete. submit_pr_walkthrough_yaml remains available only as a compatibility wrapper.",
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
async function resolveCurrentBranchTarget(cwd, io = { gh, git }) {
	const noPr = {
		ok: false,
		retryable: false,
		error: "No open GitHub PR for the current branch. Open a PR, then run the walkthrough.",
		code: "NO_PR",
	};

	let pr;
	try {
		const out = await io.gh(cwd, ["pr", "view", "--json", "number,url,headRefOid,baseRefOid,baseRefName,headRefName"]);
		pr = JSON.parse(String(out).trim());
	} catch {
		return noPr; // gh non-zero / no PR for branch / gh unavailable
	}
	if (!pr || typeof pr !== "object" || !Number.isInteger(pr.number)) return noPr;

	// owner/repo from `gh repo view`, falling back to the origin remote.
	let owner;
	let repo;
	try {
		const repoOut = await io.gh(cwd, ["repo", "view", "--json", "owner,name"]);
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
		headSha = await io.git(cwd, ["rev-parse", "HEAD"]).then((s) => s.trim()).catch(() => undefined);
	}
	// baseSha: the PR comparison base GitHub reports for the PR. This is the
	// pre-merge base OID for merged PRs, so the launch-time bundle matches the
	// Files changed diff GitHub shows instead of diffing against the current
	// origin/<base> tip (which may already contain the PR and produce an empty diff).
	let baseSha = strOf(pr.baseRefOid);
	const baseRef = strOf(pr.baseRefName);
	if (!baseSha && baseRef) {
		baseSha = await io.git(cwd, ["rev-parse", `origin/${baseRef}`]).then((s) => s.trim()).catch(() => undefined);
		if (!baseSha) baseSha = await io.git(cwd, ["rev-parse", baseRef]).then((s) => s.trim()).catch(() => undefined);
		if (!baseSha && headSha) {
			baseSha = await io.git(cwd, ["merge-base", `origin/${baseRef}`, "HEAD"]).then((s) => s.trim()).catch(() => undefined);
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

export const __test = { resolveCurrentBranchTarget, assembleSubmission, summarizeChunks, validateChunkId };

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
