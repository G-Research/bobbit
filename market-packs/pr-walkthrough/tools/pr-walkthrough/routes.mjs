// Pack SERVER route module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// ESM (`export const routes`), loaded by the gateway RouteRegistry/RouteDispatcher
// and EXECUTED inside the C3-confined worker (empty env + module-load deny-hook):
// it imports NO node builtins (no fs/network/child_process) and touches Bobbit
// ONLY through `ctx.host` — the single sanctioned worker→parent channel.
//
// ── THE LOAD-BEARING ARCHITECTURAL CONSTRAINT (documented in
//    docs/design/pr-walkthrough-pack-deletion.md) ──
// The bespoke route `src/server/pr-walkthrough/routes.ts` COMPUTES the changeset
// bundle at request time: it shells out to `git` (execFile), reads `fs`, calls the
// GitHub adapter over the network, and runs LLM card synthesis. NONE of that is
// possible from a pack route, because pack routes run in the no-ambient-access
// C3 worker (acceptance #3/#4): no `child_process`, no `fs`, no `net`. A pack
// route therefore CANNOT recompute a walkthrough live.
//
// The correct, durable split is:
//   • git/diff/synthesis is AGENT-TOOL work — the `readonly_bash` /
//     `submit_pr_walkthrough_yaml` tools run with NORMAL agent permissions (NOT in
//     the confined worker). They PRODUCE the bundle and PERSIST it (submit time).
//   • this pack `bundle` route only READS the persisted bundle from `host.store`
//     and returns it. It performs NO git/fs/network work at read time.
//
// Re-expresses src/server/pr-walkthrough/routes.ts (handlePrWalkthroughApiRoute):
//  - `bundle`  ← GET /api/pr-walkthrough/:changesetId  (load PERSISTED walkthrough)
//  - `publish` ← POST /api/pr-walkthrough/resolve → storeWalkthrough(payload)
// The bespoke walkthrough-store.ts persistence is re-expressed onto
// `ctx.host.store.*`, which the server scopes to the SERVER-derived packId
// (cross-pack reads rejected) — so this module never names a packId or a path.
//
// The persisted record mirrors the REAL walkthrough-store payload
// (src/server/pr-walkthrough/walkthrough-store.ts: WalkthroughStorePayload —
// changesetId + changeset + cards[] + warnings[]), NOT a synthetic fixture.

const STORE_SCHEMA_VERSION = 1;
const jobKey = (jobId) => `job/${jobId}`;

function normalizeJobId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : "job-litmus-1";
}

export const routes = {
	// READ-ONLY load of the PERSISTED walkthrough bundle for a job. This route does
	// NO git/fs/network/synthesis work (it CANNOT — see the header note): it returns
	// exactly what `submit_pr_walkthrough_yaml`/`publish` persisted at submit time.
	// On a cache-cleared reload the SAME stored record (same `persistedAt`) is
	// returned — the store-rehydration parity proof. NEVER a raw fetch.
	bundle: async (ctx, req) => {
		const jobId = normalizeJobId(req && req.query && req.query.jobId);
		const stored = await ctx.host.store.get(jobKey(jobId));
		if (!stored) {
			// No agent has submitted/persisted a walkthrough for this job yet. The
			// route does NOT synthesize one (it has no git/diff/synthesis capability
			// in the confined worker); the viewer shows an explicit empty state.
			return { found: false, jobId };
		}
		return { found: true, ...stored };
	},

	// Persist a walkthrough record for a job — the re-expression of the bespoke
	// POST /api/pr-walkthrough/resolve → storeWalkthrough(payload). This is the
	// SUBMIT-TIME persistence seam: the agent tool (which has git/fs/network) has
	// already COMPUTED the bundle and hands the finished WalkthroughStorePayload
	// here to be stored, pack-scoped. `persistedAt` is stamped ONCE (a re-publish
	// of the same job keeps the original stamp) so the bundle route returns a
	// stable timestamp across reloads.
	publish: async (ctx, req) => {
		const body = (req && req.body) || {};
		const jobId = normalizeJobId(body.jobId);
		const key = jobKey(jobId);
		const existing = await ctx.host.store.get(key);
		const persistedAt = typeof body.persistedAt === "number"
			? body.persistedAt
			: (existing && typeof existing.persistedAt === "number" ? existing.persistedAt : Date.now());
		const record = {
			schemaVersion: STORE_SCHEMA_VERSION,
			...body,
			jobId,
			persistedAt,
		};
		await ctx.host.store.put(key, record);
		const keys = await ctx.host.store.list("job/");
		return { ok: true, jobId, persistedAt, keys };
	},
};
