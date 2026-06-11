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
import { readFileSync } from "node:fs";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession, connectWs, type WsMsg } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

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

	// H1: after a restart, delegate children are re-added DORMANT (status
	// "terminated" + placeholder RpcBridge). team_wait must collect such a child
	// from its PERSISTED output immediately — never block on a dead placeholder
	// until the timeout. We reproduce the dormant state by replacing the live
	// child entry with a dormant one (exactly what restoreSessions() does for a
	// delegate after a real reboot), then assert team_wait returns PROMPTLY with
	// the persisted output rather than `timeout`.
	test("team_wait collects a restored DORMANT child's persisted output well under the timeout", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		const parent = await createSession();
		const child = await spawnChild(parent, "dormant-collect helper");
		try {
			// Let the child run its spawn prompt to completion (mock agent → "OK")
			// so a persisted transcript with assistant output exists.
			await pollUntil(async () => sm.getSession(child)?.status === "idle" ? true : null,
				{ timeoutMs: 15_000, intervalMs: 50, label: "child idle before dormancy" });
			await pollUntil(async () => (await sm.getSessionOutput(child)).includes("OK") ? true : null,
				{ timeoutMs: 15_000, intervalMs: 50, label: "child output persisted" });

			// Simulate the restart: re-add the child as DORMANT from its persisted
			// record (the boot delegate-dormancy path). The index already tracks it.
			const ps = sm.getPersistedSession(child);
			expect(ps?.agentSessionFile).toBeTruthy();
			(sm as any).addDormantSession(ps);
			expect(sm.isSessionLive(child)).toBe(false);

			// team_wait against the dormant child: returns PROMPTLY (well under the
			// 15s timeout) with the persisted output, settled as idle — not `timeout`.
			const started = Date.now();
			const waitResp = await apiFetch(`/api/sessions/${parent}/orchestrate/wait`, {
				method: "POST",
				body: JSON.stringify({ childSessionIds: [child], timeout_ms: 15_000 }),
			});
			expect(waitResp.status).toBe(200);
			const waitJson = await waitResp.json();
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(waitJson.firstIdle).toBe(child);
			expect(waitJson.statuses[0].status).toBe("idle");
			expect(waitJson.statuses[0].status).not.toBe("timeout");
			expect(waitJson.outputTail ?? "").toContain("OK");
		} finally {
			await deleteSession(child).catch(() => {});
			await deleteSession(parent).catch(() => {});
		}
	});

	// REPRODUCING TEST (TDD): delegate children must SURVIVE a real reboot LIVE,
	// not as a dormant `terminated` husk, and their task must be rebuilt into the
	// reassembled system prompt. Today restoreSessions() carves delegates out of
	// the live-restore path (regular = !delegateOf → restoreSession; delegates =
	// !!delegateOf → addDormantSession), and instructions/context are never
	// persisted — so after a reboot the child comes back DORMANT (isSessionLive
	// === false) with no task in its prompt. This test FAILS today on the
	// isSessionLive assertion and PASSES once the fix (1) persists the task,
	// (2) restores delegates live, (3) rebuilds the delegate prompt from the
	// persisted task. Uses the exact steer-gateway-restart.spec.ts reboot
	// primitive (teardown live SessionInfo + restoreSessions()).
	test("a delegate child is restored LIVE with its task intact across a restoreSessions reboot", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		const parent = await createSession();
		// Distinctive marker so we can assert it lands in the rebuilt system prompt.
		const child = await spawnChild(parent, "restart-live-survivor-MARKER helper task");
		try {
			// Drive the child's spawn prompt to completion (mock agent → "OK") so a
			// persisted transcript + agentSessionFile exist before the reboot.
			await pollUntil(async () => sm.getSession(child)?.status === "idle" ? true : null,
				{ timeoutMs: 15_000, intervalMs: 50, label: "child idle before reboot" });
			await pollUntil(async () => (await sm.getSessionOutput(child)).includes("OK") ? true : null,
				{ timeoutMs: 15_000, intervalMs: 50, label: "child output persisted" });
			expect(sm.getPersistedSession(child)?.agentSessionFile).toBeTruthy();

			// ── Simulate a clean gateway reboot (steer-gateway-restart.spec.ts
			// primitive): tear down the live child SessionInfo and drop it from the
			// in-memory Map, then re-run the boot restore path. restoreSessions()
			// re-reads the persisted live list — the same code the server runs at boot.
			const liveChild = sm.sessions.get(child);
			expect(liveChild, "child live before reboot").toBeTruthy();
			liveChild.unsubscribe();
			try { await liveChild.rpcClient.stop(); } catch { /* already dead */ }
			sm.sessions.delete(child);

			await sm.restoreSessions();

			// CORE REPRO — the delegate must come back LIVE, not a dormant
			// `terminated` placeholder. FAILS today (delegate → addDormantSession →
			// dormant === true → isSessionLive false).
			expect(sm.isSessionLive(child)).toBe(true);

			// TASK INTACT — two STRICT, independent pins (no OR-fallback, so a broken
			// prompt rebuild can't be masked by the durable field, and vice versa):
			//
			//  (a) PROMPT REBUILD — restoreSession() writes the reassembled prompt to
			//      <prompts-dir>/<id>.md and records it on bridgeOptions.systemPromptPath;
			//      the in-process mock bridge preserves `options`, so we read the actual
			//      assembled prompt file the restored agent would receive. The marker must
			//      be present here — proving the prompt was genuinely rebuilt from the task.
			//  (b) DURABLE FIELD — the persisted `instructions` field on the session
			//      record must carry the marker — proving the task survived to disk.
			const restored = sm.sessions.get(child);
			const promptPath = (restored?.rpcClient as any)?.options?.systemPromptPath as string | undefined;
			let promptText = "";
			if (promptPath) {
				try { promptText = readFileSync(promptPath, "utf-8"); } catch { /* file gone */ }
			}
			const ps = sm.getPersistedSession(child) as any;
			expect(promptText).toContain("restart-live-survivor-MARKER");
			expect(`${ps?.instructions ?? ""}`).toContain("restart-live-survivor-MARKER");
		} finally {
			await deleteSession(child).catch(() => {});
			await deleteSession(parent).catch(() => {});
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

	// The two tests above drive the boot helpers DIRECTLY. This one asserts the
	// actual WIRING: that SessionManager.restoreSessions() invokes the rebuild +
	// the reminder with the childKind!=="team" filter, and that its delegate
	// boot-reap archives an orphaned (owner-archived) live child. Deterministic —
	// no real reboot, no real LLM. restoreOneSession is stubbed so re-running
	// restore does not re-spawn already-live regular sessions.
	test("restoreSessions() wires the rebuild + team-filtered reminder and boot-reaps an orphaned child", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		const core = gateway.orchestrationCore;
		const parent = await createSession();
		const child = await spawnChild(parent, "orphan-on-boot helper");
		expect(await listChildren(parent)).toContain(child);

		// Spy on the two orchestration boot hooks; delegate to the originals.
		const origRebuild = core.rebuildIndexFromPersisted.bind(core);
		const origRemind = core.remindOwnersWithLiveChildren.bind(core);
		const origRestoreOne = (sm as any).restoreOneSession;
		let rebuildCalled = false;
		let remindFilter: ((h: any) => boolean) | undefined;
		core.rebuildIndexFromPersisted = (p: any) => { rebuildCalled = true; return origRebuild(p); };
		core.remindOwnersWithLiveChildren = (f: any) => { remindFilter = f; return origRemind(f); };
		(sm as any).restoreOneSession = async () => { /* skip heavy live-session restore */ };

		try {
			// Archive ONLY the parent at the store level (no terminate cascade) so the
			// child remains LIVE but orphaned — the exact state the boot-reap closes.
			const projectId = sm.getPersistedSession(parent)?.projectId;
			sm.getSessionStore(projectId).archive(parent);

			await sm.restoreSessions();

			// Rebuild + reminder were actually invoked by restoreSessions().
			expect(rebuildCalled).toBe(true);
			expect(typeof remindFilter).toBe("function");
			// The reminder filter skips team-managed children (team-manager nudges
			// those separately) but covers delegate children.
			expect(remindFilter!({ childKind: "team" })).toBe(false);
			expect(remindFilter!({ childKind: "delegate" })).toBe(true);

			// Boot-reap: the orphaned (owner-archived) live child is archived, not left
			// as a live orphan.
			const stillLive = gateway.projectContextManager.getAllLiveSessions().some((s: any) => s.id === child);
			expect(stillLive).toBe(false);
		} finally {
			core.rebuildIndexFromPersisted = origRebuild;
			core.remindOwnersWithLiveChildren = origRemind;
			(sm as any).restoreOneSession = origRestoreOne;
			await deleteSession(child).catch(() => {});
			await deleteSession(parent).catch(() => {});
		}
	});

	// Finding #3: the generalized boot-reap must cover EVERY child linked by
	// parentSessionId+childKind (not only delegateOf and not only pr-walkthrough).
	// A full-lifecycle host-agents child has parentSessionId+childKind but NO
	// delegateOf, so it flows through restoreOneSession's regular path — without
	// the generalized reap it would be restored as a LIVE ORPHAN when its parent
	// was archived while the server was down.
	test("a non-delegate kinded child (parentSessionId+childKind) is boot-reaped when its parent is archived", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		const parent = await createSession();
		const parentProjectId = sm.getPersistedSession(parent)?.projectId;
		// A kinded child linked by parentSessionId+childKind, NOT delegateOf.
		const childInfo = await sm.createSession(
			sm.getSession(parent)?.cwd,
			undefined, undefined, undefined,
			{ parentSessionId: parent, childKind: "host-agents", projectId: parentProjectId },
		);
		const child = childInfo.id;
		try {
			const cps = sm.getPersistedSession(child);
			expect(cps?.childKind).toBe("host-agents");
			expect(cps?.delegateOf).toBeFalsy();
			expect(cps?.parentSessionId).toBe(parent);

			// Archive the parent at the store level (no terminate cascade) so the
			// child stays LIVE but orphaned — the exact state the boot-reap closes.
			const projectId = sm.getPersistedSession(parent)?.projectId;
			sm.getSessionStore(projectId).archive(parent);

			// Drive the per-session boot path restoreSessions() runs for regular
			// sessions; the generalized reap branch archives the orphan before any
			// re-spawn and returns early.
			await (sm as any).restoreOneSession(sm.getPersistedSession(child));

			const stillLive = gateway.projectContextManager.getAllLiveSessions().some((s: any) => s.id === child);
			expect(stillLive).toBe(false);
		} finally {
			await deleteSession(child).catch(() => {});
			await deleteSession(parent).catch(() => {});
		}
	});
});
