import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "../../../tests2/integration/_e2e/e2e-setup.js";
import * as previewArtifacts from "../../../src/server/preview/artifacts.js";
import * as previewMount from "../../../src/server/preview/mount.js";
import { deferred, onceAsync } from "./_helpers/search-preview-fixtures.js";

let emergencyCleanup: (() => Promise<void>) | undefined;

test.describe("Search preview purge ordering", () => {
	test.afterEach(async () => {
		await emergencyCleanup?.();
		emergencyCleanup = undefined;
	});

	test("purge waits for preview artifact deletion without blocking health or session creation", async () => {
		const sessionId = await createSession();
		let unrelatedSessionId: string | undefined;
		const releaseDeletion = deferred();
		let purgePromise: Promise<Response> | undefined;
		const cleanup = onceAsync(async () => {
			releaseDeletion.resolve();
			await purgePromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			if (unrelatedSessionId) await deleteSession(unrelatedSessionId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		});
		emergencyCleanup = cleanup;
		try {
			const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>purge-me</body>", workspaceTab: false }),
			});
			expect(mountResponse.status).toBe(200);
			const artifactSessionDir = previewArtifacts.artifactSessionDir(sessionId);

			const baseFs = previewMount.createPreviewAsyncFs(fs);
			const deletionStarted = deferred();
			let held = false;
			previewArtifacts.setPreviewArtifactFsForTesting({
				...baseFs,
				lstat: async (filePath: fs.PathLike) => {
					if (!held && path.resolve(String(filePath)) === path.resolve(artifactSessionDir)) {
						held = true;
						deletionStarted.resolve();
						await releaseDeletion.promise;
					}
					return baseFs.lstat(filePath);
				},
			});

			let purgeSettled = false;
			purgePromise = apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" })
				.finally(() => { purgeSettled = true; });
			await deletionStarted.promise;
			expect(purgeSettled, "purge response must await preview deletion").toBe(false);

			const health = await apiFetch("/api/health");
			expect(health.status).toBe(200);
			unrelatedSessionId = await createSession();
			expect(purgeSettled, "unrelated requests must complete while deletion remains held").toBe(false);

			releaseDeletion.resolve();
			const purgeResponse = await purgePromise;
			expect(purgeResponse.status).toBe(200);
			await expect(fs.promises.access(artifactSessionDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await cleanup();
		}
	});
});
