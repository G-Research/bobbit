import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyWorkspaceMutation,
	canonicalizeTab,
	canonicalizeWorkspace,
	emptyWorkspace,
	nextActiveAfterClose,
	SidePanelWorkspaceError,
	SidePanelWorkspaceLocks,
} from "../src/server/side-panel-workspace.ts";
import type { SidePanelWorkspaceTab } from "../src/shared/side-panel-workspace.ts";

const sessionId = "session-1";

function proposalTab(type = "goal", title = "Goal Proposal"): SidePanelWorkspaceTab {
	return {
		id: `proposal:${type}`,
		kind: "proposal",
		title,
		label: "Goal",
		source: { type: "proposal", sessionId, proposalType: type as any },
		updatedAt: 1,
	};
}

function previewTab(entry = "index.html", version?: number): SidePanelWorkspaceTab {
	return {
		id: `preview:entry:${encodeURIComponent(entry)}${version ? `:v:${version}` : ""}`,
		kind: "preview",
		title: entry,
		label: entry,
		source: { type: "preview", sessionId, entry, ...(version ? { historical: true, version } : { live: true }) },
		updatedAt: 1,
	};
}

function reviewTab(documentId = "doc-1", title = "Review"): SidePanelWorkspaceTab {
	return {
		id: `review:${encodeURIComponent(documentId)}`,
		kind: "review",
		title,
		label: title,
		source: { type: "review", sessionId, documentId, title },
		updatedAt: 1,
	};
}

describe("side-panel workspace canonicalization", () => {
	it("normalizes invalid active/size fields and drops invalid tabs", () => {
		const workspace = canonicalizeWorkspace({
			sessionId: "wrong",
			revision: -10,
			activeTabId: "missing",
			sizeMode: "giant",
			tabs: [proposalTab(), { ...proposalTab("bad"), id: "proposal:bad", source: { type: "proposal", sessionId, proposalType: "bad" } }],
		}, sessionId);
		assert.equal(workspace.version, 1);
		assert.equal(workspace.sessionId, sessionId);
		assert.equal(workspace.revision, 0);
		assert.equal(workspace.sizeMode, "split");
		assert.equal(workspace.tabs.length, 1);
		assert.equal(workspace.activeTabId, "proposal:goal");
	});

	it("rejects mismatched source sessions and malformed historical previews", () => {
		assert.equal(canonicalizeTab({ ...proposalTab(), source: { type: "proposal", sessionId: "other", proposalType: "goal" } }, sessionId), null);
		assert.equal(canonicalizeTab({ ...previewTab("index.html"), id: "preview:entry:index.html:v:0", source: { type: "preview", sessionId, entry: "index.html", historical: true, version: 0 } }, sessionId), null);
	});

	it("migrates legacy review-title tabs to deterministic document ids", () => {
		const tab = canonicalizeTab({
			id: "review:My%20Review",
			kind: "review",
			title: "My Review",
			label: "Review",
			source: { type: "review", sessionId, title: "My Review" },
			updatedAt: 1,
		}, sessionId);
		assert.ok(tab);
		assert.match(tab.id, /^review:legacy-title-[0-9a-f]{16}$/);
		assert.equal(tab.source.type, "review");
		assert.match(tab.source.documentId, /^legacy-title-[0-9a-f]{16}$/);
	});

	it("canonicalizes legacy pack ids to default instance and rejects unsafe params", () => {
		const tab = canonicalizeTab({
			id: "pack:artifacts:artifacts.viewer",
			kind: "pack",
			title: "Artifacts",
			label: "Artifacts",
			source: { type: "pack", sessionId, packId: "artifacts", panelId: "artifacts.viewer", params: { artifactId: "a1" } },
			updatedAt: 1,
		}, sessionId);
		assert.ok(tab);
		assert.equal(tab.id, "pack:artifacts:artifacts.viewer:default");
		assert.equal(tab.source.type, "pack");
		assert.equal(tab.source.instanceKey, "default");

		const bad = canonicalizeTab({
			id: "pack:artifacts:artifacts.viewer:default",
			kind: "pack",
			title: "Artifacts",
			label: "Artifacts",
			source: { type: "pack", sessionId, packId: "artifacts", panelId: "artifacts.viewer", instanceKey: "default", params: { huge: "x".repeat(20_000) } },
			updatedAt: 1,
		}, sessionId);
		assert.equal(bad, null);
	});
});

describe("side-panel workspace mutations", () => {
	it("increments revision for committed mutations and preserves size mode", () => {
		let workspace = emptyWorkspace(sessionId, 1);
		workspace = applyWorkspaceMutation(workspace, { type: "open", tab: proposalTab() });
		assert.equal(workspace.revision, 1);
		assert.equal(workspace.activeTabId, "proposal:goal");
		workspace = applyWorkspaceMutation(workspace, { type: "resize", sizeMode: "fullscreen" });
		assert.equal(workspace.revision, 2);
		assert.equal(workspace.sizeMode, "fullscreen");
	});

	it("chooses adjacent active tab on close", () => {
		const tabs = [proposalTab(), previewTab(), reviewTab()];
		assert.equal(nextActiveAfterClose(tabs, "preview:entry:index.html", "preview:entry:index.html"), "review:doc-1");
		assert.equal(nextActiveAfterClose(tabs, "review:doc-1", "review:doc-1"), "preview:entry:index.html");
		assert.equal(nextActiveAfterClose(tabs, "preview:entry:index.html", "proposal:goal"), "proposal:goal");
	});

	it("updates existing tabs only and rejects invalid active/reorder", () => {
		let workspace = applyWorkspaceMutation(emptyWorkspace(sessionId), { type: "open", tab: proposalTab() });
		assert.throws(() => applyWorkspaceMutation(workspace, { type: "update", tabId: "missing", patch: { title: "x" } }), SidePanelWorkspaceError);
		assert.throws(() => applyWorkspaceMutation(workspace, { type: "active", activeTabId: "missing" }), SidePanelWorkspaceError);
		assert.throws(() => applyWorkspaceMutation(workspace, { type: "reorder", tabIds: [] }), SidePanelWorkspaceError);
		workspace = applyWorkspaceMutation(workspace, { type: "update", tabId: "proposal:goal", patch: { title: "Updated" } });
		assert.equal(workspace.tabs[0].title, "Updated");
	});

	it("migrates once with stamp and ignores later migrations", () => {
		let workspace = applyWorkspaceMutation(emptyWorkspace(sessionId), { type: "migrate", tabs: [proposalTab()], activeTabId: "proposal:goal", sizeMode: "collapsed" });
		assert.equal(workspace.revision, 1);
		assert.equal(workspace.tabs.length, 1);
		assert.equal(workspace.sizeMode, "collapsed");
		assert.ok(workspace.metadata?.migratedFromLocalStorageAt);
		const again = applyWorkspaceMutation(workspace, { type: "migrate", tabs: [previewTab()] });
		assert.equal(again.revision, workspace.revision);
		assert.deepEqual(again.tabs.map(tab => tab.id), ["proposal:goal"]);
	});

	it("serializes concurrent mutations under the per-session lock", async () => {
		const locks = new SidePanelWorkspaceLocks();
		const order: string[] = [];
		await Promise.all([
			locks.with(sessionId, async () => {
				await new Promise(resolve => setTimeout(resolve, 25));
				order.push("first");
			}),
			locks.with(sessionId, async () => {
				order.push("second");
			}),
		]);
		assert.deepEqual(order, ["first", "second"]);
	});
});
