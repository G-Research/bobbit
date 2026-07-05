/**
 * W2.Q pin: tests/fixtures/build-bundle.js's cache must invalidate when a
 * TRANSITIVE source dependency changes, not just the entry / hand-curated
 * `deps` list.
 *
 * Repro (tonight, pre-fix): agent-interface-dialog-escape.spec.ts passes
 * `deps: [ENTRY, AGENT_INTERFACE_SRC, DIALOGS_SRC]`. AgentInterface.ts
 * transitively imports MessageEditor.ts, which is NOT in that list. A merged
 * change to MessageEditor.ts left the cached bundle looking "fresh" (mtime
 * gate only checked the three listed files) and the spec silently exercised
 * stale code until the cache dir was hand-deleted.
 *
 * This test reproduces that exact shape with a throwaway three-file fixture
 * (entry -> mid -> leaf) and a `deps` list that — just like the real spec —
 * omits the transitive leaf file. It edits the leaf, rebuilds with the same
 * incomplete `deps`, and asserts the bundle picks up the change anyway,
 * because buildBundle() now tracks esbuild's own `--metafile` input set
 * instead of trusting the caller's list.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildBundle } = await import("./fixtures/build-bundle.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-bundle-transitive-"));
after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const entryPath = path.join(root, "entry.ts");
const midPath = path.join(root, "mid.ts");
const leafPath = path.join(root, "leaf.ts");
const outfile = path.join(root, "out", "bundle.js");

function writeLeaf(leafValue: string): void {
	fs.writeFileSync(leafPath, `export const LEAF_VALUE = ${JSON.stringify(leafValue)};\n`);
}

describe("buildBundle transitive dependency invalidation", () => {
	it("rebuilds when a transitive dep changes even though the caller's `deps` list only covers the entry", () => {
		// entry.ts -> mid.ts -> leaf.ts. mid.ts and leaf.ts are written ONCE, up
		// front, and never touched again except leaf.ts's value below — mirrors
		// AgentInterface.ts/dialogs.ts (unchanged) re-exporting from
		// MessageEditor.ts (the file that actually changed).
		fs.mkdirSync(root, { recursive: true });
		writeLeaf("original");
		fs.writeFileSync(midPath, `export { LEAF_VALUE } from "./leaf.js";\n`);
		fs.writeFileSync(entryPath, `import { LEAF_VALUE } from "./mid.js";\n(globalThis as any).__leafValue = LEAF_VALUE;\n`);

		// Mirrors the real bug: callers curate `deps` by hand and it's easy to
		// miss a file the entry imports indirectly. Here `deps` covers only the
		// entry itself — neither mid.ts nor leaf.ts, the transitive files.
		buildBundle({ entry: entryPath, outfile, deps: [entryPath] });
		const firstBuild = fs.readFileSync(outfile, "utf-8");
		assert.match(firstBuild, /original/, "first build should embed the original leaf value");

		// Change ONLY leaf.ts's content and bump ONLY its mtime forward.
		// entry.ts and mid.ts are untouched, exactly like MessageEditor.ts
		// changing underneath AgentInterface.ts/dialogs.ts without those files
		// themselves changing.
		const future = new Date(Date.now() + 5_000);
		writeLeaf("changed");
		fs.utimesSync(leafPath, future, future);

		buildBundle({ entry: entryPath, outfile, deps: [entryPath] });
		const secondBuild = fs.readFileSync(outfile, "utf-8");

		assert.match(secondBuild, /changed/, "rebuild must pick up the transitive leaf change");
		assert.doesNotMatch(secondBuild, /original/, "stale bundle must not survive the transitive change");
		assert.notEqual(secondBuild, firstBuild, "bundle content must differ after the transitive dep changes");
	});

	it("skips the rebuild (stays byte-identical) when nothing tracked has changed", () => {
		const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-bundle-stable-"));
		const stableEntry = path.join(stableRoot, "entry.ts");
		const stableOut = path.join(stableRoot, "out", "bundle.js");
		fs.writeFileSync(stableEntry, `(globalThis as any).__stable = "value";\n`);

		buildBundle({ entry: stableEntry, outfile: stableOut, deps: [stableEntry] });
		const before = fs.statSync(stableOut).mtimeMs;
		const beforeContent = fs.readFileSync(stableOut, "utf-8");

		buildBundle({ entry: stableEntry, outfile: stableOut, deps: [stableEntry] });
		const after1 = fs.statSync(stableOut).mtimeMs;
		const afterContent = fs.readFileSync(stableOut, "utf-8");

		assert.equal(after1, before, "unchanged inputs must not trigger a rebuild");
		assert.equal(afterContent, beforeContent);
		fs.rmSync(stableRoot, { recursive: true, force: true });
	});
});
