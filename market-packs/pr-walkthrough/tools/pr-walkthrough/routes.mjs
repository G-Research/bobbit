// Pack SERVER route module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// ESM (`export const routes`), loaded by the gateway RouteRegistry/RouteDispatcher
// and EXECUTED inside the C3-confined worker (empty env + module-load deny-hook):
// it imports NO node builtins (no fs/network/child_process) and touches Bobbit
// ONLY through `ctx.host` — the single sanctioned worker→parent channel.
//
// Re-expresses src/server/pr-walkthrough/routes.ts (handlePrWalkthroughApiRoute):
//  - `bundle`  ← GET /api/pr-walkthrough/:changesetId  (load persisted walkthrough)
//  - `publish` ← POST /api/pr-walkthrough/resolve → storeWalkthrough(payload)
// The bespoke walkthrough-store.ts file persistence is re-expressed onto
// `ctx.host.store.*`, which the server scopes to the SERVER-derived packId
// (cross-pack reads rejected) — so this module never names a packId or a path.

const STORE_SCHEMA_VERSION = 1;
const jobKey = (jobId) => `job/${jobId}`;

/** A representative WalkthroughResolveResult re-expressed in pack form (mirrors
 *  src/ui/components/pr-walkthrough/types.ts: PrWalkthroughChangesetRef +
 *  PrWalkthroughCard + PrWalkthroughDiffBlock). Deterministic per jobId. */
function fixtureBundle(jobId) {
	const changeset = {
		baseSha: `${jobId}-base`,
		headSha: `${jobId}-head`,
		provider: "fixture",
		title: `PR walkthrough for ${jobId}`,
		filesChanged: 1,
		additions: 2,
		deletions: 1,
	};
	const diffBlock = {
		id: "block-1-readme",
		filePath: "README.md",
		status: "modified",
		hunks: [{
			id: "block-1-readme-h1",
			header: "@@ -1,2 +1,3 @@",
			lines: [
				{ id: "l0", side: "context", oldLine: 1, newLine: 1, kind: "context", text: "# Project" },
				{ id: "l1", side: "old", oldLine: 2, kind: "del", text: "stale summary line" },
				{ id: "l2", side: "new", newLine: 2, kind: "add", text: "fresh summary line" },
				{ id: "l3", side: "new", newLine: 3, kind: "add", text: "extra detail line" },
			],
		}],
	};
	const cards = [
		{
			id: "orientation-summary",
			phaseId: "orientation",
			title: "PR context",
			navLabel: "Orientation",
			summary: `Why ${jobId} was raised: PR-walkthrough-as-pack litmus.`,
			diffBlocks: [],
		},
		{
			id: "significant-files",
			phaseId: "significant",
			title: "Changed files",
			navLabel: "Changed files",
			summary: "Review 1 diff-backed file.",
			diffBlocks: [diffBlock],
		},
	];
	return { schemaVersion: STORE_SCHEMA_VERSION, jobId, changeset, cards, warnings: [] };
}

export const routes = {
	// Load the persisted walkthrough bundle for a job. On the FIRST call it
	// synthesizes + PERSISTS a fixture (persistedAt stamped ONCE) via host.store;
	// every later call — including after a full page reload — returns the SAME
	// stored record, which is the store-rehydration parity proof. NEVER a raw fetch.
	bundle: async (ctx, req) => {
		const jobId = (req && req.query && req.query.jobId) || "job-litmus-1";
		const key = jobKey(jobId);
		let stored = await ctx.host.store.get(key);
		if (!stored) {
			stored = { ...fixtureBundle(jobId), persistedAt: Date.now() };
			await ctx.host.store.put(key, stored);
		}
		return stored;
	},

	// Persist a walkthrough record for a job (re-expresses the bespoke
	// POST /api/pr-walkthrough/resolve → storeWalkthrough(payload)). Pack-scoped.
	publish: async (ctx, req) => {
		const body = (req && req.body) || {};
		const jobId = body.jobId || "job-litmus-1";
		const record = {
			schemaVersion: STORE_SCHEMA_VERSION,
			jobId,
			persistedAt: Date.now(),
			source: "publish",
			...body,
		};
		await ctx.host.store.put(jobKey(jobId), record);
		const keys = await ctx.host.store.list("job/");
		return { ok: true, jobId, persistedAt: record.persistedAt, keys };
	},
};
