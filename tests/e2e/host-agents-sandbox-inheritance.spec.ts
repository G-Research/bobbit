/**
 * API E2E — Orchestration Core Sub-goal C, the ONE hard invariant of
 * `host.agents`: SANDBOX / CREDENTIAL INHERITANCE (no privilege escalation).
 *
 * A child launched through `host.agents.spawn` is created by the SAME
 * `OrchestrationCore.spawn` the agent-tool path uses, which propagates the bound
 * session's sandbox + project (credential) scope and never grants a capability
 * the owner lacks. The pack receives orchestration VERBS, not transport (no
 * token, no raw `fetch`). This spec pins those properties against the real
 * gateway + mock agent (deterministic → e2e phase, never test:manual).
 */
import { test, expect } from "./in-process-harness.js";
import { createSession, deleteSession, connectWs, apiFetch } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-4-8" };

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

/** Set a session's model via WS and wait until it persists. */
async function setSessionModel(sessionId: string, provider: string, modelId: string): Promise<void> {
	const ws = await connectWs(sessionId);
	try {
		ws.send({ type: "set_model", provider, modelId });
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === provider && data.modelId === modelId ? true : null;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "owner model persisted" });
	} finally {
		ws.close();
	}
}

test.describe("host.agents — sandbox / credential inheritance (no escalation)", () => {
	test("a host.agents child inherits the bound session's sandbox + project scope and model", async ({ gateway }) => {
		const owner = await createSession();
		const host = await buildHost(gateway, owner);
		let childId: string | undefined;
		try {
			await setSessionModel(owner, OPUS.provider, OPUS.modelId);
			const ownerPs = gateway.sessionManager.getPersistedSession(owner);

			const ha = await host.agents.spawn({ instructions: "inherit-scope child" });
			childId = ha.childSessionId;

			const childPs = await pollUntil(async () => gateway.sessionManager.getPersistedSession(childId!) ?? null,
				{ timeoutMs: 5_000, intervalMs: 25, label: "child persisted" });

			// Linkage: the child is a tracked child of the bound owner.
			expect(childPs.delegateOf).toBe(owner);
			// Sandbox inheritance: the child can never run in a DIFFERENT sandbox than
			// the owner — it inherits the owner's flag verbatim (no escalation).
			expect(Boolean(childPs.sandboxed)).toBe(Boolean(ownerPs?.sandboxed));
			// Credential/project scope: the child is bound to the owner's project, so
			// it cannot reach a project the owner cannot.
			expect(childPs.projectId).toBe(ownerPs?.projectId);

			// Model inheritance: the child is pinned to the owner's CURRENT model
			// (does not silently widen to a different/system credential).
			const childModel = await pollUntil(async () => gateway.sessionManager.getSession(childId!)?.spawnPinnedModel ?? null,
				{ timeoutMs: 5_000, intervalMs: 25, label: "child spawnPinnedModel" });
			expect(childModel).toBe(`${OPUS.provider}/${OPUS.modelId}`);
		} finally {
			if (childId) await gateway.orchestrationCore.dismiss(owner, childId).catch(() => {});
			await deleteSession(owner);
		}
	});

	test("the host carries orchestration verbs ONLY — no token / raw transport", async ({ gateway }) => {
		const owner = await createSession();
		try {
			const host = await buildHost(gateway, owner);
			// No raw transport escape hatch anywhere on the host or the agents namespace.
			expect((host as Record<string, unknown>).gateway).toBeUndefined();
			expect((host as Record<string, unknown>).fetch).toBeUndefined();
			expect((host.agents as Record<string, unknown>).fetch).toBeUndefined();
			expect((host.agents as Record<string, unknown>).token).toBeUndefined();
			// The agents surface is EXACTLY the six poll-based verbs.
			expect(Object.keys(host.agents).sort()).toEqual(["dismiss", "list", "prompt", "read", "spawn", "status"]);
		} finally {
			await deleteSession(owner);
		}
	});
});
