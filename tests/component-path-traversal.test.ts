/**
 * Regression: component.repo and component.relativePath must not allow path
 * traversal. Found via implementation gate security review.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { ProjectConfigStore, isSafeRelPath } from "../src/server/agent/project-config-store.ts";

describe("component path traversal", () => {
	it("isSafeRelPath rejects .. segments and absolute paths", () => {
		assert.equal(isSafeRelPath("api"), true);
		assert.equal(isSafeRelPath("packages/api"), true);
		assert.equal(isSafeRelPath("a/b/c"), true);

		assert.equal(isSafeRelPath(".."), false);
		assert.equal(isSafeRelPath("../etc"), false);
		assert.equal(isSafeRelPath("a/../b"), false);
		assert.equal(isSafeRelPath("../../passwd"), false);
		assert.equal(isSafeRelPath("/etc/passwd"), false);
		assert.equal(isSafeRelPath("C:\\Windows"), false);
		assert.equal(isSafeRelPath("a\0b"), false);
	});

	it("ProjectConfigStore drops components with traversal repo or relativePath", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-traverse-"));
		try {
			fs.writeFileSync(
				path.join(dir, "project.yaml"),
				yaml.stringify({
					name: "TestProj",
					components: [
						{ name: "good", repo: "api" },
						{ name: "absolute-repo", repo: "/etc" },
						{ name: "traversal-repo", repo: "../../etc" },
						{ name: "good-rel", repo: "api", relative_path: "packages/api" },
						{ name: "traversal-rel", repo: "api", relative_path: "../../../etc" },
						{ name: "absolute-rel", repo: "api", relative_path: "/etc/passwd" },
					],
				}),
			);

			const cfg = new ProjectConfigStore(dir);
			const components = cfg.getComponents();
			const names = components.map(c => c.name).sort();

			assert.deepEqual(names, ["good", "good-rel"], `unsafe components must be dropped, got: ${names.join(",")}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
