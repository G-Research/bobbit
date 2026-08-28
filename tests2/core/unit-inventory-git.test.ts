import { describe, expect, it } from "vitest";
import { reconcileSemanticMappings } from "../../scripts/testing-v2/unit-inventory-audit.mjs";
import { readOptionalGitPath } from "../../scripts/testing-v2/unit-inventory-git.mjs";

const revision = "0123456789abcdef";
const historicalPath = "scripts/testing-v2/integration-e2e-files.mjs";

function gitFailure(stderr: string, status = 128): Error & { status: number; stderr: Buffer } {
	return Object.assign(new Error("Git failed"), {
		status,
		stderr: Buffer.from(stderr, "utf-8"),
	});
}

describe("optional historical inventory Git source", () => {
	it("returns empty text only when the requested path is absent at the revision", () => {
		const calls: string[][] = [];
		const source = readOptionalGitPath((args: string[]) => {
			calls.push(args);
			throw gitFailure(`fatal: path '${historicalPath}' does not exist in '${revision}'\n`);
		}, { path: historicalPath, revision });

		expect(source).toBe("");
		expect(calls).toEqual([["show", `${revision}:${historicalPath}`]]);
	});

	it("keeps unrelated Git failures fatal", () => {
		const failure = gitFailure("fatal: not a git repository (or any of the parent directories): .git\n");
		let caught: unknown;
		try {
			readOptionalGitPath(() => { throw failure; }, { path: historicalPath, revision });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
	});
});

describe("declaration semantic mapping lifecycle", () => {
	const baseFile = "tests2/core/retired.test.ts";
	const baseName = "retired declaration";
	const targetFile = "tests2/core/successor.test.ts";
	const targetName = "successor declaration";
	const mapping = {
		baseFile,
		baseName,
		current: [{ file: targetFile, name: targetName }],
		rationale: "The successor preserves the retired declaration.",
	};

	it("reconciles mappings while their source belongs to the selected pre-cutover base", () => {
		const result = reconcileSemanticMappings({
			semanticMappings: [mapping],
			baseNamesByFile: new Map([[baseFile, [baseName]]]),
			missingDeclarations: [{ file: baseFile, name: baseName }],
			currentNamesByFile: new Map([[targetFile, [targetName]]]),
		});

		expect([...result.mappingByBase.values()]).toEqual([mapping]);
		expect(result.invalidSemanticMappings).toEqual([]);
	});

	it("ignores an absent historical source while still validating a surviving source", () => {
		const historicalBaseName = "historical declaration in surviving file";
		const staleBaseName = "declaration still present in selected base";
		const historicalMapping = {
			baseFile: targetFile,
			baseName: historicalBaseName,
			current: [{ file: targetFile, name: targetName }],
			rationale: "The same-file successor preserves the historical declaration.",
		};
		const staleMapping = {
			...historicalMapping,
			baseName: staleBaseName,
		};
		const result = reconcileSemanticMappings({
			semanticMappings: [mapping, historicalMapping, staleMapping],
			baseNamesByFile: new Map([[targetFile, [staleBaseName]]]),
			missingDeclarations: [],
			currentNamesByFile: new Map([[targetFile, [targetName]]]),
		});

		expect([...result.mappingByBase.values()]).toEqual([staleMapping]);
		expect(result.invalidSemanticMappings).toEqual([
			`${targetFile} :: ${staleBaseName} — stale mapping; base declaration is not missing`,
		]);
	});

	it("keeps stale-source and missing-target validation while the source exists", () => {
		const baseNamesByFile = new Map([[baseFile, [baseName]]]);
		const stale = reconcileSemanticMappings({
			semanticMappings: [mapping],
			baseNamesByFile,
			missingDeclarations: [],
			currentNamesByFile: new Map([[targetFile, [targetName]]]),
		});
		const missingTarget = reconcileSemanticMappings({
			semanticMappings: [mapping],
			baseNamesByFile,
			missingDeclarations: [{ file: baseFile, name: baseName }],
			currentNamesByFile: new Map([[targetFile, ["different declaration"]]]),
		});

		expect(stale.invalidSemanticMappings).toEqual([
			`${baseFile} :: ${baseName} — stale mapping; base declaration is not missing`,
		]);
		expect(missingTarget.invalidSemanticMappings).toEqual([
			`${baseFile} :: ${baseName} — target not found: ${targetFile} :: ${targetName}`,
		]);
	});
});
