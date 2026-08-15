import { describe, expect, it } from "vitest";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX, type AstGrepLanguageAlias, type LspCapability } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import type { LanguageDetection } from "../../market-packs/code-intelligence/src/language-detection.ts";
import {
	deriveSandboxRequirements,
	type DerivedSandboxLayerRequirement,
} from "../../market-packs/code-intelligence/src/sandbox-requirements.ts";

const shellOrDockerfile = /(?:\bRUN\b|\bFROM\b|\bCOPY\b|\bdocker\b|\bsh\b|\bbash\b|\n|\r|;|&&|\|\|)/i;

function detection(component: string, languageId: AstGrepLanguageAlias): LanguageDetection {
	return {
		component,
		languageId,
		evidence: { fileCount: 1, matchedGlobs: [], rootMarkers: [] },
		structuralSearch: "available",
		lsp: "disabled",
		missing: [],
	};
}

function hasLsp<T extends object>(language: T): language is T & { lsp: LspCapability } {
	return "lsp" in language && language.lsp !== undefined;
}

function derive(detected: readonly LanguageDetection[], enabled: readonly string[]): readonly DerivedSandboxLayerRequirement[] {
	return deriveSandboxRequirements(detected, enabled);
}

describe("LSP sandbox requirements", () => {
	it("derives only enabled, detected LSP languages and keeps host and sandbox declarations independent", () => {
		const lspEntries = CODE_INTELLIGENCE_LANGUAGE_MATRIX.filter(hasLsp);
		expect(lspEntries.length).toBeGreaterThan(0);
		for (const language of lspEntries) {
			expect(Array.isArray(language.lsp.host)).toBe(true);
			expect(Array.isArray(language.lsp.sandbox)).toBe(true);
			expect(language.lsp.host).not.toBe(language.lsp.sandbox);
		}

		const detected = [
			detection("web", "typescript"),
			detection("api", "python"),
		];
		const typescriptOnly = derive(detected, ["typescript"]);
		expect(typescriptOnly.length).toBeGreaterThan(0);
		expect(JSON.stringify(typescriptOnly)).toContain("typescript");
		expect(JSON.stringify(typescriptOnly)).not.toContain("python");
		expect(derive(detected, [])).toEqual([]);
		expect(derive([], ["typescript", "python"])).toEqual([]);
	});

	it("deduplicates only declared named layers while preserving language attribution", () => {
		const detected = [
			detection("web", "typescript"),
			detection("api", "typescript"),
			detection("cli", "javascript"),
		];
		const requirements = derive(detected, ["typescript", "javascript"]);
		expect(requirements.length).toBeGreaterThan(0);
		expect(new Set(requirements.map(requirement => requirement.layerId)).size).toBe(requirements.length);
		expect(requirements.every(requirement => /^[a-z0-9][a-z0-9-]*$/.test(requirement.layerId))).toBe(true);

		expect(requirements.some(requirement => requirement.languageIds.includes("typescript"))).toBe(true);
		expect(requirements.some(requirement => requirement.languageIds.includes("javascript"))).toBe(true);
		for (const requirement of requirements) {
			expect(requirement.reasons).toEqual(expect.arrayContaining([
				expect.objectContaining({ languageId: expect.any(String), label: expect.any(String), reason: expect.any(String) }),
			]));
			expect(requirement.reasons.map(reason => reason.languageId)).toEqual(requirement.languageIds);
		}
	});

	it("returns pure build-contract data rather than a shell fragment, Dockerfile, mount, or build invocation", () => {
		const requirements = derive([detection("web", "typescript")], ["typescript"]);
		for (const requirement of requirements) {
			expect(requirement.layerId).not.toMatch(shellOrDockerfile);
		}
		const rendered = JSON.stringify(requirements);
		expect(rendered).not.toMatch(shellOrDockerfile);
		expect(rendered).not.toMatch(/workspace|mount|buildSandboxImage/i);
	});
});
