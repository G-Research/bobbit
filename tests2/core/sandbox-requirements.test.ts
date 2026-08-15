import { describe, expect, it } from "vitest";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import { deriveSandboxRequirements } from "../../market-packs/code-intelligence/src/sandbox-requirements.ts";

type Detection = { component: string; languageId: string };
type Layer = { layerId: string; languageIds?: readonly string[]; languages?: readonly string[]; reasons?: readonly string[] };
type Language = { id: string; lsp?: { host: readonly unknown[]; sandbox: readonly unknown[] } };

const shellOrDockerfile = /(?:\bRUN\b|\bFROM\b|\bCOPY\b|\bdocker\b|\bsh\b|\bbash\b|\n|\r|;|&&|\|\|)/i;

function derive(detected: readonly Detection[], enabled: readonly string[]): readonly Layer[] {
	return deriveSandboxRequirements(detected as never, enabled) as readonly Layer[];
}

describe("LSP sandbox requirements", () => {
	it("derives only enabled, detected LSP languages and keeps host and sandbox declarations independent", () => {
		const matrix = CODE_INTELLIGENCE_LANGUAGE_MATRIX as unknown as readonly Language[];
		const lspEntries = matrix.filter((language): language is Language & { lsp: NonNullable<Language["lsp"]> } => Boolean(language.lsp));
		expect(lspEntries.length).toBeGreaterThan(0);
		for (const language of lspEntries) {
			expect(Array.isArray(language.lsp.host)).toBe(true);
			expect(Array.isArray(language.lsp.sandbox)).toBe(true);
			expect(language.lsp.host).not.toBe(language.lsp.sandbox);
		}

		const detected = [
			{ component: "web", languageId: "typescript" },
			{ component: "api", languageId: "python" },
		] as const;
		const typescriptOnly = derive(detected, ["typescript"]);
		expect(typescriptOnly.length).toBeGreaterThan(0);
		expect(JSON.stringify(typescriptOnly)).toContain("typescript");
		expect(JSON.stringify(typescriptOnly)).not.toContain("python");
		expect(derive(detected, [])).toEqual([]);
		expect(derive([], ["typescript", "python"])).toEqual([]);
	});

	it("deduplicates only declared named layers while preserving language attribution", () => {
		const detected = [
			{ component: "web", languageId: "typescript" },
			{ component: "api", languageId: "typescript" },
			{ component: "cli", languageId: "javascript" },
		] as const;
		const requirements = derive(detected, ["typescript", "javascript"]);
		expect(requirements.length).toBeGreaterThan(0);
		expect(new Set(requirements.map(requirement => requirement.layerId)).size).toBe(requirements.length);
		expect(requirements.every(requirement => /^[a-z0-9][a-z0-9-]*$/.test(requirement.layerId))).toBe(true);

		const rendered = JSON.stringify(requirements);
		expect(rendered).toContain("typescript");
		expect(rendered).toContain("javascript");
	});

	it("returns pure build-contract data rather than a shell fragment, Dockerfile, mount, or build invocation", () => {
		const requirements = derive([{ component: "web", languageId: "typescript" }], ["typescript"]);
		for (const requirement of requirements) {
			expect(requirement.layerId).not.toMatch(shellOrDockerfile);
		}
		const rendered = JSON.stringify(requirements);
		expect(rendered).not.toMatch(shellOrDockerfile);
		expect(rendered).not.toMatch(/workspace|mount|buildSandboxImage/i);
	});
});
