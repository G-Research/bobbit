// Pack SERVER route module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// ESM (`export const routes`), loaded by the gateway RouteRegistry/RouteDispatcher
// and EXECUTED inside the C3 worker. This pack declares `permissions: ["git","fs"]`
// (pr_walkthrough.yaml), so — per the DECLARED-PERMISSION grant model (design
// docs/design/extension-host-phase2.md §9 C3.4) — the worker un-denies
// `node:child_process` + `node:fs`, gives `process` a REAL cwd() (the session
// working dir) + a minimal `{ PATH }` env (so the `git` binary resolves), and
// SIGKILLs any spawned `git` child on terminate-on-timeout. The grant is
// server-resolved from the winning contribution, never caller-supplied; absent it,
// this module would still load but the git import would be denied.
//
// ── LIVE CHANGESET RECOMPUTE (design §D2.3 — the reversal of the prior revision) ──
// The bespoke route `src/server/pr-walkthrough/routes.ts` COMPUTES the changeset
// bundle at request time: it shells out to `git` (execFile), parses the unified
// diff, assembles the changeset header, and runs LLM card synthesis. With declared
// `git`/`fs` this pack route re-expresses the STRUCTURAL part of that LIVE in the
// confined worker — the SAME `git diff`/`--name-status`/`--shortstat` + diff parse +
// `synthesizeFallbackCards` logic — so `bundle` returns a REAL, freshly-computed
// changeset for the requested base/head, including PRs created AFTER the pack was
// installed (a static seeded fixture could only replay PRs known at publish time).
//
// ── THE SYNTHESIS CREDENTIAL SPLIT (design §D2.3 — CRITICAL) ──
// LLM card synthesis needs MODEL CREDENTIALS. The confined worker has only a
// minimal `{ PATH }` env and NO gateway token / model keys (by design §9 C3.2) —
// even the `net` grant would not hand it the gateway's model credentials. So LLM
// synthesis MUST NOT run in this route. The split:
//   • The STRUCTURAL changeset + deterministic fallback cards are COMPUTED LIVE
//     here (git, no creds).
//   • LLM-ENHANCED cards are produced at AGENT-TOOL/submit time
//     (`submit_pr_walkthrough_yaml`, normal agent creds, NOT this worker) and
//     PERSISTED via the `publish` route to `host.store`, keyed by the changeset id.
//   • This `bundle` route, when the computed changeset id HAS stored cards, READS
//     them via `host.store.get` and renders them (full parity); when none exist it
//     returns the correct non-LLM (fallback) walkthrough it just computed.
// `host.store.*` is pack-scoped server-side by the SERVER-derived packId (cross-pack
// reads rejected) — so this module never names a packId or a path.

import { execFile } from "node:child_process";

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
	return typeof value === "string" && value.trim() ? value.trim() : "job-litmus-1";
}

function strOf(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const routes = {
	// LIVE changeset recompute + persisted-card read. Two modes:
	//   • baseSha + headSha present → recompute the REAL changeset LIVE via `git`
	//     (in the confined worker, declared git/fs) and serve it + any stored cards.
	//   • only jobId → load the persisted job pointer (base/head/repoDir written by
	//     `publish`) and recompute live from it (store-rehydration); else empty.
	// NEVER a raw fetch — the panel reaches this only via host.callRoute.
	bundle: async (ctx, req) => {
		const q = (req && req.query) || {};
		const jobId = normalizeJobId(q.jobId);
		let baseSha = strOf(q.baseSha);
		let headSha = strOf(q.headSha);
		// `repoDir` selects the git working dir. It defaults to the worker's REAL
		// cwd() (the session working dir, server-resolved) — the canonical production
		// path (design §D2.3). An explicit override mirrors the bespoke route's
		// `body.cwd`; the trust boundary is the declared fs/git grant (the worker can
		// already read any path), not the cwd selection.
		let repoDir = strOf(q.repoDir);

		// jobId-only: rehydrate base/head/repoDir from the persisted job pointer so a
		// deep-link carrying only the jobId still recomputes the SAME changeset live.
		if ((!baseSha || !headSha)) {
			const job = await ctx.host.store.get(jobKey(jobId));
			if (job && typeof job === "object") {
				baseSha = baseSha || strOf(job.baseSha);
				headSha = headSha || strOf(job.headSha);
				repoDir = repoDir || strOf(job.repoDir);
			}
		}

		if (!baseSha || !headSha) {
			// No base/head to recompute from and no persisted pointer — the viewer
			// shows an explicit empty state (a real launcher injects the current
			// branch's base/head; the litmus drives a sha-carrying deep-link).
			return { found: false, jobId };
		}

		const cwd = repoDir || workerCwd();
		const live = await resolveLocalChangeset(cwd, baseSha, headSha);

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

	// Submit-time persistence seam (re-expresses storeWalkthrough). The agent tool
	// (with real git/fs/network + MODEL credentials) COMPUTES the LLM-enhanced cards
	// and hands them here. We persist:
	//   • the LLM cards keyed by the changeset id (read back by `bundle`), and
	//   • a job pointer { changesetId, baseSha, headSha, repoDir } so a jobId-only
	//     deep-link can recompute the same changeset live.
	// `persistedAt` is stamped ONCE per changeset (a re-publish keeps the original
	// stamp) so the bundle route returns a stable timestamp across reloads —
	// the store-rehydration parity proof.
	publish: async (ctx, req) => {
		const body = (req && req.body) || {};
		const jobId = normalizeJobId(body.jobId);
		const changesetId = strOf(body.changesetId)
			|| (strOf(body.baseSha) && strOf(body.headSha) ? changesetIdForLocal(body.baseSha, body.headSha) : undefined)
			|| jobId;

		// Job pointer — lets a jobId-only deep-link rehydrate the base/head/repoDir.
		const jobPointer = {
			schemaVersion: STORE_SCHEMA_VERSION,
			jobId,
			changesetId,
			baseSha: strOf(body.baseSha),
			headSha: strOf(body.headSha),
			repoDir: strOf(body.repoDir),
		};
		await ctx.host.store.put(jobKey(jobId), jobPointer);

		// LLM cards (if provided) keyed by changeset id, persistedAt stamped once.
		let persistedAt;
		if (Array.isArray(body.cards) && body.cards.length > 0) {
			const existing = await ctx.host.store.get(cardsKey(changesetId));
			persistedAt = typeof body.persistedAt === "number"
				? body.persistedAt
				: (existing && typeof existing.persistedAt === "number" ? existing.persistedAt : Date.now());
			await ctx.host.store.put(cardsKey(changesetId), {
				schemaVersion: STORE_SCHEMA_VERSION,
				changesetId,
				cards: body.cards,
				warnings: Array.isArray(body.warnings) ? body.warnings : [],
				persistedAt,
			});
		}
		const keys = await ctx.host.store.list("");
		return { ok: true, jobId, changesetId, persistedAt, keys };
	},
};

// ── The worker's REAL cwd() (the session working dir under the git/fs grant). The
//    inert/minimal process shim returns "/" when no fs/git is granted; with the
//    grant it returns the session dir. Guarded so a denied-grant load never throws. ──
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
	return { changesetId: changesetIdForLocal(fullBase, fullHead), changeset, cards, warnings };
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
