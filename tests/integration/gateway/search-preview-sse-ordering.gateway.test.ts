import fs from "node:fs";

import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import * as previewArtifacts from "../../../src/server/preview/artifacts.js";
import * as previewMount from "../../../src/server/preview/mount.js";
import { deferred, onceAsync, readPreviewEvents, under } from "./_helpers/search-preview-fixtures.js";

let emergencyCleanup: (() => Promise<void>) | undefined;

test.describe("Search preview SSE ordering", () => {
	test.afterEach(async () => {
		await emergencyCleanup?.();
		emergencyCleanup = undefined;
	});

	test("SSE bootstrap precedes a queued live mutation while artifact validation is pending", async () => {
		const sessionId = await createSession();
		const releaseHash = deferred();
		const abort = new AbortController();
		let mutationPromise: Promise<Response> | undefined;
		let eventsPromise: Promise<Array<Record<string, unknown>>> | undefined;
		const cleanup = onceAsync(async () => {
			releaseHash.resolve();
			abort.abort();
			await mutationPromise?.catch(() => undefined);
			await eventsPromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			await deleteSession(sessionId).catch(() => {});
		});
		emergencyCleanup = cleanup;
		try {
			const oldMount = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>bootstrap</body>", workspaceTab: false }),
			});
			expect(oldMount.status).toBe(200);
			const oldState = await oldMount.json() as { contentHash: string; artifactId: string };

			const baseFs = previewMount.createPreviewAsyncFs(fs);
			const hashStarted = deferred();
			let held = false;
			previewArtifacts.setPreviewArtifactFsForTesting({
				...baseFs,
				open: async (filePath: fs.PathLike, flags: "r") => {
					if (!held && under(previewArtifacts.artifactSessionDir(sessionId), filePath)) {
						held = true;
						hashStarted.resolve();
						await releaseHash.promise;
					}
					return baseFs.open(filePath, flags);
				},
			});

			const streamResponse = await fetch(`${base()}/api/sessions/${sessionId}/preview-events`, {
				headers: { Authorization: `Bearer ${readE2EToken()}` },
				signal: abort.signal,
			});
			expect(streamResponse.status).toBe(200);
			eventsPromise = readPreviewEvents(streamResponse, 2);
			await hashStarted.promise;

			let mutationSettled = false;
			mutationPromise = apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>live</body>", workspaceTab: false }),
			}).finally(() => { mutationSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(mutationSettled).toBe(false);

			releaseHash.resolve();
			const mutationResponse = await mutationPromise;
			expect(mutationResponse.status).toBe(200);
			const liveState = await mutationResponse.json() as { contentHash: string; artifactId: string };
			const events = await eventsPromise;
			expect(events).toHaveLength(2);
			expect(events[0]?.contentHash).toBe(oldState.contentHash);
			expect(events[0]?.artifactId).toBe(oldState.artifactId);
			expect(events[1]?.contentHash).toBe(liveState.contentHash);
			expect(events[1]?.artifactId).toBe(liveState.artifactId);
		} finally {
			await cleanup();
		}
	});
});
