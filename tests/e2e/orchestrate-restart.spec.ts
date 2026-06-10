/**
 * API E2E — Orchestration Core restart survival (sub-goal A §4).
 *
 * The in-process E2E harness has no true gateway-reboot primitive (see
 * harness-restart-api.spec.ts — that only touches a sentinel). As the design
 * doc permits, restart survival is driven at the integration level against the
 * REAL gateway by invoking the same two public OrchestrationCore methods the
 * boot path runs (`rebuildIndexFromPersisted` + `remindOwnersWithLiveChildren`,
 * wired into SessionManager.restoreSessions) over the live SessionManager and
 * persisted session list — NOT a fake. This exercises the genuine
 * survive → remind → re-collect flow end to end.
 *
 * Locked principle: NO transparent tool-call resumption. The child survives;
 * on resume the parent is REMINDED of its live children and re-collects via the
 * shared `team_wait`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession, connectWs, type WsMsg } from "./e2e-setup.js";

test.describe.configure({ mode: "serial" });

async function spawnChild(ownerId: string, instructions: string): Promise<string> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/spawn`, {
		method: "POST",
		body: JSON.stringify({ instructions }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).childSessionId as string;
}

async function listChildren(ownerId: string): Promise<string[]> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/children`);
	expect(resp.status).toBe(200);
	return ((await resp.json()).children ?? []).map((c: any) => c.sessionId);
}

/** Predicate: parent received an [ORCHESTRATION] live-children reminder. */
function orchestrationReminderPredicate(): (m: WsMsg) => boolean {
	return (m) => {
		if (m.type !== "event" || m.data?.type !== "message_end") return false;
		const msg = m.data?.message;
		if (msg?.role !== "user") return false;
		const text = Array.isArray(msg.content)
			? msg.content.map((c: any) => c?.text ?? "").join("")
			: "";
		return text.includes("[ORCHESTRATION]") && text.includes("team_wait");
	};
}

test.describe("orchestration restart survival", () => {
	test("children survive a restart, the parent is reminded, and team_wait re-collects", async ({ gateway }) => {
		const parent = await createSession();
		const child = await spawnChild(parent, "restart-survivor helper");
		const parentWs = await connectWs(parent);
		try {
			// Child is tracked before the simulated restart.
			expect(await listChildren(parent)).toContain(child);

			// ── Simulate a gateway reboot: re-run the boot-time orchestration
			// index rebuild from the already-persisted link fields (no new
			// registry). This is exactly what restoreSessions() invokes.
			const persisted = gateway.projectContextManager.getAllLiveSessions();
			gateway.orchestrationCore.rebuildIndexFromPersisted(persisted);

			// 1) Children SURVIVE — still tracked after the rebuild.
			expect(await listChildren(parent)).toContain(child);

			// 2) Parent is REMINDED of its live children (capture cursor first
			// so we match the reminder even if it arrives before the waiter).
			const cursor = parentWs.messageCount();
			await gateway.orchestrationCore.remindOwnersWithLiveChildren((h: any) => h.childKind !== "team");
			await parentWs.waitForFrom(cursor, orchestrationReminderPredicate(), 15_000);

			// 3) The parent re-collects via the SHARED team_wait — no transparent
			// resumption, just the normal wait path.
			const waitResp = await apiFetch(`/api/sessions/${parent}/orchestrate/wait`, {
				method: "POST",
				body: JSON.stringify({ childSessionIds: [child], timeout_ms: 15_000 }),
			});
			expect(waitResp.status).toBe(200);
			const waitJson = await waitResp.json();
			expect(waitJson.firstIdle).toBe(child);

			// 4) No orphan — dismiss cleans it up.
			const dismiss = await apiFetch(`/api/sessions/${parent}/orchestrate/dismiss`, {
				method: "POST",
				body: JSON.stringify({ childSessionId: child }),
			});
			expect(dismiss.status).toBe(200);
			expect(await listChildren(parent)).not.toContain(child);
		} finally {
			parentWs.close();
			await deleteSession(parent);
		}
	});

	test("a child whose owner is gone/archived is reaped on rebuild", async ({ gateway }) => {
		const parent = await createSession();
		const child = await spawnChild(parent, "to-be-orphaned helper");
		expect(await listChildren(parent)).toContain(child);

		// Archive the owner — terminateSession cascades to archive the child.
		const del = await apiFetch(`/api/sessions/${parent}`, { method: "DELETE" });
		expect(del.ok).toBe(true);

		// On the next boot rebuild, the archived child is NOT re-tracked under
		// the (now-gone) owner — i.e. it is reaped, not orphaned.
		const persisted = gateway.projectContextManager.getAllLiveSessions();
		gateway.orchestrationCore.rebuildIndexFromPersisted(persisted);
		expect(gateway.orchestrationCore.list(parent)).toHaveLength(0);

		await deleteSession(child).catch(() => {});
	});
});
