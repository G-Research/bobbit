/**
 * API E2E — Orchestration Core Sub-goal C, the ambient `host.agents` capability.
 *
 * Drives the DETERMINISTIC fixture pack `market-packs/_fixtures/host-agents-
 * exerciser/` through the REAL confined worker (`ModuleHost.invoke`), so the
 * `ctx.host.agents` proxy path is exercised exactly like a shipped pack: the
 * worker marshals each verb across the MessagePort to the parent's LIVE
 * ServerHostApi, which calls the SAME in-process OrchestrationCore that backs the
 * agent-tool `/orchestrate/*` routes.
 *
 * The spawned child is the e2e MOCK AGENT (canned / no-LLM): its spawn prompt
 * runs a fixed scripted turn and the child goes idle in milliseconds, so this E2E
 * is NON-FLAKY and stays in the e2e phase (NEVER test:manual).
 *
 * Covers the Sub-goal C acceptance criteria:
 *   • a fixture handler can spawn → prompt → poll status/list/read → dismiss
 *     (poll-based, no blocking wait),
 *   • scoped to its OWN host-agents children (a delegate/team child of the same
 *     session is NOT visible; no foreign session is reachable),
 *   • the host carries orchestration verbs only — no token / raw fetch.
 */
import { test, expect } from "./in-process-harness.js";
import { createSession, deleteSession } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_PACK_ROOT = resolve(PROJECT_ROOT, "market-packs", "_fixtures", "host-agents-exerciser");
const FIXTURE_MODULE = resolve(FIXTURE_PACK_ROOT, "lib", "exerciser.mjs");

/** Build the LIVE parent ServerHostApi bound to `ownerId`, wired to the gateway's
 *  real OrchestrationCore + a live status reader (exactly as server.ts wires it). */
async function buildHost(gateway: any, ownerId: string): Promise<any> {
	const { createServerHostApi } = await import("../../dist/server/extension-host/server-host-api.js");
	return createServerHostApi({
		sessionId: ownerId,
		packId: "host-agents-exerciser",
		contributionId: "host-agents-exerciser/exercise",
		orchestrationCore: gateway.orchestrationCore,
		readChildStatus: (id: string) => gateway.sessionManager.getSession(id)?.status,
	});
}

async function runFixture(gateway: any, ownerId: string, member: string, arg: unknown): Promise<any> {
	const { ModuleHost } = await import("../../dist/server/extension-host/module-host-worker.js");
	const host = await buildHost(gateway, ownerId);
	const workingDir = gateway.sessionManager.getSession(ownerId)?.cwd;
	const mh = new ModuleHost({ timeoutMs: 30_000 });
	try {
		return await mh.invoke({
			url: pathToFileURL(FIXTURE_MODULE).href,
			packRoot: FIXTURE_PACK_ROOT,
			epoch: 0,
			exportKind: "actions",
			member,
			ctx: { host, sessionId: ownerId, toolUseId: "tu-host-agents", tool: "host-agents-exerciser", workingDir },
			arg,
		});
	} finally {
		mh.dispose();
	}
}

test.describe("host.agents — fixture handler poll-based lifecycle (via the confined worker)", () => {
	test("spawn → poll status → prompt → poll → list → read → dismiss against a canned child", async ({ gateway }) => {
		const owner = await createSession();
		try {
			const result = await runFixture(gateway, owner, "exercise", {
				instructions: "say hello",
				followUp: "say goodbye",
			});
			expect(result.childSessionId).toBeTruthy();
			// Both turns settled idle (the mock agent ran the canned prompt).
			expect(result.status1).toBe("idle");
			expect(result.status2).toBe("idle");
			expect(["dispatched", "queued"]).toContain(result.promptStatus);
			// list() showed exactly the one host-agents child while it was alive.
			expect(result.listedAfterSpawnCount).toBe(1);
			expect(result.listedChildKinds).toEqual(["host-agents"]);
			expect(result.listedIds).toContain(result.childSessionId);
			// read() returned the child's output object; dismiss() cleaned it up.
			expect(result.readIsObject).toBe(true);
			expect(result.dismissed).toBe(true);
			expect(result.listedAfterDismissCount).toBe(0);
		} finally {
			await deleteSession(owner);
		}
	});
});

test.describe("host.agents — source-filtered scoping (own host-agents children only)", () => {
	test("a delegate child of the SAME session is NOT visible to host.agents", async ({ gateway }) => {
		const owner = await createSession();
		const host = await buildHost(gateway, owner);
		let delegateChildId: string | undefined;
		let hostAgentsChildId: string | undefined;
		try {
			// A `delegate`-sourced child of the SAME owner (the agent-tool path).
			const del = await gateway.orchestrationCore.spawn({
				ownerSessionId: owner,
				instructions: "delegate child",
				childKind: "delegate",
			});
			delegateChildId = del.sessionId;

			// A host-agents child via the capability.
			const ha = await host.agents.spawn({ instructions: "host-agents child" });
			hostAgentsChildId = ha.childSessionId;

			// The core tracks both; host.agents sees ONLY the host-agents one.
			expect(gateway.orchestrationCore.list(owner).length).toBe(2);
			const listed = await host.agents.list();
			expect(listed.map((c: any) => c.childSessionId)).toEqual([hostAgentsChildId]);
			expect(listed[0].childKind).toBe("host-agents");

			// Verbs reject the delegate child (not a host.agents child).
			await expect(host.agents.prompt(delegateChildId!, "hi")).rejects.toThrow(/not a host\.agents child/);
			await expect(host.agents.read(delegateChildId!)).rejects.toThrow(/not a host\.agents child/);
			await expect(host.agents.dismiss(delegateChildId!)).rejects.toThrow(/not a host\.agents child/);
			await expect(host.agents.status(delegateChildId!)).rejects.toThrow(/not a host\.agents child/);
		} finally {
			// Cleanup both children + the owner.
			if (hostAgentsChildId) await host.agents.dismiss(hostAgentsChildId).catch(() => {});
			if (delegateChildId) await gateway.orchestrationCore.dismiss(owner, delegateChildId).catch(() => {});
			await deleteSession(owner);
		}
	});

	test("a child session cannot host.agents.spawn (no grandchildren)", async ({ gateway }) => {
		const owner = await createSession();
		let childId: string | undefined;
		try {
			// Spawn a real host-agents child, then bind a host to THAT child session.
			const host = await buildHost(gateway, owner);
			const ha = await host.agents.spawn({ instructions: "child" });
			childId = ha.childSessionId;
			// Wait for the child to be persisted/linked so assertCanSpawn sees it.
			await pollUntil(async () => (gateway.sessionManager.getPersistedSession(childId!)?.delegateOf ? true : null),
				{ timeoutMs: 5_000, intervalMs: 25, label: "child delegateOf persisted" });
			const childHost = await buildHost(gateway, childId!);
			await expect(childHost.agents.spawn({ instructions: "grandchild" }))
				.rejects.toThrow(/not permitted for a child session/);
		} finally {
			if (childId) await gateway.orchestrationCore.dismiss(owner, childId).catch(() => {});
			await deleteSession(owner);
		}
	});
});
