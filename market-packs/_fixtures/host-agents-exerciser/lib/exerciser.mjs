// market-packs/_fixtures/host-agents-exerciser/lib/exerciser.mjs
//
// DETERMINISTIC Sub-goal C fixture (orchestration-core §13). A server pack
// handler that exercises the ambient `host.agents` capability end to end —
// spawn → poll status → prompt → poll status → list → read → dismiss — entirely
// through `ctx.host.agents` (the poll-based surface; NO blocking `wait`).
//
// The spawned child is the e2e MOCK AGENT (canned / no-LLM): its spawn prompt
// runs a fixed scripted turn and the child goes idle in milliseconds, so the
// host.agents E2E is NON-FLAKY and stays in the e2e phase (never test:manual).
//
// This module is real pack server code: the E2E drives it through the confined
// worker (ModuleHost.invoke), so `ctx.host.agents.*` is marshalled across the
// MessagePort to the parent's live ServerHostApi exactly like a shipped pack.

/** Poll an owned child's status until it settles (idle/terminated) or we give up. */
async function pollUntilSettled(host, childSessionId, { tries = 400, intervalMs = 25 } = {}) {
	for (let i = 0; i < tries; i++) {
		const { status } = await host.agents.status(childSessionId);
		if (status === "idle" || status === "terminated") return status;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return "timeout";
}

export const actions = {
	/**
	 * Run the full poll-based host.agents lifecycle and return a deterministic
	 * report the E2E asserts against. `args.instructions` / `args.followUp` let
	 * the test pick the canned prompts (both default to short strings).
	 */
	async exercise(ctx, args) {
		const host = ctx.host;
		if (!host?.capabilities?.has?.("agents")) {
			throw new Error("host.agents capability is not present on ctx.host");
		}
		const instructions = (args && args.instructions) || "say hello";
		const followUp = (args && args.followUp) || "say goodbye";

		// 1. spawn — a host-agents child owned by the bound session.
		const { childSessionId } = await host.agents.spawn({ instructions });

		// 2. poll status until the spawn turn settles.
		const status1 = await pollUntilSettled(host, childSessionId);

		// 3. list — the bound session's host-agents children (source-filtered).
		const listedAfterSpawn = await host.agents.list();

		// 4. prompt — a follow-up turn (run-if-idle / queue).
		const prompt = await host.agents.prompt(childSessionId, followUp);

		// 5. poll until the follow-up turn settles.
		const status2 = await pollUntilSettled(host, childSessionId);

		// 6. read — the child's transcript/output.
		const read = await host.agents.read(childSessionId, { offset: -20, limit: 20 });

		// 7. dismiss — terminate + archive; the child leaves the tracked set.
		const dismissed = await host.agents.dismiss(childSessionId);
		const listedAfterDismiss = await host.agents.list();

		return {
			childSessionId,
			status1,
			status2,
			promptStatus: prompt.status,
			listedAfterSpawnCount: listedAfterSpawn.length,
			listedChildKinds: listedAfterSpawn.map((c) => c.childKind),
			listedIds: listedAfterSpawn.map((c) => c.childSessionId),
			readIsObject: typeof read === "object" && read !== null,
			dismissed,
			listedAfterDismissCount: listedAfterDismiss.length,
		};
	},

	/**
	 * Spawn a host-agents child and return its id WITHOUT dismissing it, so the
	 * E2E can assert source-scoping (a delegate/team child of the same session is
	 * NOT visible to host.agents) against a live child.
	 */
	async spawnOnly(ctx, args) {
		const host = ctx.host;
		const instructions = (args && args.instructions) || "say hello";
		const { childSessionId } = await host.agents.spawn({ instructions });
		const listed = await host.agents.list();
		return { childSessionId, listedIds: listed.map((c) => c.childSessionId), listedChildKinds: listed.map((c) => c.childKind) };
	},
};

// `routes` alias so the pack-level `routes:` contribution in pack.yaml resolves
// to the same handlers (a route handler also receives `ctx.host`). The E2E drives
// these through ModuleHost.invoke with exportKind "actions".
export const routes = actions;
