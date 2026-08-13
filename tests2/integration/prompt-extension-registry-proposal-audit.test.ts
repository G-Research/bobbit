import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession, rawApiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import type { PackEntry, PackManifest } from "../../src/server/agent/pack-types.js";
import {
	acceptPromptExtensionProposal,
	PromptExtensionValidationError,
	validatePromptExtensionProposalSections,
	type PromptExtensionOverride,
} from "../../src/server/agent/prompt-extension-overrides.js";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.js";
import { DYNAMIC_CONTEXT_END, DYNAMIC_CONTEXT_START } from "../../src/server/agent/prompt-delimiters.js";
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

async function mintOperatorCookie(): Promise<string> {
	const probe = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
		?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
	const cookie = setCookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session=")) ?? "";
	expect(cookie, `${REPRO}: browser-signaled gateway principal must mint a signed operator cookie`).not.toBe("");
	return cookie;
}

function operatorHeaders(cookie: string): Record<string, string> {
	return { Cookie: cookie };
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

	test("orders tied overrides by code units independently of proposal input order", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-override-order-"));
		const changes = [
			{ packId: "pack.1", sectionId: "section-1", content: "period pack", expectedRevision: 0 },
			{ packId: "pack-2", sectionId: "section.1", content: "period section", expectedRevision: 0 },
			{ packId: "pack-2", sectionId: "section-2", content: "hyphen section", expectedRevision: 0 },
		];
		const accept = (input: typeof changes, suffix: string) => {
			const stateDir = path.join(root, suffix);
			fs.mkdirSync(stateDir, { recursive: true });
			const store = new ProjectConfigStore(stateDir);
			return acceptPromptExtensionProposal(store, input, {
				actor: "operator", hasStaticGrant: () => true, hasSection: () => true,
				resolveEffectiveSections: overrides => overrides,
				now: () => new Date("2026-01-02T03:04:05.000Z"),
			});
		};
		try {
			const expected = ["pack-2/section-2", "pack-2/section.1", "pack.1/section-1"];
			expect(accept(changes, "forward").map(row => `${row.packId}/${row.sectionId}`)).toEqual(expected);
			expect(accept([...changes].reverse(), "reverse").map(row => `${row.packId}/${row.sectionId}`)).toEqual(expected);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("reads prompt authoring audit only from the requested session's owning project", async ({ gateway }) => {
		const rootA = path.join(gateway.bobbitDir, "prompt-extension-projects", `audit-owner-a-${FIXTURE_SUFFIX}`);
		const rootB = path.join(gateway.bobbitDir, "prompt-extension-projects", `audit-owner-b-${FIXTURE_SUFFIX}`);
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });
		const projectA = await registerProject({ name: `audit-owner-a-${FIXTURE_SUFFIX}`, rootPath: rootA, seedWorkflows: false });
		const projectB = await registerProject({ name: `audit-owner-b-${FIXTURE_SUFFIX}`, rootPath: rootB, seedWorkflows: false });
		const humanCookie = await mintOperatorCookie();
		let sessionA = "";
		let sessionB = "";
		try {
			sessionA = await createSession({ projectId: projectA.id });
			sessionB = await createSession({ projectId: projectB.id });
			// Model a stale/malicious cross-project record. The operator route must
			// never scan unrelated project-owned audit files to discover it.
			new PromptExtensionAuthoringAuditStore(path.join(rootB, ".bobbit", "state")).create({
				id: "wrong-owner", packId: "fixture", hookId: "author", event: "proposal", sectionId: "policy",
				actor: "agent", sessionId: sessionA, trigger: "proposal-seed", baselineDigest: "a".repeat(64), baselineBytes: 1,
			});

			const scoped = await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit?limit=1`, { headers: operatorHeaders(humanCookie) });
			expect(scoped.status).toBe(200);
			expect(await readJson(scoped)).toEqual({ entries: [] });
			const missing = await apiFetch("/api/sessions/missing-session/prompt-extension-audit", { headers: operatorHeaders(humanCookie) });
			expect(missing.status).toBe(404);
		} finally {
			for (const id of [sessionA, sessionB]) if (id) await deleteSession(id);
			for (const project of [projectA, projectB]) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
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
		const humanCookie = await mintOperatorCookie();
		const benignDiffProse = [
			"deterministic-per-project-pack-priority",
			"registry.contributions.system-prompts.priority.v2026",
			"550e8400-e29b-41d4-a716-446655440000",
			"a3f5c7e9b1d2f4a6c8e0b2d4f6a8c0e2d4f6a8c0e2d4f6a8c0e2d4f6a8c0e2",
			"/workspace/packs/deterministic/0123456789abcdef0123456789abcdef.yaml",
		];
		const credentials = [
			"password=authoring-password-secret-1234567890",
			"Bearer bearer-authoring-secret-value-1234567890",
			"access_token=access-authoring-secret-value-1234567890",
			"github_pat_0123456789abcdefghij",
			"sk-proj-OpenAI-authoring-secret-value-1234567890",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWRpdCJ9.signaturevalue",
		];
		const replacement = `Approved harmless-policy-text ${benignDiffProse.join(" ")} ${credentials.join(" ")}`;
		const change = { packId: packName, sectionId: "policy", content: replacement, expectedRevision: 0 };
		try {
			const activation = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			});
			expect(activation.status, `${REPRO}: fixture activation refresh failed`).toBe(200);
			// The integration fixture retries failed attempts in the same fork. Clear a
			// prior attempt's author principal so the denial assertion stays exact.
			await apiFetch(`${grantPath(project.id)}/${encodeURIComponent(packName)}/${encodeURIComponent("author.prompt")}/prompt%3Asystem-author`, { method: "DELETE", headers: operatorHeaders(humanCookie) });
			sessionId = await createSession({ projectId: project.id });
			const agentHeaders = { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId) };

			const staticGrant = await apiFetch(grantPath(project.id), {
				method: "PUT", headers: operatorHeaders(humanCookie),
				body: JSON.stringify({ packId: packName, hookId: "static.prompt", capability: "prompt:system-static" }),
			});
			expect(staticGrant.status).toBe(200);

			const denied = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ args: { name: "Proposal target", projectId: project.id, extensionPromptSections: [change] } }),
			});
			expect(denied.status, `${REPRO}: static permission must not imply agent authoring permission`).toBe(403);
			expect(await readJson(denied)).toMatchObject({ code: "GRANT_REQUIRED" });

			const authorGrant = await apiFetch(grantPath(project.id), {
				method: "PUT", headers: operatorHeaders(humanCookie),
				body: JSON.stringify({ packId: packName, hookId: "author.prompt", capability: "prompt:system-author" }),
			});
			expect(authorGrant.status).toBe(200);
			const proposed = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ args: { name: "Proposal target", projectId: project.id, extensionPromptSections: [change] } }),
			});
			expect(proposed.status, `${REPRO}: granted authorship must write an approval proposal, never an override`).toBe(200);

			const beforeAcceptance = await readJson(await apiFetch(`/api/projects/${project.id}/config`));
			expect(configuredPromptExtensions(beforeAcceptance)).toBeUndefined();
			const audit = await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			// This test seeds a draft directly rather than running an agent turn. Its
			// requested record is intentionally durable, but cannot become proposed
			// until SessionManager observes that turn's terminal assistant event.
			expect(audit.entries).toEqual(expect.arrayContaining([
				expect.objectContaining({ packId: packName, hookId: "author.prompt", actor: "agent", status: "requested", sectionId: "policy", proposalId: expect.any(String) }),
			]));
			const auditText = JSON.stringify(audit);
			const rawAuditText = fs.readFileSync(path.join(projectRoot, ".bobbit", "state", "prompt-extension-authoring-audit.jsonl"), "utf8");
			for (const credential of credentials) {
				expect(auditText, `${REPRO}: authorized audit API must redact ${credential}`).not.toContain(credential);
				expect(rawAuditText, `${REPRO}: durable audit JSONL must redact ${credential}`).not.toContain(credential);
			}
			for (const prose of benignDiffProse) {
				expect(auditText, `${REPRO}: authorized audit API must preserve benign diff prose exactly`).toContain(prose);
				expect(rawAuditText, `${REPRO}: durable audit JSONL must preserve benign diff prose exactly`).toContain(prose);
			}
			expect(auditText).toContain("[REDACTED]");
			expect(rawAuditText).toContain("[REDACTED]");
			expect(auditText).toContain("harmless-policy-text");
			expect(rawAuditText).toContain("harmless-policy-text");

			const genericConfigWrite = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ extensionPromptSections: [change] }),
			});
			expect(genericConfigWrite.status, `${REPRO}: config PUT must never apply agent-authored prompt text`).toBe(422);
			expect(await readJson(genericConfigWrite)).toMatchObject({ code: "PROMPT_EXTENSION_PROPOSAL_REQUIRED" });
			expect(configuredPromptExtensions(await readJson(await apiFetch(`/api/projects/${project.id}/config`)))).toBeUndefined();

			const accepted = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie),
				body: JSON.stringify({ projectId: project.id }),
			});
			expect(accepted.status, `${REPRO}: only stored proposal acceptance may apply and revalidate the exact draft`).toBe(200);
			const afterAcceptance = await readJson(await apiFetch(`/api/projects/${project.id}/config`));
			expect(configuredPromptExtensions(afterAcceptance)).toEqual([
				expect.objectContaining({ packId: packName, sectionId: "policy", content: replacement, revision: 1 }),
			]);

			const stale = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie),
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

	test("denies authenticated and sandboxed prompt mutations without changing drafts, revisions, or audit", async ({ gateway }) => {
		const packName = `prompt-mutation-authz-${FIXTURE_SUFFIX}`;
		const otherPackName = `${packName}-other`;
		const packDir = writeApiPack(gateway.bobbitDir, packName);
		const otherPackDir = writeApiPack(gateway.bobbitDir, otherPackName);
		const projectRoot = path.join(gateway.bobbitDir, "prompt-extension-projects", packName);
		fs.mkdirSync(projectRoot, { recursive: true });
		const project = await registerProject({ name: `prompt-mutation-authz-${FIXTURE_SUFFIX}`, rootPath: projectRoot, seedWorkflows: false });
		const humanCookie = await mintOperatorCookie();
		let sessionId = "";
		try {
			for (const name of [packName, otherPackName]) {
				expect((await apiFetch("/api/marketplace/pack-activation", {
					method: "PUT", body: JSON.stringify({ scope: "server", packName: name, disabled: {} }),
				})).status).toBe(200);
			}
			sessionId = await createSession({ projectId: project.id });
			const sessionSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
			const agentHeaders = { "X-Bobbit-Session-Secret": sessionSecret };
			for (const name of [packName, otherPackName]) {
				expect((await apiFetch(grantPath(project.id), {
					method: "PUT", headers: operatorHeaders(humanCookie), body: JSON.stringify({ packId: name, hookId: "static.prompt", capability: "prompt:system-static" }),
				})).status).toBe(200);
			}
			expect((await apiFetch(grantPath(project.id), {
				method: "PUT", headers: operatorHeaders(humanCookie), body: JSON.stringify({ packId: packName, hookId: "author.prompt", capability: "prompt:system-author" }),
			})).status).toBe(200);

			const initial = { packId: packName, sectionId: "policy", content: "initial authorized policy", expectedRevision: 0 };
			expect((await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ args: { name: "Proposal target", projectId: project.id, extensionPromptSections: [initial] } }),
			})).status).toBe(200);
			const draftAtRev1 = await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text();
			const auditsAtRev1 = await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect(auditsAtRev1.entries).toHaveLength(1);

			// The gateway bearer is shared transport authentication, never prompt
			// authority. Omit both a signed browser cookie and the session secret.
			const grantsAtRev1 = await readJson(await apiFetch(grantPath(project.id)));
			const configAtRev1 = await readJson(await apiFetch(`/api/projects/${project.id}/config`));
			const effectivePromptAtRev1 = await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-sections`));
			const bareGrant = await rawApiFetch(grantPath(project.id), {
				method: "PUT", body: JSON.stringify({ packId: packName, hookId: "author.prompt", capability: "prompt:system-author" }),
			});
			expect(bareGrant.status, `${REPRO}: a bare shared bearer cannot self-grant prompt authority`).toBe(403);
			const bareEdit = await rawApiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", body: JSON.stringify({ old_text: "initial authorized policy", new_text: "bearer edit must not apply" }),
			});
			expect(bareEdit.status, `${REPRO}: a bare shared bearer cannot edit prompt policy`).toBe(403);
			const bareRestore = await rawApiFetch(`/api/sessions/${sessionId}/proposal/project/restore`, {
				method: "POST", body: JSON.stringify({ rev: 1 }),
			});
			expect(bareRestore.status, `${REPRO}: a bare shared bearer cannot restore prompt policy`).toBe(403);
			const bareAccept = await rawApiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", body: JSON.stringify({ projectId: project.id }),
			});
			expect(bareAccept.status, `${REPRO}: a bare shared bearer cannot accept prompt policy`).toBe(403);
			const bareAudit = await rawApiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`);
			expect(bareAudit.status, `${REPRO}: a bare shared bearer cannot disclose exact prompt audit detail`).toBe(403);
			expect(await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text()).toBe(draftAtRev1);
			expect(await readJson(await apiFetch(grantPath(project.id)))).toEqual(grantsAtRev1);
			expect(await readJson(await apiFetch(`/api/projects/${project.id}/config`))).toEqual(configAtRev1);
			expect(await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-sections`))).toEqual(effectivePromptAtRev1);
			expect(await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).toEqual(auditsAtRev1);

			// A grant is scoped to the granted pack's active section, not every installed pack.
			const otherSection = "  - packId: " + otherPackName + "\n    sectionId: policy\n    content: other pack policy\n    expectedRevision: 0";
			const foreignEdit = await apiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ old_text: "    expectedRevision: 0", new_text: `    expectedRevision: 0\n${otherSection}` }),
			});
			expect(foreignEdit.status).toBe(403);
			expect(await readJson(foreignEdit)).toMatchObject({ code: "GRANT_REQUIRED" });
			expect(await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text()).toBe(draftAtRev1);
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/proposals`))).proposals).toEqual([expect.objectContaining({ proposalType: "project", rev: 1 })]);
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).entries).toHaveLength(1);

			const authorized = await apiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ old_text: "initial authorized policy", new_text: "authorized agent policy" }),
			});
			expect(authorized.status).toBe(200);
			const draftAtRev2 = await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text();
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).entries).toHaveLength(2);

			// Revoking the author grant must block both an authentic agent secret and a sandbox token.
			expect((await apiFetch(`${grantPath(project.id)}/${encodeURIComponent(packName)}/author.prompt/prompt%3Asystem-author`, { method: "DELETE", headers: operatorHeaders(humanCookie) })).status).toBe(200);
			const deniedAgent = await apiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", headers: agentHeaders,
				body: JSON.stringify({ old_text: "authorized agent policy", new_text: "forbidden agent policy" }),
			});
			expect(deniedAgent.status).toBe(403);
			expect(await readJson(deniedAgent)).toMatchObject({ code: "GRANT_REQUIRED" });
			expect(await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text()).toBe(draftAtRev2);

			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(project.id);
			gateway.sessionManager.sandboxTokenStore.addSession(project.id, sessionId);
			const deniedSandbox = await rawApiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", headers: { Authorization: `Bearer ${sandboxToken}` },
				body: JSON.stringify({ old_text: "authorized agent policy", new_text: "forbidden sandbox policy" }),
			});
			expect(deniedSandbox.status).toBe(403);
			expect(await readJson(deniedSandbox)).toMatchObject({ code: "GRANT_REQUIRED" });

			const deniedRestore = await apiFetch(`/api/sessions/${sessionId}/proposal/project/restore`, {
				method: "POST", headers: agentHeaders, body: JSON.stringify({ rev: 1 }),
			});
			expect(deniedRestore.status).toBe(403);
			expect(await readJson(deniedRestore)).toMatchObject({ code: "GRANT_REQUIRED" });
			expect(await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text()).toBe(draftAtRev2);
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/proposals`))).proposals).toEqual([expect.objectContaining({ proposalType: "project", rev: 2 })]);
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).entries).toHaveLength(2);

			// A browser/human edit remains available and only approval rechecks the static grant.
			const humanEdit = await apiFetch(`/api/sessions/${sessionId}/proposal/project/edit`, {
				method: "POST", headers: operatorHeaders(humanCookie), body: JSON.stringify({ old_text: "authorized agent policy", new_text: "human approved policy" }),
			});
			expect(humanEdit.status).toBe(200);
			expect((await readJson(await apiFetch(`/api/sessions/${sessionId}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).entries).toHaveLength(2);
			expect((await apiFetch(`${grantPath(project.id)}/${encodeURIComponent(packName)}/static.prompt/prompt%3Asystem-static`, { method: "DELETE", headers: operatorHeaders(humanCookie) })).status).toBe(200);
			const noStaticGrant = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie), body: JSON.stringify({ projectId: project.id }),
			});
			expect(noStaticGrant.status).toBe(422);
			expect(await readJson(noStaticGrant)).toMatchObject({ code: "GRANT_REQUIRED" });
			expect(configuredPromptExtensions(await readJson(await apiFetch(`/api/projects/${project.id}/config`)))).toBeUndefined();
			expect((await apiFetch(grantPath(project.id), {
				method: "PUT", headers: operatorHeaders(humanCookie), body: JSON.stringify({ packId: packName, hookId: "static.prompt", capability: "prompt:system-static" }),
			})).status).toBe(200);
			expect((await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie), body: JSON.stringify({ projectId: project.id }),
			})).status).toBe(200);
			const stale = await apiFetch(`/api/sessions/${sessionId}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie), body: JSON.stringify({ projectId: project.id }),
			});
			expect(stale.status).toBe(422);
			expect(await readJson(stale)).toMatchObject({ code: "STALE_REVISION" });
		} finally {
			if (sessionId) await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			for (const name of [packName, otherPackName]) {
				await apiFetch("/api/marketplace/pack-activation", {
					method: "PUT", body: JSON.stringify({ scope: "server", packName: name, disabled: {} }),
				}).catch(() => {});
			}
			fs.rmSync(packDir, { recursive: true, force: true });
			fs.rmSync(otherPackDir, { recursive: true, force: true });
		}
	});

	test("binds prompt authorship to the authentic session and rechecks destination grants", async ({ gateway }) => {
		const packName = `prompt-authentic-session-${FIXTURE_SUFFIX}`;
		const packDir = writeApiPack(gateway.bobbitDir, packName);
		const rootA = path.join(gateway.bobbitDir, "prompt-extension-projects", `${packName}-a`);
		const rootB = path.join(gateway.bobbitDir, "prompt-extension-projects", `${packName}-b`);
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });
		const projectA = await registerProject({ name: `${packName}-a`, rootPath: rootA, seedWorkflows: false });
		const projectB = await registerProject({ name: `${packName}-b`, rootPath: rootB, seedWorkflows: false });
		const humanCookie = await mintOperatorCookie();
		let sessionA = "";
		let sessionB = "";
		let sandboxSession = "";
		try {
			expect((await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT", body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			})).status).toBe(200);
			const grant = async (projectId: string, hookId: string, capability: string) => {
				const response = await apiFetch(grantPath(projectId), {
					method: "PUT", headers: operatorHeaders(humanCookie), body: JSON.stringify({ packId: packName, hookId, capability }),
				});
				expect(response.status).toBe(200);
			};
			await grant(projectA.id, "static.prompt", "prompt:system-static");
			await grant(projectA.id, "author.prompt", "prompt:system-author");
			await grant(projectB.id, "static.prompt", "prompt:system-static");
			// Force the destination into the no-author-grant state: test fixtures may
			// be retried against a retained in-process project context.
			expect((await apiFetch(`${grantPath(projectB.id)}/${encodeURIComponent(packName)}/author.prompt/prompt%3Asystem-author`, {
				method: "DELETE", headers: operatorHeaders(humanCookie),
			})).status).toBe(200);
			const destinationGrants = await readJson(await apiFetch(grantPath(projectB.id)));
			expect(destinationGrants.grants).not.toEqual(expect.arrayContaining([
				expect.objectContaining({ packId: packName, hookId: "author.prompt", capability: "prompt:system-author" }),
			]));
			sessionA = await createSession({ projectId: projectA.id });
			const agentA = { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionA) };
			const proposalA = { packId: packName, sectionId: "policy", content: "session A policy", expectedRevision: 0 };
			expect((await apiFetch(`/api/sessions/${sessionA}/proposal/project/seed`, {
				method: "POST", headers: agentA,
				body: JSON.stringify({ args: { name: "A", projectId: projectA.id, extensionPromptSections: [proposalA] } }),
			})).status).toBe(200);
			const draftA = await (await apiFetch(`/api/sessions/${sessionA}/proposal/project`)).text();
			const auditA = await readJson(await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			const changeTarget = { old_text: `projectId: ${projectA.id}`, new_text: `projectId: ${projectB.id}` };
			const bareTargetChange = await rawApiFetch(`/api/sessions/${sessionA}/proposal/project/edit`, {
				method: "POST", body: JSON.stringify(changeTarget),
			});
			expect(bareTargetChange.status, `${REPRO}: shared bearer cannot retarget an extension proposal`).toBe(403);
			expect(await (await apiFetch(`/api/sessions/${sessionA}/proposal/project`)).text()).toBe(draftA);
			expect(await readJson(await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).toEqual(auditA);
			const destinationDenied = await apiFetch(`/api/sessions/${sessionA}/proposal/project/edit`, {
				method: "POST", headers: agentA, body: JSON.stringify(changeTarget),
			});
			expect(destinationDenied.status, `${REPRO}: authentic authoring must recheck the destination project grant`).toBe(403);
			expect(await (await apiFetch(`/api/sessions/${sessionA}/proposal/project`)).text()).toBe(draftA);
			await grant(projectB.id, "author.prompt", "prompt:system-author");
			expect((await apiFetch(`/api/sessions/${sessionA}/proposal/project/edit`, {
				method: "POST", headers: agentA, body: JSON.stringify(changeTarget),
			})).status).toBe(200);
			const retargetedAudit = await readJson(await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			const crossProjectEntry = retargetedAudit.entries.find((entry: any) => entry.projectId === projectB.id);
			expect(crossProjectEntry, `${REPRO}: session audit route must read its direct cross-project mirror`).toMatchObject({
				actor: "agent", sessionId: sessionA, projectId: projectB.id, status: "requested",
			});
			const targetAuditStore = new PromptExtensionAuthoringAuditStore(path.join(rootB, ".bobbit", "state"));
			expect(targetAuditStore.listForSession(sessionA)).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: crossProjectEntry?.id, projectId: projectB.id }),
			]));
			// The route opens only session A's owning project. A record injected into
			// B must not be discovered by a cross-project audit-file scan.
			targetAuditStore.create({
				id: "unrelated-project-record", packId: packName, hookId: "author.prompt", event: "proposal", sectionId: "policy",
				actor: "agent", sessionId: sessionA, projectId: projectB.id, trigger: "unrelated", baselineDigest: "a".repeat(64), baselineBytes: 1,
			});
			const afterUnrelatedInjection = await readJson(await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect(afterUnrelatedInjection.entries).not.toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "unrelated-project-record" }),
			]));
			const acceptance = await apiFetch(`/api/sessions/${sessionA}/proposal/project/accept-extension-sections`, {
				method: "POST", headers: operatorHeaders(humanCookie), body: JSON.stringify({ projectId: projectB.id }),
			});
			expect(acceptance.status, `${REPRO}: cross-project approval response: ${await acceptance.clone().text()}`).toBe(200);
			const acceptedCrossProjectAudit = await readJson(await apiFetch(`/api/sessions/${sessionA}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect(acceptedCrossProjectAudit.entries).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: crossProjectEntry?.id, projectId: projectB.id, status: "accepted" }),
			]));
			expect(targetAuditStore.get("unrelated-project-record")).toMatchObject({ status: "requested" });

			sessionB = await createSession({ projectId: projectB.id });
			const agentB = { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionB) };
			const proposalB = { packId: packName, sectionId: "policy", content: "session B policy", expectedRevision: 0 };
			expect((await apiFetch(`/api/sessions/${sessionB}/proposal/project/seed`, {
				method: "POST", headers: agentB,
				body: JSON.stringify({ args: { name: "B", projectId: projectB.id, extensionPromptSections: [proposalB] } }),
			})).status).toBe(200);
			const draftB = await (await apiFetch(`/api/sessions/${sessionB}/proposal/project`)).text();
			const auditB = await readJson(await apiFetch(`/api/sessions/${sessionB}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			const crossSession = await rawApiFetch(`/api/sessions/${sessionB}/proposal/project/edit`, {
				method: "POST", headers: agentA,
				body: JSON.stringify({ old_text: "session B policy", new_text: "session A must not edit B" }),
			});
			expect(crossSession.status, `${REPRO}: session A secret cannot author session B's proposal`).toBe(403);
			expect(await (await apiFetch(`/api/sessions/${sessionB}/proposal/project`)).text()).toBe(draftB);
			expect(await readJson(await apiFetch(`/api/sessions/${sessionB}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }))).toEqual(auditB);
			expect((await apiFetch(`/api/sessions/${sessionB}/proposal/project/edit`, {
				method: "POST", headers: agentB,
				body: JSON.stringify({ old_text: "session B policy", new_text: "session B direct edit" }),
			})).status).toBe(200);
			const directAudit = await readJson(await apiFetch(`/api/sessions/${sessionB}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect(directAudit.entries.at(-1)).toMatchObject({ actor: "agent", sessionId: sessionB });

			sandboxSession = await createSession({ projectId: projectB.id });
			const sandboxSecret = { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sandboxSession) };
			const sandboxProposal = { packId: packName, sectionId: "policy", content: "sandbox policy", expectedRevision: 0 };
			expect((await apiFetch(`/api/sessions/${sandboxSession}/proposal/project/seed`, {
				method: "POST", headers: sandboxSecret,
				body: JSON.stringify({ args: { name: "Sandbox", projectId: projectB.id, extensionPromptSections: [sandboxProposal] } }),
			})).status).toBe(200);
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectB.id);
			gateway.sessionManager.sandboxTokenStore.addSession(projectB.id, sandboxSession);
			const sandboxAuditBefore = await readJson(await apiFetch(`/api/sessions/${sandboxSession}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect((await rawApiFetch(`/api/sessions/${sandboxSession}/proposal/project/edit`, {
				method: "POST", headers: { Authorization: `Bearer ${sandboxToken}` },
				body: JSON.stringify({ old_text: "sandbox policy", new_text: "sandbox direct edit" }),
			})).status, `${REPRO}: sandbox credentials cannot impersonate an authentic prompt author`).toBe(403);
			const sandboxAudit = await readJson(await apiFetch(`/api/sessions/${sandboxSession}/prompt-extension-audit`, { headers: operatorHeaders(humanCookie) }));
			expect(sandboxAudit).toEqual(sandboxAuditBefore);
			expect(sandboxAudit.entries.at(-1)).toMatchObject({ actor: "agent", sessionId: sandboxSession });
		} finally {
			for (const id of [sessionA, sessionB, sandboxSession]) if (id) await deleteSession(id);
			for (const project of [projectA, projectB]) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT", body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			}).catch(() => {});
			fs.rmSync(packDir, { recursive: true, force: true });
			fs.rmSync(rootA, { recursive: true, force: true });
			fs.rmSync(rootB, { recursive: true, force: true });
		}
	});

	test("atomically rejects every privileged prompt config spelling and value shape", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, "prompt-extension-projects", `privileged-config-${FIXTURE_SUFFIX}`);
		fs.mkdirSync(root, { recursive: true });
		const project = await registerProject({ name: `privileged-config-${FIXTURE_SUFFIX}`, rootPath: root, seedWorkflows: false });
		try {
			const keys = [
				"extension_prompt_sections", "extensionPromptSections",
				"extension_grants", "extensionGrants",
				"prompt_extension_budget", "promptExtensionBudget",
			] as const;
			const values: unknown[] = [null, "", "[]", '[{"packId":"forged"}]', [], {}];
			const before = await (await apiFetch(`/api/projects/${project.id}/config`)).text();
			for (const key of keys) {
				for (const value of values) {
					const response = await apiFetch(`/api/projects/${project.id}/config`, {
						method: "PUT", body: JSON.stringify({ [key]: value }),
					});
					expect(response.status, `${REPRO}: ${key} must be rejected before generic mutation for ${JSON.stringify(value)}`).toBe(422);
					const body = await readJson(response);
					expect(body.code).toBe(key === "extension_prompt_sections" || key === "extensionPromptSections"
						? "PROMPT_EXTENSION_PROPOSAL_REQUIRED" : "PROMPT_EXTENSION_CONFIG_FORBIDDEN");
					expect(await (await apiFetch(`/api/projects/${project.id}/config`)).text(), `${REPRO}: rejected ${key} must not alter config bytes`).toBe(before);
				}
			}
		} finally {
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
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

	test("rejects Dynamic Context markers from proposals and durable overrides without replacing valid bytes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-dynamic-delimiter-"));
		try {
			const store = new ProjectConfigStore(root);
			const valid: PromptExtensionOverride = {
				packId: "fixture", sectionId: "policy", content: "valid policy", revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "admin",
			};
			store.setPromptExtensionOverrides([valid]);
			for (const marker of [DYNAMIC_CONTEXT_START, DYNAMIC_CONTEXT_END]) {
				expect(() => validatePromptExtensionProposalSections([
					{ packId: "fixture", sectionId: "policy", content: `unsafe ${marker}`, expectedRevision: 1 },
				])).toThrow(expect.objectContaining({ code: "RESERVED_DELIMITER" }));
				expect(() => store.setPromptExtensionOverrides([
					{ ...valid, content: `unsafe ${marker}`, revision: 2 },
				])).toThrow(/Invalid prompt extension overrides/);
				expect(store.getPromptExtensionOverrides(), `${REPRO}: rejected ${marker} must preserve the prior override`).toEqual([valid]);
			}
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
