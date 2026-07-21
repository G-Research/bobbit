import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "./_e2e/e2e-setup.js";
import * as previewArtifacts from "../../src/server/preview/artifacts.js";
import * as previewMount from "../../src/server/preview/mount.js";

const SIGNED_COOKIE_VALUE = String.raw`v1\.[1-9]\d*\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function under(root: string, candidate: fs.PathLike): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(String(candidate)));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPreviewEvents(response: Response, count: number): Promise<Array<Record<string, unknown>>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("preview SSE response has no body");
	const decoder = new TextDecoder();
	let buffered = "";
	const events: Array<Record<string, unknown>> = [];
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const frames = buffered.split("\n\n");
		buffered = frames.pop() ?? "";
		for (const frame of frames) {
			if (!frame.startsWith("event: preview-changed\n")) continue;
			const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
			if (data) events.push(JSON.parse(data) as Record<string, unknown>);
			if (events.length === count) break;
		}
	}
	await reader.cancel();
	return events;
}

async function mintCookie(): Promise<string> {
	const browserOrigin = new URL(base()).origin;
	const resp = await fetch(`${base()}/api/health`, {
		headers: {
			Authorization: `Bearer ${readE2EToken()}`,
			Origin: browserOrigin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	expect(resp.status).toBe(200);
	const setCookie = resp.headers.get("set-cookie");
	expect(setCookie, "trusted browser auth should bootstrap a signed cookie").toBeTruthy();
	const m = String(setCookie).match(new RegExp(`bobbit_session=(${SIGNED_COOKIE_VALUE})(?:;|$)`));
	expect(m, `Set-Cookie did not include a signed bobbit_session: ${setCookie}`).not.toBeNull();
	return `bobbit_session=${m![1]}`;
}

test.describe("Search/preview/archive API migrations", () => {
	test("preview content route injects standalone theme snapshot tokens", async () => {
		const sessionId = await createSession();
		try {
			const mount = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({
					html: `<!DOCTYPE html><html><head></head><body><div id="box" style="background:var(--background);color:var(--foreground);">themed</div></body></html>`,
					entry: "report.html",
				}),
			});
			expect(mount.status).toBe(200);

			const cookie = await mintCookie();
			const resp = await fetch(`${base()}/preview/${sessionId}/report.html`, {
				headers: { Cookie: cookie },
			});
			expect(resp.status).toBe(200);
			expect(resp.headers.get("content-type") || "").toMatch(/text\/html/);
			const body = await resp.text();
			expect(body).toContain(`<base href="/preview/${sessionId}/">`);
			expect(body).toContain('data-bobbit-preview-theme="snapshot"');
			expect(body).toMatch(/:root\s*{[^}]*--background\s*:/s);
			expect(body).toMatch(/:root\s*{[^}]*--foreground\s*:/s);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("held artifact validation does not block health or session creation and returns the first exact candidate", async ({ gateway }) => {
		const sessionId = await createSession();
		let unrelatedSessionId: string | undefined;
		const fixtureRoot = path.join(gateway.bobbitDir, "preview-async-ordering", randomUUID());
		const releaseHash = deferred();
		let scanPromise: Promise<Response> | undefined;
		let mutationPromise: Promise<Response> | undefined;
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

			// Add a second byte-identical valid candidate. The production contract is
			// filesystem enumeration order, so derive the expected exact winner from
			// the same raw enumeration rather than assuming lexical ordering.
			const cloneId = `clone_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
			const cloneDir = previewArtifacts.artifactDir(sessionId, cloneId);
			await fs.promises.cp(previewArtifacts.artifactDir(sessionId, mounted.artifactId), cloneDir, { recursive: true });
			const cloneMetadataPath = path.join(cloneDir, "artifact.json");
			const cloneMetadata = JSON.parse(await fs.promises.readFile(cloneMetadataPath, "utf-8"));
			cloneMetadata.artifactId = cloneId;
			await fs.promises.writeFile(cloneMetadataPath, JSON.stringify(cloneMetadata, null, 2), "utf-8");
			const candidateOrder = (await fs.promises.readdir(previewArtifacts.artifactSessionDir(sessionId), { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && (entry.name === mounted.artifactId || entry.name === cloneId))
				.map(entry => entry.name);
			expect(candidateOrder).toHaveLength(2);

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
			expect(snapshot.artifactId).toBe(candidateOrder[0]);
			const mutationResponse = await mutationPromise;
			expect(mutationResponse.status).toBe(200);
			const mutated = await mutationResponse.json() as { contentHash?: string };
			expect(mutated.contentHash).not.toBe(mounted.contentHash);
		} finally {
			releaseHash.resolve();
			await scanPromise?.catch(() => undefined);
			await mutationPromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			if (unrelatedSessionId) await deleteSession(unrelatedSessionId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	test("SSE bootstrap precedes a queued live mutation while artifact validation is pending", async () => {
		const sessionId = await createSession();
		const releaseHash = deferred();
		const abort = new AbortController();
		let mutationPromise: Promise<Response> | undefined;
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
			const eventsPromise = readPreviewEvents(streamResponse, 2);
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
			releaseHash.resolve();
			abort.abort();
			await mutationPromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("purge waits for preview artifact deletion without blocking health or session creation", async () => {
		const sessionId = await createSession();
		let unrelatedSessionId: string | undefined;
		const releaseDeletion = deferred();
		let purgePromise: Promise<Response> | undefined;
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
			releaseDeletion.resolve();
			await purgePromise?.catch(() => undefined);
			previewArtifacts.setPreviewArtifactFsForTesting(undefined);
			if (unrelatedSessionId) await deleteSession(unrelatedSessionId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
