import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject } from "./_e2e/e2e-setup.js";

const temporaryRoots: string[] = [];
test.afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.describe("managed-service gateway wiring", () => {
	test("rejects project-root replacement while its live context owns managed-service state", async () => {
		const project = await defaultProject();
		const replacement = fs.mkdtempSync(path.join(project.rootPath, ".managed-service-replacement-"));
		temporaryRoots.push(replacement);

		const response = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
			method: "PUT",
			body: JSON.stringify({ rootPath: replacement }),
		});
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), {
			error: "Project root cannot be replaced while project state is active",
			code: "PROJECT_ROOT_REPLACEMENT_REQUIRES_CONTEXT_REMOVAL",
		});
	});
});
