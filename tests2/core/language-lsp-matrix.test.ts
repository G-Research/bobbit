import { describe, expect, it } from "vitest";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import { deriveLanguageCapabilityStatus, type LspServiceInstanceKey } from "../../market-packs/code-intelligence/lib/capability-status.ts";
import type { LanguageDetection } from "../../market-packs/code-intelligence/lib/language-detection.ts";

type LanguageRecord = {
	id: string;
	label: string;
	evidence: { globs: readonly string[]; rootMarkers: readonly string[]; minimumFiles: number };
	structuralSearch: { state: "supported" | "unsupported"; astGrepGrammar?: string };
	lsp?: {
		server: { id: string; command: string; args: readonly string[]; version?: { range: string; reason: string } };
		rootMarkers: readonly string[];
		actions: readonly string[];
		host: readonly ToolchainRequirement[];
		sandbox: readonly (ToolchainRequirement & { layerId: string })[];
	};
};

type ToolchainRequirement = {
	id: string;
	label: string;
	executable?: string;
	installHint: string;
	version?: { range: string; reason: string };
};

const actions = new Set(["definition", "references", "hover", "documentSymbols", "workspaceSymbols", "diagnostics"]);
const shellSyntax = /[\n\r;&|`$<>]/;
const safeLayerId = /^[a-z0-9][a-z0-9.-]*$/;

function records(): readonly LanguageRecord[] {
	return CODE_INTELLIGENCE_LANGUAGE_MATRIX as unknown as readonly LanguageRecord[];
}

function assertRequirement(requirement: ToolchainRequirement): void {
	expect(requirement.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
	expect(requirement.label.trim()).not.toBe("");
	expect(requirement.installHint.trim()).not.toBe("");
	expect(requirement.id).not.toMatch(shellSyntax);
	expect(requirement.label).not.toMatch(shellSyntax);
	expect(requirement.installHint).not.toMatch(shellSyntax);
	if (requirement.executable) expect(requirement.executable).not.toMatch(shellSyntax);
	if (requirement.version) {
		expect(requirement.version.range.trim()).not.toBe("");
		expect(requirement.version.reason.trim()).not.toBe("");
	}
}

describe("Language LSP capability matrix", () => {
	it("keeps language evidence, structural search, and LSP declarations independently data-driven", () => {
		const matrix = records();
		expect(new Set(matrix.map(language => language.id)).size).toBe(matrix.length);

		for (const language of matrix) {
			expect(language.label.trim()).not.toBe("");
			expect(language.evidence.globs.length).toBeGreaterThan(0);
			expect(Array.isArray(language.evidence.rootMarkers)).toBe(true);
			expect(language.evidence.minimumFiles).toBeGreaterThan(0);
			expect(language.structuralSearch.state).toMatch(/^(supported|unsupported)$/);
			if (language.structuralSearch.state === "supported") {
				expect(language.structuralSearch.astGrepGrammar).toMatch(/\S/);
			} else {
				expect(language.structuralSearch.astGrepGrammar).toBeUndefined();
			}
		}
	});

	it("declares the initial maintained LSP languages without equating LSP with structural search", () => {
		const byId = new Map(records().map(language => [language.id, language]));
		for (const id of ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "c", "cpp", "csharp"]) {
			expect(byId.get(id)?.lsp, `${id} needs an explicit LSP declaration`).toBeDefined();
		}

		const structuralOnly = records().filter(language => language.structuralSearch.state === "supported" && !language.lsp);
		expect(structuralOnly.length).toBeGreaterThan(0);
		expect(structuralOnly.every(language => language.lsp === undefined)).toBe(true);
		expect(records().every(language => language.lsp || language.structuralSearch.state === "supported" || language.structuralSearch.state === "unsupported")).toBe(true);
	});

	it("keeps TSX structural grammar independent while declaring the TypeScript LSP", () => {
		const byId = new Map(records().map(language => [language.id, language]));
		const typescript = byId.get("typescript");
		const tsx = byId.get("tsx");
		expect(tsx?.structuralSearch.astGrepGrammar).toBe("Tsx");
		expect(tsx?.structuralSearch.astGrepGrammar).not.toBe(typescript?.structuralSearch.astGrepGrammar);
		expect(tsx?.lsp?.server).toEqual(typescript?.lsp?.server);
		expect(tsx?.lsp?.actions).toEqual(typescript?.lsp?.actions);
	});

	it("never reports ready from toolchain IDs without an exact compatible platform service snapshot", () => {
		const detection = {
			component: "frontend",
			languageId: "typescript",
			structuralSearch: "available",
			evidence: { fileCount: 1, matchedGlobs: ["**/*.ts"], rootMarkers: [] },
			lsp: "disabled",
			missing: [] as const,
		} satisfies LanguageDetection;
		const serviceKey: LspServiceInstanceKey = {
			projectId: "project-1", component: "frontend", worktreePath: "/linked-worktrees/frontend", languageId: "typescript",
		};
		const options = {
			enabledLanguageIds: ["typescript"], runtime: "host" as const,
			availableToolchainIds: ["node", "typescript-language-server", "typescript"], serviceKey,
		};

		expect(deriveLanguageCapabilityStatus(detection, options).lsp.state).toBe("unavailable");
		expect(deriveLanguageCapabilityStatus(detection, {
			...options,
			serviceSnapshot: { key: { ...serviceKey, worktreePath: "/other-worktree" }, state: "ready", serverId: "typescript-language-server", serverVersion: "4.3.0", versionCompatible: true },
		}).lsp.state).toBe("unavailable");
		expect(deriveLanguageCapabilityStatus(detection, {
			...options,
			serviceSnapshot: { key: serviceKey, state: "ready", serverId: "typescript-language-server", serverVersion: "4.3.0", versionCompatible: false },
		}).lsp.state).toBe("unavailable");
		expect(deriveLanguageCapabilityStatus(detection, {
			...options,
			serviceSnapshot: { key: serviceKey, state: "ready", serverId: "typescript-language-server", serverVersion: "4.3.0", versionCompatible: true },
		}).lsp.state).toBe("ready");
	});

	it("uses declarative servers, roots, actions, and version-constrained named toolchains", () => {
		for (const language of records().filter((entry): entry is LanguageRecord & { lsp: NonNullable<LanguageRecord["lsp"]> } => Boolean(entry.lsp))) {
			const { lsp } = language;
			expect(lsp.server.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
			expect(lsp.server.command).toMatch(/^\S+$/);
			expect(lsp.server.command).not.toMatch(shellSyntax);
			expect(lsp.server.args.length).toBeGreaterThanOrEqual(0);
			expect(lsp.server.args.every(arg => arg.length > 0 && !shellSyntax.test(arg))).toBe(true);
			expect(lsp.server.version, `${language.id} server must state compatible version evidence`).toEqual(expect.objectContaining({ range: expect.any(String), reason: expect.any(String) }));
			expect(language.evidence.rootMarkers.length).toBeGreaterThan(0);
			expect(lsp.rootMarkers.length).toBeGreaterThan(0);
			expect(lsp.actions.length).toBeGreaterThan(0);
			expect(new Set(lsp.actions).size).toBe(lsp.actions.length);
			expect(lsp.actions.every(action => actions.has(action))).toBe(true);
			for (const requirement of lsp.host) assertRequirement(requirement);
			for (const requirement of lsp.sandbox) {
				assertRequirement(requirement);
				expect(requirement.layerId).toMatch(safeLayerId);
				expect(requirement.layerId).not.toMatch(shellSyntax);
				expect(requirement.layerId).not.toMatch(/\s/);
			}
		}
	});
});
