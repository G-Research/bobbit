/**
 * v2 integration — host.agents SANDBOX / CREDENTIAL INHERITANCE (no escalation).
 *
 * Ported faithfully from tests/e2e/host-agents-sandbox-inheritance.spec.ts
 * (source of truth) onto the Test Suite v2 fork-scoped gateway fixture +
 * in-process mock bridge. The host.agents namespace SHAPE + source-filtered
 * scoping is unit-covered by tests2/core/host-agents-scope.test.ts (FakeView);
 * this port preserves the REAL-STACK sub-behaviours the triage flagged as lost:
 *   • a host.agents child inherits the bound session's sandbox + project scope
 *     + CURRENT model (plain lifecycle),
 *   • a FULL-lifecycle child also inherits the owner's sandbox + project scope,
 *   • a read-only child registers NO mutating tools (allow-list gating),
 *   • the host carries orchestration verbs ONLY — no token / raw transport.
 *
 * A child launched through `host.agents.spawn` is created by the SAME
 * `OrchestrationCore.spawn` the agent-tool path uses, which propagates the
 * bound session's sandbox + project (credential) scope and never grants a
 * capability the owner lacks. Deterministic mock agent → e2e phase, not manual.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { createSession, deleteSession, connectWs, apiFetch } from "./_e2e/e2e-setup.js";
import { createServerHostApi } from "../../src/server/extension-host/server-host-api.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-4-8" };

/** Poll a predicate until it returns a truthy value, or throw on timeout. */
async function pollUntil<T>(
	predicate: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const intervalMs = opts.intervalMs ?? 50;
	const label = opts.label ?? "predicate";
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < timeoutMs) {
		try { const v = await predicate(); if (v) return v; } catch (err) { lastErr = err; }
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const errSuffix = lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : "";
	throw new Error(`pollUntil("${label}") timed out after ${Date.now() - start}ms${errSuffix}`);
}

function buildHost(gateway: any, ownerId: string): any {
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
	const conn = await connectWs(sessionId);
	try {
		conn.send({ type: "set_model", provider, modelId });
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === provider && data.modelId === modelId ? true : null;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "owner model persisted" });
	} finally {
		conn.close();
	}
}

test.describe("host.agents — sandbox / credential inheritance (no escalation)", () => {
	test("a host.agents child inherits the bound session's sandbox + project scope and model", async ({ gateway }) => {
		const owner = await createSession();
		const host = buildHost(gateway, owner);
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

	test("a FULL-lifecycle host.agents child also inherits the owner's sandbox + project scope (no escalation)", async ({ gateway }) => {
		// HIGH: the createSession (lifecycle:"full") spawn path historically threaded
		// NEITHER `sandboxed` NOR `projectId`, so a full-lifecycle child of a
		// sandboxed / project-scoped owner could be created OUTSIDE that scope.
		// Driving a real Docker-sandboxed owner here is impractical (test:manual);
		// the SANDBOXED case is pinned at the unit level (orchestration-core.test.ts).
		// This pins, through the REAL stack, that the full path threads the owner's
		// scope verbatim and never widens it.
		const owner = await createSession();
		const host = buildHost(gateway, owner);
		let childId: string | undefined;
		try {
			const ownerPs = gateway.sessionManager.getPersistedSession(owner);
			const ha = await host.agents.spawn({ instructions: "full-lifecycle child", lifecycle: "full" });
			childId = ha.childSessionId;
			const childPs = await pollUntil(async () => gateway.sessionManager.getPersistedSession(childId!) ?? null,
				{ timeoutMs: 5_000, intervalMs: 25, label: "child persisted" });
			// Linkage + scope inheritance: the child cannot exceed the owner's reach.
			expect(childPs.parentSessionId).toBe(owner);
			expect(Boolean(childPs.sandboxed)).toBe(Boolean(ownerPs?.sandboxed));
			expect(childPs.projectId).toBe(ownerPs?.projectId);
		} finally {
			if (childId) await gateway.orchestrationCore.dismiss(owner, childId).catch(() => {});
			await deleteSession(owner);
		}
	});

	test("a read-only host.agents child does NOT register mutating tools (finding #1)", async ({ gateway }) => {
		const owner = await createSession();
		const host = buildHost(gateway, owner);
		let childId: string | undefined;
		try {
			const ha = await host.agents.spawn({ instructions: "read-only child", readOnly: true });
			childId = ha.childSessionId;
			const childPs = await pollUntil(async () => gateway.sessionManager.getPersistedSession(childId!) ?? null,
				{ timeoutMs: 5_000, intervalMs: 25, label: "child persisted" });
			const tools: string[] = gateway.sessionManager.getSession(childId!)?.allowedTools ?? childPs.allowedTools ?? [];
			// readOnly is enforced via the allow-list (mutating tools never registered)…
			for (const t of ["write", "edit", "bash", "bash_bg"]) {
				expect(tools).not.toContain(t);
			}
			// …and read/search tools survive.
			expect(tools).toContain("read");
			// The read-only marker is persisted on the child.
			expect(Boolean(childPs.readOnly)).toBe(true);
		} finally {
			if (childId) await gateway.orchestrationCore.dismiss(owner, childId).catch(() => {});
			await deleteSession(owner);
		}
	});

	test("the host carries orchestration verbs ONLY — no token / raw transport", async ({ gateway }) => {
		const owner = await createSession();
		try {
			const host = buildHost(gateway, owner);
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
