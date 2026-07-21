import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./_e2e/e2e-setup.js";
import * as previewArtifacts from "../../src/server/preview/artifacts.js";
import * as previewMount from "../../src/server/preview/mount.js";

test.describe("preview purge listener error ownership", () => {
	test("purge completes after the awaited preview listener owns a deletion failure", async () => {
		const sessionId = await createSession();
		let purged = false;
		const baseFs = previewMount.createPreviewAsyncFs(fs);
		const artifactSessionDir = previewArtifacts.artifactSessionDir(sessionId);
		try {
			const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>listener-error</body>", workspaceTab: false }),
			});
			expect(mountResponse.status).toBe(200);
			await expect(fs.promises.access(artifactSessionDir)).resolves.toBeUndefined();

			previewArtifacts.setPreviewArtifactFsForTesting({
				...baseFs,
				lstat: async (filePath: fs.PathLike) => {
					if (path.resolve(String(filePath)) === path.resolve(artifactSessionDir)) {
						const error = new Error("injected preview purge failure") as NodeJS.ErrnoException;
						error.code = "EACCES";
						throw error;
					}
					return baseFs.lstat(filePath);
				},
			});

			const purgeResponse = await apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
			expect(purgeResponse.status).toBe(200);
			purged = true;
			await expect(fs.promises.access(artifactSessionDir)).resolves.toBeUndefined();
			const health = await apiFetch("/api/health");
			expect(health.status).toBe(200);
		} finally {
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			await previewArtifacts.removeArtifacts(sessionId).catch(() => undefined);
			if (!purged) await deleteSession(sessionId).catch(() => undefined);
		}
	});
});
