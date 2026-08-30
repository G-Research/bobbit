import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "../../../tests2/integration/_e2e/e2e-setup.js";
import * as previewArtifacts from "../../../src/server/preview/artifacts.js";
import * as previewMount from "../../../src/server/preview/mount.js";
import { deferred, onceAsync, under } from "./_helpers/search-preview-fixtures.js";

let emergencyCleanup: (() => Promise<void>) | undefined;

test.describe("Search preview artifact ordering", () => {
	test.afterEach(async () => {
		await emergencyCleanup?.();
		emergencyCleanup = undefined;
	});

	test("held artifact validation does not block health or session creation and returns the first exact candidate", async ({ gateway }) => {
		const sessionId = await createSession();
		let unrelatedSessionId: string | undefined;
		const fixtureRoot = path.join(gateway.bobbitDir, "preview-async-ordering", randomUUID());
		const releaseHash = deferred();
		let scanPromise: Promise<Response> | undefined;
		let mutationPromise: Promise<Response> | undefined;
		const cleanup = onceAsync(async () => {
			releaseHash.resolve();
			await scanPromise?.catch(() => undefined);
			await mutationPromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			if (unrelatedSessionId) await deleteSession(unrelatedSessionId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
		});
		emergencyCleanup = cleanup;
		try {
			const entryPath = path.join(fixtureRoot, "report.html");
			const assets: string[] = [];
			await fs.promises.mkdir(fixtureRoot, { recursive: true });
			await fs.promises.writeFile(entryPath, "<!doctype html><body>deep-preview</body>", "utf-8");
			let relativeDir = "";
			for (let depth = 0; depth < 12; depth++) {
				relativeDir = path.posix.join(relativeDir, `level-${depth}`);
				const relativeFile = path.posix.join(relativeDir, `asset-${depth}.txt`);
				await fs.promises.mkdir(path.join(fixtureRoot, relativeDir), { recursive: true });
				await fs.promises.writeFile(path.join(fixtureRoot, relativeFile), `asset-${depth}`, "utf-8");
				assets.push(relativeFile);
			}

			const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entryPath, assets, workspaceTab: false }),
			});
			expect(mountResponse.status).toBe(200);
			const mounted = await mountResponse.json() as { artifactId: string; contentHash: string };

			const cloneId = `clone_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
			const cloneDir = previewArtifacts.artifactDir(sessionId, cloneId);
			await fs.promises.cp(previewArtifacts.artifactDir(sessionId, mounted.artifactId), cloneDir, { recursive: true });
			const cloneMetadataPath = path.join(cloneDir, "artifact.json");
			const cloneMetadata = JSON.parse(await fs.promises.readFile(cloneMetadataPath, "utf-8"));
			cloneMetadata.artifactId = cloneId;
			await fs.promises.writeFile(cloneMetadataPath, JSON.stringify(cloneMetadata, null, 2), "utf-8");
			const artifactSessionDir = previewArtifacts.artifactSessionDir(sessionId);
			const candidateEntries = (await fs.promises.readdir(artifactSessionDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && (entry.name === mounted.artifactId || entry.name === cloneId));
			expect(candidateEntries).toHaveLength(2);
			const candidateEntriesById = new Map(candidateEntries.map(entry => [entry.name, entry]));
			const lexicalCandidateIds = [mounted.artifactId, cloneId].sort();
			const streamedCandidateIds = [...lexicalCandidateIds].reverse();
			const streamedCandidateEntries = streamedCandidateIds.map((artifactId) => {
				const entry = candidateEntriesById.get(artifactId);
				expect(entry, `missing real candidate directory ${artifactId}`).toBeDefined();
				return entry!;
			});
			expect(streamedCandidateIds[0]).not.toBe(lexicalCandidateIds[0]);

			const baseFs = previewMount.createPreviewAsyncFs(fs);
			const hashStarted = deferred();
			let held = false;
			previewArtifacts.setPreviewArtifactFsForTesting({
				...baseFs,
				opendir: async (filePath: fs.PathLike) => {
					if (path.resolve(String(filePath)) !== path.resolve(artifactSessionDir)) return baseFs.opendir(filePath);
					let index = 0;
					return {
						read: async () => streamedCandidateEntries[index++] ?? null,
						close: async () => {},
					} as fs.Dir;
				},
				open: async (filePath: fs.PathLike, flags: "r") => {
					if (!held && under(artifactSessionDir, filePath)) {
						held = true;
						hashStarted.resolve();
						await releaseHash.promise;
					}
					return baseFs.open(filePath, flags);
				},
			});

			let scanSettled = false;
			scanPromise = apiFetch(`/api/preview/mount?sessionId=${sessionId}`).finally(() => { scanSettled = true; });
			await hashStarted.promise;
			expect(scanSettled).toBe(false);

			let mutationSettled = false;
			mutationPromise = apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>newer-state</body>", entry: "report.html", workspaceTab: false }),
			}).finally(() => { mutationSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(mutationSettled, "same-session mutation must queue behind the held snapshot").toBe(false);

			const health = await apiFetch("/api/health");
			expect(health.status).toBe(200);
			unrelatedSessionId = await createSession();
			expect(scanSettled, "artifact scan must remain held while unrelated requests complete").toBe(false);
			expect(mutationSettled).toBe(false);

			releaseHash.resolve();
			const scanResponse = await scanPromise;
			expect(scanResponse.status).toBe(200);
			const snapshot = await scanResponse.json() as { artifactId?: string; contentHash?: string };
			expect(snapshot.contentHash).toBe(mounted.contentHash);
			expect(
				snapshot.artifactId,
				"artifact reuse must choose the first valid candidate from the controlled opendir stream",
			).toBe(streamedCandidateIds[0]);
			const mutationResponse = await mutationPromise;
			expect(mutationResponse.status).toBe(200);
			const mutated = await mutationResponse.json() as { contentHash?: string };
			expect(mutated.contentHash).not.toBe(mounted.contentHash);
		} finally {
			await cleanup();
		}
	});
});
