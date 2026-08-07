import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { apiFetch, registerProject } from "../e2e-setup.js";

export const HINDSIGHT_EXPERIENCE_PACK_ID = "hindsight";
export const HINDSIGHT_EXPERIENCE_PROVIDER_ID = "memory";
export const HINDSIGHT_EXPERIENCE_SECRET = "hindsight-browser-secret-7d8a9c";

export type HindsightExperienceProject = { id: string; name: string; rootPath: string };
export type HindsightExperienceBrowserResponse = { status: number; text: string };

/**
 * Installs the shipped pack in the isolated gateway only. Its deliberately
 * unique name prevents this browser suite from sharing cleanup state with the
 * extension-settings fixture.
 */
export function installHindsightExperienceBrowserFixture(bobbitDir: string): string {
	const source = path.resolve(import.meta.dirname, "../../../market-packs/hindsight");
	const destination = path.join(bobbitDir, "config", "market-packs", HINDSIGHT_EXPERIENCE_PACK_ID);
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.cpSync(source, destination, { recursive: true });
	fs.writeFileSync(path.join(destination, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${HINDSIGHT_EXPERIENCE_PACK_ID}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	return destination;
}

export async function createHindsightExperienceBrowserProject(): Promise<HindsightExperienceProject> {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-experience-browser-"));
	const project = await registerProject({
		name: `Hindsight experience browser ${Date.now()}`,
		rootPath,
		seedWorkflows: false,
	}) as HindsightExperienceProject;
	return project;
}

export async function cleanupHindsightExperienceBrowserFixture(
	project: HindsightExperienceProject | undefined,
	packDir: string | undefined,
): Promise<void> {
	if (project) {
		await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => {});
		fs.rmSync(project.rootPath, { recursive: true, force: true });
	}
	if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
}

/** Execute a same-origin request with precisely the credentials the user has. */
export async function hindsightExperienceBrowserApi(
	page: Page,
	request: { path: string; method?: string; body?: unknown },
): Promise<HindsightExperienceBrowserResponse> {
	return page.evaluate(async ({ path, method, body }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET",
			credentials: "include",
			headers: {
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

/** Fails if a write-only secret leaks into any browser-observable surface. */
export async function expectHindsightExperienceSecretRedacted(page: Page, additional: unknown[] = []): Promise<void> {
	const surfaces = await page.evaluate(() => ({
		text: document.body.innerText,
		html: document.documentElement.outerHTML,
		localStorage: Object.entries(localStorage),
		sessionStorage: Object.entries(sessionStorage),
	}));
	for (const value of [...additional, surfaces]) {
		if (JSON.stringify(value).includes(HINDSIGHT_EXPERIENCE_SECRET)) {
			throw new Error("Hindsight write-only secret leaked into a public browser surface");
		}
	}
}
