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

		// Prefer LLM-enhanced cards persisted at submit time (keyed by changeset id);
		// else the deterministic fallback cards computed in-worker above.
		const stored = await ctx.host.store.get(cardsKey(live.changesetId));
		const hasStored = stored && Array.isArray(stored.cards) && stored.cards.length > 0;
		return {
			found: true,
			live: true,
			jobId,
			changesetId: live.changesetId,
			changeset: live.changeset,
			cards: hasStored ? stored.cards : live.cards,
			warnings: live.warnings,
			cardsSource: hasStored ? "stored-llm" : "fallback",
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
			cards,
			warnings,
			persistedAt,
		});

		const keys = await ctx.host.store.list("");
		return { ok: true, jobId, changesetId, persistedAt, cardCount: cards.length, keys };
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
