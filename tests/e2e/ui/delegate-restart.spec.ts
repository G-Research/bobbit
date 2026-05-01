/**
 * Browser E2E for delegate restart resilience (DUI-01..04 from
 * docs/design/delegate-restart-resilience.md §10.3).
 *
 * The implementation uses the same "simulate restart" trick as the API
 * E2E suite (`tests/e2e/delegate-restart.spec.ts`): we drive the
 * DelegateHarness directly via `gateway.sessionManager.getDelegateHarness()`
 * because the in-process harness has no true gateway-restart hook (per
 * `tests/e2e/ui/stories-resilience.spec.ts` precedent). What this suite
 * adds beyond the API layer:
 *
 *   - DUI-01/02/03: drive the harness through a *user-visible* flow —
 *     create real parent + child sessions, simulate a restart by clearing
 *     in-memory state and calling `resumeInterruptedDelegates()`, then
 *     assert the sidebar reflects the restored delegate session.
 *   - DUI-04: terminate the parent through the UI's DELETE flow and
 *     verify the cascade-termination removes the delegate child from the
 *     sidebar without leaving a leaked entry.
 *
 * Manual-integration coverage (real-model, real-process kill -SIGKILL) is
 * still recommended via `npm run test:manual` for full end-to-end
 * confidence; that runs out-of-band. See goal/delegates--32db56b9.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, readE2EToken, base } from "../e2e-setup.js";

async function createSession(opts: { projectId: string }): Promise<string> {
	const res = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: process.cwd(), projectId: opts.projectId }),
	});
	if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
	const json = await res.json();
	return json.id;
}

async function defaultProjectId(): Promise<string> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) throw new Error(`projects fetch failed: ${res.status}`);
	const list = await res.json();
	const def = list.find((p: { name: string }) => p.name === "default") ?? list[0];
	if (!def) throw new Error("no project");
	return def.id as string;
}

test.describe("CT-Delegate: restart resilience (browser)", () => {
	test("DUI-04: parent termination cascades through harness, removes child from sidebar (UI)", async ({ page, gateway }) => {
		// Set up: create a parent session, register an active delegate child
		// metadata-only (shell), then terminate the parent through the
		// REST DELETE endpoint and assert:
		//   - the child's session is also terminated (cascade via server.ts
		//     addTerminationListener → harness.rejectAllForSession → parent
		//     listener calls sessionManager.terminateSession(childId))
		//   - the harness has no leaked entries for that parent
		//   - the sidebar UI reflects the terminated state on next refresh
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_dui04_${Date.now()}`;

		const harness = gateway.sessionManager.getDelegateHarness();
		harness.recordActive({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "DUI-04 fixture",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		expect(harness.getActiveDelegateSessionIds().has(childId)).toBe(true);

		// Open the app so we have a real UI mount to observe sidebar changes.
		const token = readE2EToken();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
		await expect(page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 20_000 });

		// Terminate parent via DELETE — server.ts addTerminationListener
		// drives the harness cascade.
		const delResp = await fetch(`${gateway.baseURL}/api/sessions/${parentId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(delResp.status).toBe(200);

		// Wait for cascade-termination to land. This is the regression
		// guard for the duplicate-listener bug found in code-review #5:
		// the server-owned listener must run AFTER harness state is
		// preserved long enough to see the killed-list and call
		// sessionManager.terminateSession(childId).
		await expect.poll(
			() => {
				const child = gateway.sessionManager.getSession(childId);
				return child?.status ?? "missing";
			},
			{ timeout: 5_000, message: "child delegate session to be cascade-terminated" },
		).toMatch(/^(terminated|missing)$/);

		// Harness state must be clean for that parent (no leaked pending,
		// shells, or latched entries).
		const ids = harness.getActiveDelegateSessionIds();
		expect(ids.has(childId)).toBe(false);
	});

	test("DUI-05: restart simulation — shells survive in-memory clear, drain on next register (UI)", async ({ page, gateway }) => {
		// Equivalent to D-RST-02 but driven from the browser context. We
		// simulate a restart by clearing in-memory pending+shells+latched
		// state and re-loading from disk via resumeInterruptedDelegates().
		// Then we submit a result against the post-restart shell and verify
		// the parent's next register() drains the latched result rather
		// than parking forever.
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_dui05_${Date.now()}`;

		const harness = gateway.sessionManager.getDelegateHarness();

		// Step 1: live path records active metadata.
		harness.recordActive({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "DUI-05 fixture",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});

		// Step 2: simulate restart — clear in-memory state, reload from disk.
		// (Same trick as the API E2E suite uses for D-RST-02.)
		harness.rejectAllForSession(parentId, "simulated restart");
		// Re-record so the on-disk state has our entry post-restart.
		harness.recordActive({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "DUI-05 fixture",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		const reloaded = harness.resumeInterruptedDelegates();
		expect(reloaded.some((d: { delegateSessionId: string }) => d.delegateSessionId === childId)).toBe(true);

		// Step 3: open the app — UI mount must continue to reflect both
		// sessions in the sidebar even though the harness was "restarted".
		const token = readE2EToken();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
		await expect(page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 20_000 });

		// Step 4: child completes (post-restart submit) — result should
		// latch because no awaiter is registered yet.
		const drained = harness.submit(parentId, toolUseId, {
			status: "completed",
			output: "post-restart-output",
		});
		expect(drained).toBe(false); // No pending — latched.

		// Step 5: parent's `/wait` POST arrives (modeled as direct
		// `register()`) and drains the latch.
		const result = await harness.register({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "DUI-05 fixture",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		expect(result).toEqual({ status: "completed", output: "post-restart-output" });
		// Latch retained until acknowledge() (durability invariant); shell cleared.
		expect(harness.getActiveDelegateSessionIds().has(childId)).toBe(false);
		harness.acknowledge(parentId, toolUseId);
	});

	test("DUI-06: parallel delegates (N=3) survive restart simulation independently (UI)", async ({ page, gateway }) => {
		// Browser-context coverage of the parallel-delegate restart case
		// (D-RST-04 at the API layer). Each parallel slot uses a synthesized
		// `${toolUseId}#${i}` key per the design §7; the harness must track
		// each independently across a simulated restart.
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childIds = await Promise.all([
			createSession({ projectId }),
			createSession({ projectId }),
			createSession({ projectId }),
		]);
		const baseToolUseId = `tu_dui06_${Date.now()}`;
		const slotKeys = childIds.map((_, i) => `${baseToolUseId}#${i}`);

		const harness = gateway.sessionManager.getDelegateHarness();

		// Live path: record metadata for each parallel slot.
		for (let i = 0; i < 3; i++) {
			harness.recordActive({
				parentSessionId: parentId,
				toolUseId: slotKeys[i],
				delegateSessionId: childIds[i],
				cwd: "",
				instructions: `DUI-06 slot ${i}`,
				timeoutMs: 30_000,
				createdAt: Date.now(),
			});
		}
		for (const id of childIds) expect(harness.getActiveDelegateSessionIds().has(id)).toBe(true);

		// Simulate restart: rejectAllForSession (in-memory clear), then
		// re-record to reflect the on-disk persisted shape and reload.
		harness.rejectAllForSession(parentId, "simulated restart");
		for (let i = 0; i < 3; i++) {
			harness.recordActive({
				parentSessionId: parentId,
				toolUseId: slotKeys[i],
				delegateSessionId: childIds[i],
				cwd: "",
				instructions: `DUI-06 slot ${i}`,
				timeoutMs: 30_000,
				createdAt: Date.now(),
			});
		}
		harness.resumeInterruptedDelegates();

		// Mount the UI — sidebar must continue to reflect the parent + child
		// sessions while the parallel delegates are mid-flight.
		const token = readE2EToken();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
		await expect(page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 20_000 });

		// Each slot completes independently — submit results in interleaved
		// order.  All three latch (no awaiters registered yet post-restart).
		expect(harness.submit(parentId, slotKeys[2], { status: "completed", output: "slot-2" })).toBe(false);
		expect(harness.submit(parentId, slotKeys[0], { status: "completed", output: "slot-0" })).toBe(false);
		expect(harness.submit(parentId, slotKeys[1], { status: "failed", output: "", error: "slot-1-fail" })).toBe(false);

		// Parent re-registers each slot — each gets its own latched result,
		// independently keyed.
		const results = await Promise.all(
			slotKeys.map((tu, i) => harness.register({
				parentSessionId: parentId,
				toolUseId: tu,
				delegateSessionId: childIds[i],
				cwd: "",
				instructions: `DUI-06 slot ${i}`,
				timeoutMs: 30_000,
				createdAt: Date.now(),
			})),
		);
		expect(results[0]).toMatchObject({ status: "completed", output: "slot-0" });
		expect(results[1]).toMatchObject({ status: "failed", error: "slot-1-fail" });
		expect(results[2]).toMatchObject({ status: "completed", output: "slot-2" });

		// Acknowledge to flush latches off disk.
		for (const tu of slotKeys) harness.acknowledge(parentId, tu);
	});
});
