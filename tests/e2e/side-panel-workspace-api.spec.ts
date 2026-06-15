import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession, deleteSession } from "./e2e-setup.js";

function proposalTab(sessionId: string, type = "goal") {
	return {
		id: `proposal:${type}`,
		kind: "proposal",
		title: "Goal Proposal",
		label: "Goal",
		source: { type: "proposal", sessionId, proposalType: type },
		updatedAt: 1,
	};
}

function previewTab(sessionId: string, entry = "index.html") {
	return {
		id: `preview:entry:${encodeURIComponent(entry)}`,
		kind: "preview",
		title: entry,
		label: entry,
		source: { type: "preview", sessionId, entry, live: true },
		updatedAt: 1,
	};
}

async function getWorkspace(sessionId: string) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
	expect(resp.status).toBe(200);
	return resp.json();
}

test.describe("side-panel workspace API", () => {
	const cleanup: string[] = [];

	test.afterEach(async () => {
		while (cleanup.length) await deleteSession(cleanup.pop()!);
	});

	test("GET returns empty workspace; open/update/close/resize persist with monotonic revisions and WS broadcast", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const ws = await connectWs(sessionId);
		try {
			const empty = await getWorkspace(sessionId);
			expect(empty).toMatchObject({ version: 1, sessionId, revision: 0, tabs: [], activeTabId: "", sizeMode: "split" });

			const cursor = ws.messageCount();
			const openResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
				method: "POST",
				body: JSON.stringify({ tab: proposalTab(sessionId) }),
			});
			expect(openResp.status).toBe(200);
			const opened = await openResp.json();
			expect(opened.revision).toBe(1);
			expect(opened.tabs.map((tab: any) => tab.id)).toEqual(["proposal:goal"]);
			expect(opened.activeTabId).toBe("proposal:goal");
			const msg: any = await ws.waitForFrom(cursor, (m: any) => m.type === "side_panel_workspace" && m.workspace?.revision === 1);
			expect(msg.sessionId).toBe(sessionId);

			const patchResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent("proposal:goal")}`, {
				method: "PATCH",
				body: JSON.stringify({
					patch: {
						title: "Updated Proposal",
						label: "Updated",
						source: { type: "proposal", sessionId, proposalType: "goal", rev: 2 },
						state: { selectedSection: "details" },
					},
					baseRevision: opened.revision,
				}),
			});
			expect(patchResp.status).toBe(200);
			const patched = await patchResp.json();
			expect(patched.revision).toBe(2);
			expect(patched.tabs[0]).toMatchObject({
				title: "Updated Proposal",
				label: "Updated",
				source: { type: "proposal", sessionId, proposalType: "goal", rev: 2 },
				state: { selectedSection: "details" },
			});
			expect(patched.tabs[0].patch).toBeUndefined();
			expect(patched.tabs[0].baseRevision).toBeUndefined();

			const legacyPatchResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent("proposal:goal")}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "Legacy Direct Patch" }),
			});
			expect(legacyPatchResp.status).toBe(200);
			const legacyPatched = await legacyPatchResp.json();
			expect(legacyPatched.revision).toBe(3);
			expect(legacyPatched.tabs[0].title).toBe("Legacy Direct Patch");
			expect(legacyPatched.tabs[0].source.rev).toBe(2);

			const resizeResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/resize`, {
				method: "POST",
				body: JSON.stringify({ sizeMode: "fullscreen" }),
			});
			expect(resizeResp.status).toBe(200);
			const resized = await resizeResp.json();
			expect(resized.revision).toBe(4);
			expect(resized.sizeMode).toBe("fullscreen");

			const closeResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent("proposal:goal")}`, { method: "DELETE" });
			expect(closeResp.status).toBe(200);
			const closed = await closeResp.json();
			expect(closed.revision).toBe(5);
			expect(closed.tabs).toEqual([]);
			expect(closed.sizeMode).toBe("fullscreen");

			const refetched = await getWorkspace(sessionId);
			expect(refetched.tabs).toEqual([]);
			expect(refetched.sizeMode).toBe("fullscreen");
		} finally {
			ws.close();
		}
	});

	test("reorder requires a current revision and stale reorder returns 409 with latest workspace", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const first = await (await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({ tab: proposalTab(sessionId) }),
		})).json();
		expect(first.revision).toBe(1);
		await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({ tab: previewTab(sessionId) }),
		});

		const stale = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/reorder`, {
			method: "POST",
			body: JSON.stringify({ baseRevision: 1, tabIds: ["preview:entry:index.html", "proposal:goal"] }),
		});
		expect(stale.status).toBe(409);
		const staleBody = await stale.json();
		expect(staleBody.code).toBe("STALE_REVISION");
		expect(staleBody.workspace.revision).toBe(2);

		const ok = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/reorder`, {
			method: "POST",
			body: JSON.stringify({ baseRevision: 2, tabIds: ["preview:entry:index.html", "proposal:goal"] }),
		});
		expect(ok.status).toBe(200);
		const ordered = await ok.json();
		expect(ordered.revision).toBe(3);
		expect(ordered.tabs.map((tab: any) => tab.id)).toEqual(["preview:entry:index.html", "proposal:goal"]);
	});

	test("concurrent opens rebase on latest and both survive", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const [a, b] = await Promise.all([
			apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
				method: "POST",
				body: JSON.stringify({ tab: proposalTab(sessionId) }),
			}),
			apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
				method: "POST",
				body: JSON.stringify({ tab: previewTab(sessionId) }),
			}),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		const workspace = await getWorkspace(sessionId);
		expect(workspace.revision).toBe(2);
		expect(workspace.tabs.map((tab: any) => tab.id).sort()).toEqual(["preview:entry:index.html", "proposal:goal"]);
	});

	test("empty migration stamps metadata once", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const migrate = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/migrate`, {
			method: "POST",
			body: JSON.stringify({ tabs: [], activeTabId: "", sizeMode: "split" }),
		});
		expect(migrate.status).toBe(200);
		const migrated = await migrate.json();
		expect(migrated.revision).toBe(1);
		expect(migrated.tabs).toEqual([]);
		expect(migrated.metadata.migratedFromLocalStorageAt).toBeGreaterThan(0);

		const second = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/migrate`, {
			method: "POST",
			body: JSON.stringify({ tabs: [previewTab(sessionId)] }),
		});
		expect(second.status).toBe(200);
		const ignored = await second.json();
		expect(ignored.revision).toBe(1);
		expect(ignored.tabs).toEqual([]);
	});

	test("migration canonicalizes legacy tabs once and stamps metadata", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const migrate = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/migrate`, {
			method: "POST",
			body: JSON.stringify({
				sizeMode: "collapsed",
				activeTabId: "proposal:goal",
				tabs: [
					proposalTab(sessionId),
					{
						id: "review:My%20Doc",
						kind: "review",
						title: "My Doc",
						label: "Review",
						source: { type: "review", sessionId, title: "My Doc" },
						updatedAt: 1,
					},
				],
			}),
		});
		expect(migrate.status).toBe(200);
		const migrated = await migrate.json();
		expect(migrated.revision).toBe(1);
		expect(migrated.sizeMode).toBe("collapsed");
		expect(migrated.metadata.migratedFromLocalStorageAt).toBeGreaterThan(0);
		expect(migrated.tabs.map((tab: any) => tab.id)).toContain("proposal:goal");
		expect(migrated.tabs.some((tab: any) => /^review:legacy-title-[0-9a-f]{16}$/.test(tab.id))).toBe(true);

		const second = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/migrate`, {
			method: "POST",
			body: JSON.stringify({ tabs: [previewTab(sessionId)] }),
		});
		expect(second.status).toBe(200);
		const ignored = await second.json();
		expect(ignored.revision).toBe(1);
		expect(ignored.tabs.some((tab: any) => tab.id === "preview:entry:index.html")).toBe(false);
	});

	test("PATCH is existing-only, active validates tab ids, and malformed pack tabs are rejected", async () => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const missingPatch = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent("proposal:goal")}`, {
			method: "PATCH",
			body: JSON.stringify({ patch: { title: "No create" }, baseRevision: 0 }),
		});
		expect(missingPatch.status).toBe(404);

		const activeMissing = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/active`, {
			method: "POST",
			body: JSON.stringify({ activeTabId: "proposal:goal" }),
		});
		expect(activeMissing.status).toBe(400);

		const badPack = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({
				tab: {
					id: "pack:bad/pack:panel:default",
					kind: "pack",
					title: "Bad",
					label: "Bad",
					source: { type: "pack", sessionId, packId: "bad/pack", panelId: "panel", instanceKey: "default" },
					updatedAt: 1,
				},
			}),
		});
		expect(badPack.status).toBe(400);
	});
});
