import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	GraphStore,
	GraphStoreContainmentError,
	GraphStoreError,
	type GraphCandidate,
	type GraphKind,
	type GraphMeta,
} from "../../market-packs/code-intelligence/src/graph-store.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixtureStore(): Promise<{ store: GraphStore; root: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-store-"));
	roots.push(root);
	return { store: new GraphStore(root, "project/../../untrusted"), root };
}
const component = { name: "api", repo: "../not-a-path-segment", relativePath: "services/api" };
const slot = { kind: "branch" as const, branch: "feature/../../safe", goalId: "goal-a", worktreeId: "wt-a" };

function meta(kind: GraphKind = "branch", head = "head-a"): GraphMeta {
	return {
		schema: 1,
		component: { ...component },
		kind,
		anchor: { cwdMode: "component-root-relative", scanRoots: ["src", "docs"] },
		corpus: { roots: [{ path: "src", tier: "code" }, { path: "docs", tier: "docs" }], trackedOnly: true },
		graphify: { resolvedVersion: "2.3.4", resolvedAt: "2026-01-01T00:00:00.000Z", requiredCapability: "incremental-delta" },
		revisions: { baseRef: "origin/main", baseRev: "base-a", headRev: head },
		build: { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", buildMs: 1000, nodes: 4, edges: 3, bytes: 99, clustered: true, tierLatencyMs: { code: 4, codeDocs: 8 } },
		state: "fresh",
		applied: { changedPaths: ["src/main.ts"], dirtyPaths: [], deltaNodeCount: 1 },
	};
}
async function graph(candidate: GraphCandidate, content = "{}"): Promise<void> {
	await fs.mkdir(path.join(candidate.root, "data"), { recursive: true });
	await fs.writeFile(path.join(candidate.root, "data", "graph.json"), content);
}

async function publish(store: GraphStore, kind: GraphKind = "branch", head = "head-a", options: Parameters<GraphStore["publishCandidate"]>[2] = { slot }): Promise<Awaited<ReturnType<GraphStore["publishCandidate"]>>> {
	const candidate = await store.createCandidate(component);
	await graph(candidate, head);
	return store.publishCandidate(candidate, meta(kind, head), options);
}

describe("GraphStore — host-only contained publication", () => {
	it("hashes hostile project/component/branch identities and exposes only a current metadata snapshot", async () => {
		const { store, root } = await fixtureStore();
		const snapshot = await publish(store);
		const expectedComponentKey = store.componentKey(component);
		assert.match(store.projectKey, /^[a-f0-9]{64}$/);
		assert.match(expectedComponentKey, /^[a-f0-9]{64}$/);
		assert.equal(snapshot.componentKey, expectedComponentKey);

		const files = await fs.readdir(path.join(root, "graphs", store.projectKey));
		assert.deepEqual(files, [expectedComponentKey], "raw project/component identities are never path segments");
		assert.equal(await store.readCurrent(component, { ...slot, branch: "another-branch" }), null, "a distinct server-derived slot cannot address this graph");
		const current = await store.readCurrent(component, slot);
		assert.equal(current?.meta.revisions.headRev, "head-a");
		assert.equal(current?.meta.component.repo, component.repo);

		const artifact = await store.artifactPath(snapshot, "data/graph.json");
		assert.match(artifact, new RegExp(`graphs[\\\\/]${store.projectKey}[\\\\/]${expectedComponentKey}[\\\\/]snapshots`));
		await assert.rejects(() => store.artifactPath(snapshot, "../../checkout/.env"), GraphStoreContainmentError);
	});

	it("publishes metadata last and preserves the last-good current snapshot when a candidate is invalid", async () => {
		const { store } = await fixtureStore();
		await publish(store, "branch", "good");
		const bad = await store.createCandidate(component);
		await graph(bad, "broken");
		await fs.writeFile(path.join(bad.root, "meta.json"), "not store metadata");
		await assert.rejects(
			() => store.publishCandidate(bad, meta("branch", "broken"), { slot }),
			(error: unknown) => error instanceof GraphStoreError && /must not prewrite store metadata/.test(error.message),
		);
		assert.equal((await store.readCurrent(component, slot))?.meta.revisions.headRev, "good");
	});

	it("marks only direct-parent lineage descendants stale and leaves their graph readable with a status banner", async () => {
		const { store } = await fixtureStore();
		const baseSlot = { kind: "primary-base" as const, branch: "main" };
		const base = await publish(store, "primary-base", "A", { slot: baseSlot });
		const parentSlot = { kind: "derived-base" as const, goalId: "parent" };
		const parent = await publish(store, "derived-base", "B", { slot: parentSlot, parent: base });
		const childSlot = { kind: "branch" as const, goalId: "child" };
		const child = await publish(store, "branch", "C", { slot: childSlot, parent });

		assert.deepEqual((await store.markDescendantsStale(base)).map(item => item.id), [parent.id, child.id]);
		assert.equal((await store.readSnapshot(child))?.meta.state, "stale");
		assert.equal((await store.readSnapshot(child))?.meta.staleReason, "parent-advanced");
		assert.equal((await store.readCurrent(component, childSlot))?.meta.revisions.headRev, "C", "stale data remains an honest labelled fallback");
		assert.equal((await store.readSnapshot(base))?.meta.state, "fresh");
	});

	it("clones only external published content and GC never removes current or leased snapshots", async () => {
		const { store } = await fixtureStore();
		const first = await publish(store, "branch", "old");
		const clone = await store.cloneSnapshot(first);
		assert.equal(await fs.readFile(path.join(clone.root, "data", "graph.json"), "utf8"), "old");
		assert.equal(await fs.stat(path.join(clone.root, "meta.json")).catch(() => null), null, "store metadata is not copied into candidates");
		await store.discardCandidate(clone);
		const second = await publish(store, "branch", "new");
		const release = await store.acquireLease(first, 60_000);
		const result = await store.gc(0);
		assert.equal(result.removedSnapshots, 0, "a live lease protects a non-current last-good snapshot");
		await release();
		const next = await store.gc(0);
		assert.equal(next.removedSnapshots, 1);
		assert.equal((await store.readCurrent(component, slot))?.id, second.id);
		assert.equal(await store.readSnapshot(first), null);
	});

	it("rejects visible and reserved hidden symlinks before they can be moved into the host graph store", async () => {
		const { store, root } = await fixtureStore();
		const visible = await store.createCandidate(component);
		await fs.symlink(path.join(root, "outside"), path.join(visible.root, "escape"));
		await assert.rejects(() => store.publishCandidate(visible, meta(), { slot }), GraphStoreContainmentError);

		const hidden = await store.createCandidate(component);
		await fs.symlink(path.join(root, "outside"), path.join(hidden.root, ".leases"));
		await assert.rejects(() => store.publishCandidate(hidden, meta(), { slot }), GraphStoreContainmentError);
	});
});
