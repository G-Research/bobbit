/**
 * Unit tests for Workflow `category` field.
 *
 * Covers:
 *  1. WorkflowStore parse/serialize round-trip preserves `category`.
 *  2. Builtin YAMLs (defaults/workflows/*.yaml) carry the expected categories.
 *  3. Missing `category` defaults to "goal" semantics in the workflow page.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "yaml";

import { WorkflowStore } from "../src/server/agent/workflow-store.ts";
import type { Workflow } from "../src/server/agent/workflow-store.ts";

describe("Workflow category", () => {
	it("WorkflowStore parses `category: mission` from YAML", async () => {
		const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wf-cat-"));
		try {
			fs.mkdirSync(path.join(tmpDir, "workflows"));
			fs.writeFileSync(path.join(tmpDir, "workflows", "alpha.yaml"),
				"id: alpha\nname: Alpha\ndescription: x\ncategory: mission\ncreatedAt: 1\nupdatedAt: 1\ngates: []\n");
			fs.writeFileSync(path.join(tmpDir, "workflows", "beta.yaml"),
				"id: beta\nname: Beta\ndescription: y\ncategory: goal\ncreatedAt: 1\nupdatedAt: 1\ngates: []\n");
			fs.writeFileSync(path.join(tmpDir, "workflows", "gamma.yaml"),
				"id: gamma\nname: Gamma\ndescription: z\ncreatedAt: 1\nupdatedAt: 1\ngates: []\n");
			const store = new WorkflowStore(tmpDir);
			const all = store.getAll();
			const byId = new Map(all.map(w => [w.id, w] as const));
			assert.equal(byId.get("alpha")?.category, "mission");
			assert.equal(byId.get("beta")?.category, "goal");
			// Missing category stays undefined (defaults applied at consumer level)
			assert.equal(byId.get("gamma")?.category, undefined);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("WorkflowStore serializes `category` round-trip", async () => {
		const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wf-cat-rt-"));
		try {
			const store = new WorkflowStore(tmpDir);
			const wf: Workflow = {
				id: "rt", name: "RT", description: "round-trip",
				gates: [], createdAt: 1, updatedAt: 1, category: "mission",
			};
			store.put(wf);
			const reloaded = new WorkflowStore(tmpDir);
			const back = reloaded.get("rt");
			assert.ok(back);
			assert.equal(back.category, "mission");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("builtin defaults/workflows YAML files declare category as expected", () => {
		const wfDir = path.join(process.cwd(), "defaults", "workflows");
		const files = fs.readdirSync(wfDir).filter(f => f.endsWith(".yaml"));
		const cats: Record<string, string | undefined> = {};
		for (const f of files) {
			const data = parse(fs.readFileSync(path.join(wfDir, f), "utf-8"));
			cats[data.id] = data.category;
		}
		assert.equal(cats["general"], "goal");
		assert.equal(cats["feature"], "goal");
		assert.equal(cats["bug-fix"], "goal");
		assert.equal(cats["quick-fix"], "goal");
		assert.equal(cats["mission"], "mission");
	});
});
