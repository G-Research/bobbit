// Deterministic `goalProvisioned` fixture provider for the hierarchical
// goal-metadata filesystem E2E.
//
// On every dispatch it writes a content-addressed marker file into the
// provisioned worktree (ctx.cwd) capturing the RESOLVED (hierarchically
// inherited) metadata the hub handed it, plus an append-only invocation log so
// the test can assert the hook fired and is safe to re-run (idempotency).
//
// The provider is intentionally cheap + idempotent: writing the marker is an
// overwrite, so repeated provisioning of the same worktree converges to the
// same content (the New Era content-addressed pattern).
import fs from "node:fs";
import path from "node:path";

export const MARKER_FILE = ".goal-provisioned-marker.json";
export const COUNT_FILE = ".goal-provisioned-count";

export default {
	async goalProvisioned(ctx) {
		const dir = ctx.cwd || ctx.worktreePath;
		if (!dir) return;
		const marker = {
			goalId: ctx.goalId ?? null,
			projectId: ctx.projectId ?? null,
			worktreePath: ctx.worktreePath ?? null,
			branch: ctx.branch ?? null,
			// The resolved (ancestry-merged) metadata — the whole point of the test.
			metadata: ctx.metadata ?? {},
		};
		fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify(marker, null, 2), "utf-8");
		// Append-only audit so a test can count invocations per worktree and prove
		// re-provisioning is non-fatal.
		fs.appendFileSync(path.join(dir, COUNT_FILE), `${ctx.goalId ?? "?"}\n`, "utf-8");
	},
};
