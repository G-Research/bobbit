import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession, registerProject } from "./_e2e/e2e-setup.js";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import type { PackEntry, PackManifest } from "../../src/server/agent/pack-types.js";
import {
	acceptPromptExtensionProposal,
	PromptExtensionValidationError,
	type PromptExtensionOverride,
} from "../../src/server/agent/prompt-extension-overrides.js";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.js";
import { PromptExtensionAuthoringAuditStore } from "../../src/server/agent/prompt-extension-audit-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPRO = "PROMPT_EXTENSION_REGISTRY_PROPOSAL_AUDIT";
const FIXTURE_SUFFIX = `${process.pid}-${Date.now()}`;

function manifest(name: string, lists: string[]): PackManifest {
	return {
		schema: 2,
		name,
		description: "Static prompt integration fixture",
		version: "1.0.0",
		contents: {
			roles: [], tools: [], skills: [], entrypoints: [], providers: [], hooks: ["static-hook"],
			mcp: [], piExtensions: [], runtimes: [], workflows: [], systemPrompts: lists,
		},
	};
}

function writeRegistryPack(root: string, id: string, displayName: string, sections: Array<{ listName: string; sectionId: string; content: string }>): PackEntry {
	const dir = path.join(root, id);
	fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(dir, "system-prompts"), { recursive: true });
	fs.writeFileSync(path.join(dir, "hooks", "static-hook.yaml"), [
		"id: static.prompt",
		"module: ../hook.mjs",
		"events: [beforePrompt]",
		"mode: observe",
		"capabilities: [prompt:system-static]",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "hook.mjs"), "export default {};\n");
	for (const section of sections) {
		fs.writeFileSync(path.join(dir, "system-prompts", `${section.listName}.yaml`), [
			`id: ${section.sectionId}`,
			`title: ${section.sectionId} title`,
			`content: ${section.content}`,
		].join("\n") + "\n");
	}
	return {
		id: `market:server:${id}`,
		kind: "market",
		scope: "server",
		path: dir,
		readOnly: false,
		manifest: manifest(displayName, sections.map(section => section.listName)),
		layout: "defaults-tree",
	};
}

function writeApiPack(headquartersDir: string, packName: string): string {
	const dir = path.join(headquartersDir, "config", "market-packs", packName);
	fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(dir, "system-prompts"), { recursive: true });
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pack-meta.yaml"), [
		"sourceUrl: test",
		"sourceRef: local",
		"commit: fixture",
		`packName: ${packName}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "pack.yaml"), [
		"schema: 2",
		`name: ${packName}`,
		"description: Prompt proposal integration fixture",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: []",
		"  hooks: [static-hook, author-hook]",
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
		"  system-prompts: [policy]",
	].join("\n") + "\n");
	const hook = (id: string, capability: string) => [
		`id: ${id}`,
		"module: ../lib/inert-hook.mjs",
		"events: [beforePrompt]",
		"mode: observe",
		`capabilities: [${capability}]`,
	].join("\n") + "\n";
	fs.writeFileSync(path.join(dir, "hooks", "static-hook.yaml"), hook("static.prompt", "prompt:system-static"));
	fs.writeFileSync(path.join(dir, "hooks", "author-hook.yaml"), hook("author.prompt", "prompt:system-author"));
	fs.writeFileSync(path.join(dir, "lib", "inert-hook.mjs"), "export default {};\n");
	fs.writeFileSync(path.join(dir, "system-prompts", "policy.yaml"), [
		"id: policy",
		"title: Fixture policy",
		"content: Original fixture policy",
		"maxBytes: 4096",
	].join("\n") + "\n");
	return dir;
}

function grantPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

function configuredPromptExtensions(config: Record<string, unknown>): unknown {
	const value = config.extension_prompt_sections;
	return typeof value === "string" ? JSON.parse(value) : value;
}

test.describe("static prompt extension registry, proposals, and audit", () => {
	test("keeps active sections project-scoped, priority-stable, shadow-safe, and activation-filtered", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-registry-"));
		try {
			const low = writeRegistryPack(root, "low", "low-pack", [
				{ listName: "zeta-list", sectionId: "zeta", content: "low zeta" },
				{ listName: "alpha-list", sectionId: "alpha", content: "low alpha" },
			]);
			const shadowed = writeRegistryPack(root, "shadow-low", "shadow-low", [{ listName: "section", sectionId: "legacy", content: "must shadow" }]);
			const shadowWinner = writeRegistryPack(root, "shadow-high", "shadow-high", [{ listName: "section", sectionId: "winner", content: "winning bytes" }]);
			// Shadowing uses the physical pack id (directory basename), so model two
			// precedence entries with the same basename in distinct roots.
			const sharedLowDir = path.join(root, "one", "shared");
			const sharedHighDir = path.join(root, "two", "shared");
			fs.mkdirSync(path.dirname(sharedLowDir), { recursive: true });
			fs.mkdirSync(path.dirname(sharedHighDir), { recursive: true });
			fs.renameSync(shadowed.path, sharedLowDir);
			fs.renameSync(shadowWinner.path, sharedHighDir);
			const sharedLow = { ...shadowed, path: sharedLowDir };
			const sharedHigh = { ...shadowWinner, path: sharedHighDir };
			const high = writeRegistryPack(root, "high", "high-pack", [{ listName: "high-list", sectionId: "high", content: "high bytes" }]);
			let disabledHigh = false;
			const registry = new PackContributionRegistry(
				(projectId) => projectId === "project-a" ? [low, sharedLow, sharedHigh, high] : [low, sharedLow, sharedHigh, high],
				undefined, undefined, undefined, undefined,
				(_scope, _projectId, packName) => disabledHigh && packName === "high-pack" ? ["high-list"] : [],
				(projectId) => projectId === "project-a",
			);

			expect(registry.listSystemPromptSections?.("project-b"), `${REPRO}: grants are deny-by-default per project`).toEqual([]);
			expect(registry.listSystemPromptSections?.("project-a").map(section => `${section.packId}/${section.sectionId}`)).toEqual([
				"low/alpha", "low/zeta", "shared/winner", "high/high",
			]);
			expect(registry.listSystemPromptSections?.("project-a").find(section => section.packId === "shared")).toMatchObject({
				content: "winning bytes",
			});

			disabledHigh = true;
			registry.invalidate();
			expect(registry.listSystemPromptSections?.("project-a").map(section => section.sectionId)).toEqual(["alpha", "zeta", "winner"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("requires a separate author grant and accepts only the stored proposal while retaining direct-seed audit detail", async ({ gateway }) => {
		const packName = `prompt-proposal-${FIXTURE_SUFFIX}`;
		const packDir = writeApiPack(gateway.bobbitDir, packName);
		const projectRoot = path.join(gateway.bobbitDir, "prompt-extension-projects", packName);
		fs.mkdirSync(projectRoot, { recursive: true });
		const project = await registerProject({ name: `prompt-proposal-${FIXTURE_SUFFIX}`, rootPath: projectRoot, seedWorkflows: false });
		let sessionId = "";
		let verificationSessionId = "";
		const secret = "password=authoring-secret-value";
		const replacement = `Approved policy ${secret}`;
		const change = { packId: packName, sectionId: "policy", content: replacement, expectedRevision: 0 };
		try {
			const activation = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			});
			expect(activation.status, `${REPRO}: fixture activation refresh failed`).toBe(200);
			// The integration fixture retries failed attempts in the same fork. Clear a
			// prior attempt's author principal so the denial assertion stays exact.
			await apiFetch(`${grantPath(project.id)}/${encodeURIComponent(packName)}/${encodeURIComponent("author.prompt")}/prompt%3Asystem-author`, { method: "DELETE" });
			sessionId = await createSession({ projectId: project.id });

			const staticGrant = await apiFetch(grantPath(project.id), {
				method: "PUT",
				body: JSON.stringify({ packId: packName, hookId: "static.prompt", capability: "prompt:system-static" }),
			});
			expect(staticGrant.status).toBe(200);

			const denied = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST",
				body: JSON.stringify({ args: { name: "Proposal target", projectId: project.id, extensionPromptSections: [change] } }),
			});
			expect(denied.status, `${REPRO}: static permission must not imply agent authoring permission`).toBe(403);
			expect(await readJson(denied)).toMatchObject({ code: "GRANT_REQUIRED" });

			const authorGrant = await apiFetch(grantPath(project.id), {
				method: "PUT",
				body: JSON.stringify({ packId: packName, hookId: "author.prompt", capability: "prompt:system-author" }),
			});
			expect(authorGrant.status).toBe(200);
			const proposed = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST",
				body: JSON.stringify({ args: { name: "Proposal target", projectId: project.id, extensionPromptSections: [change] } }),
			});
			expect(proposed.status, `${REPRO}: granted authorship must write an approval proposal, never an override`).toBe(200);

			const beforeAcceptance = await readJson(await apiFetch(`/api/projects/${project.id}/config`));
			expect(configuredPromptExtensions(beforeAcceptance)).toBeUndefined();
			const audit = await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`));
			// This test seeds a draft directly rather than running an agent turn. Its
			// requested record is intentionally durable, but cannot become proposed
			// until SessionManager observes that turn's terminal assistant event.
			expect(audit.entries).toEqual(expect.arrayContaining([
				expect.objectContaining({ packId: packName, hookId: "author.prompt", actor: "agent", status: "requested", sectionId: "policy", proposalId: expect.any(String) }),
			]));
			const auditText = JSON.stringify(audit);
			expect(auditText).not.toContain(secret);
			expect(auditText).toContain("[REDACTED]");

			const genericConfigWrite = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ extensionPromptSections: [change] }),
			});
			expect(genericConfigWrite.status, `${REPRO}: config PUT must never apply agent-authored prompt text`).toBe(422);
			expect(await readJson(genericConfigWrite)).toMatchObject({ code: "PROMPT_EXTENSION_PROPOSAL_REQUIRED" });
			expect(configuredPromptExtensions(await readJson(await apiFetch(`/api/projects/${project.id}/config`)))).toBeUndefined();

			const accepted = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST",
				body: JSON.stringify({ projectId: project.id }),
			});
			expect(accepted.status, `${REPRO}: only stored proposal acceptance may apply and revalidate the exact draft`).toBe(200);
			const afterAcceptance = await readJson(await apiFetch(`/api/projects/${project.id}/config`));
			expect(configuredPromptExtensions(afterAcceptance)).toEqual([
				expect.objectContaining({ packId: packName, sectionId: "policy", content: replacement, revision: 1 }),
			]);

			const stale = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST",
				body: JSON.stringify({ projectId: project.id }),
			});
			expect(stale.status, `${REPRO}: stored proposal approval must compare the expected section revision atomically`).toBe(422);
			expect(await readJson(stale)).toMatchObject({ code: "STALE_REVISION" });

			verificationSessionId = await createSession({ projectId: project.id });
			const prompt = await readJson(await apiFetch(`/api/sessions/${verificationSessionId}/prompt-sections`));
			const extension = prompt.sections.find((section: any) => section.kind === "extension" && section.packId === packName && section.sectionId === "policy");
			expect(extension).toMatchObject({ content: expect.stringContaining(replacement), source: `Extension: ${packName}`, contentBytes: Buffer.byteLength(replacement, "utf8") });
		} finally {
			if (verificationSessionId) await deleteSession(verificationSessionId);
			if (sessionId) await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			}).catch(() => {});
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("records terminal authoring usage only when the requested audit transitions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-terminal-audit-"));
		try {
			const audit = new PromptExtensionAuthoringAuditStore(root, undefined, () => new Date("2026-01-01T00:00:00.000Z"));
			const requested = audit.create({
				id: "terminal-usage", packId: "fixture", hookId: "author", event: "proposal", sectionId: "policy",
				actor: "agent", sessionId: "session", trigger: "propose_project", baselineDigest: "a".repeat(64), baselineBytes: 8,
			});
			expect(requested.status).toBe("requested");
			const proposed = audit.complete(requested.id, {
				status: "proposed", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1_000,
				usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3, cost: 0.25 },
			});
			expect(proposed).toMatchObject({
				status: "proposed", durationMs: 1_000,
				usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3, cost: 0.25 },
			});
			expect(audit.list()).toEqual([expect.objectContaining({ id: requested.id, status: "proposed", usage: proposed.usage })]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects wrapper-inclusive aggregate budget candidates without replacing the prior override", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-budget-"));
		try {
			const store = new ProjectConfigStore(root);
			store.setPromptExtensionBudget({ maxBytesPerSection: 400, maxBytesTotal: 500 });
			const accepted = acceptPromptExtensionProposal(store, [{ packId: "fixture", sectionId: "policy", content: "short", expectedRevision: 0 }], {
				actor: "admin",
				hasStaticGrant: () => true,
				hasSection: () => true,
				resolveEffectiveSections: (overrides: readonly PromptExtensionOverride[]) => overrides,
				now: () => new Date("2026-01-01T00:00:00.000Z"),
			});
			expect(accepted).toEqual([expect.objectContaining({ content: "short", revision: 1 })]);

			let error: unknown;
			try {
				acceptPromptExtensionProposal(store, [{ packId: "fixture", sectionId: "policy", content: "x".repeat(450), expectedRevision: 1 }], {
					actor: "admin", hasStaticGrant: () => true, hasSection: () => true,
					resolveEffectiveSections: (overrides: readonly PromptExtensionOverride[]) => overrides,
				});
			} catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(PromptExtensionValidationError);
			expect(error).toMatchObject({ code: "OVER_BUDGET" });
			expect(store.getPromptExtensionOverrides()).toEqual([expect.objectContaining({ content: "short", revision: 1 })]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
