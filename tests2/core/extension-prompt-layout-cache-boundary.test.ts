import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { createRunArtifactDirectory, removeOwnedRunChild } from "../harness/run-isolation.js";
import {
	EXTENSION_PROMPT_REGION_START,
	assembleSystemPrompt,
	getPromptSections,
	getSystemPromptLayout,
	type PromptParts,
	type ResolvedSystemPromptSection,
} from "../../src/server/agent/system-prompt.ts";
import {
	PromptExtensionValidationError,
	assertPromptExtensionBudget,
	promptExtensionRegionBytes,
	promptExtensionSectionBytes,
} from "../../src/server/agent/prompt-extension-overrides.ts";

const fixtureRoot = createRunArtifactDirectory("extension-prompt-layout-cache-boundary");
const cwd = path.join(fixtureRoot, "project");
const stateDir = path.join(fixtureRoot, "state");
const basePromptPath = path.join(fixtureRoot, "system-prompt.md");
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(basePromptPath, "CORE SYSTEM \ud83e\udded", "utf8");
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "CORE AGENTS caf\u00e9", "utf8");

afterAll(() => removeOwnedRunChild(fixtureRoot));

function extension(packId: string, sectionId: string, content: string): ResolvedSystemPromptSection {
	return { packId, packName: `Pack ${packId}`, sectionId, title: `Extension ${sectionId}`, content };
}

const first = extension("pack-a", "first", "EXTENSION FIRST \ud83c\udf1f");
const second = extension("pack-b", "second", "EXTENSION SECOND \u00e9");

function parts(overrides: Partial<PromptParts> = {}): PromptParts {
	return {
		baseSystemPromptPath: basePromptPath,
		cwd,
		projectRoot: cwd,
		toolDocs: "# Tools\n\nCORE TOOLS",
		skillsCatalog: [{
			name: "core-skill",
			description: "CORE SKILL",
			content: "# Core skill\n\nCORE SKILL instructions.",
			source: "project",
			filePath: "/fixture/skills/core-skill/SKILL.md",
		}],
		goalTitle: "Goal",
		goalState: "in-progress",
		goalSpec: "VOLATILE GOAL",
		roleName: "tester",
		rolePrompt: "VOLATILE ROLE",
		taskType: "testing",
		taskTitle: "Prompt layout",
		taskSpec: "VOLATILE TASK",
		workflowContext: "VOLATILE WORKFLOW",
		dynamicContext: [{
			id: "dynamic", title: "Dynamic", providerId: "fixture:dynamic", authority: "generic",
			content: "VOLATILE DYNAMIC", reason: "fixture", priority: 1, tokenEstimate: 4,
		}],
		...overrides,
	};
}

function promptBytes(content: string | undefined): Buffer {
	assert.ok(content, "expected assembled prompt content");
	return Buffer.from(content, "utf8");
}

function assertInOrder(content: string, markers: string[]): void {
	let prior = -1;
	for (const marker of markers) {
		const index = content.indexOf(marker);
		assert.ok(index > prior, `expected '${marker}' after prior prompt section`);
		prior = index;
	}
}

describe("static extension prompt layout", () => {
	it("keeps core, attributed extensions, volatile sections, and Dynamic Context in canonical order", () => {
		const input = parts({ extensionPromptSections: [first, second] });
		const layout = getSystemPromptLayout(input);
		const content = layout.content;
		assert.ok(content);

		assertInOrder(content, [
			"CORE SYSTEM \ud83e\udded", "CORE AGENTS caf\u00e9", "# Working Directory", "CORE TOOLS", "CORE SKILL",
			EXTENSION_PROMPT_REGION_START, "EXTENSION FIRST \ud83c\udf1f", "EXTENSION SECOND \u00e9",
			"VOLATILE GOAL", "VOLATILE ROLE", "VOLATILE TASK", "VOLATILE WORKFLOW", "VOLATILE DYNAMIC",
		]);
		assert.ok(content.endsWith("\n"), "assembled prompts retain the historical trailing newline");

		const inspector = getPromptSections(input);
		assert.deepEqual(inspector, layout.sections, "inspector must project the same canonical layout used for assembly");
		assert.deepEqual(inspector.map(section => section.label), [
			"System Prompt", "Project AGENTS.md", "Working Directory", "Tools", "Available Skills",
			"Extension first", "Extension second", "Goal", "Role", "Task", "Workflow Context", "Dynamic Context",
		]);
		assert.equal(inspector.at(-1)?.label, "Dynamic Context");
		for (const section of inspector) assert.ok(content.includes(section.content), `inspected '${section.label}' must be present in prompt bytes`);

		const promptPath = assembleSystemPrompt("extension-layout-parity", input, stateDir);
		assert.ok(promptPath);
		assert.equal(fs.readFileSync(promptPath, "utf8"), content, "assembler must write the inspected layout verbatim");
	});

	it("preserves the exact UTF-8 stable prefix and digest across enable, disable, and extension reorder", () => {
		const enabled = getSystemPromptLayout(parts({ extensionPromptSections: [first, second] }));
		const reordered = getSystemPromptLayout(parts({ extensionPromptSections: [second, first] }));
		const oneEnabled = getSystemPromptLayout(parts({ extensionPromptSections: [first] }));
		const disabled = getSystemPromptLayout(parts({ extensionPromptSections: [] }));
		const layouts = [enabled, reordered, oneEnabled, disabled];
		const baselineBytes = promptBytes(enabled.content);
		const baselinePrefix = baselineBytes.subarray(0, enabled.extensionRegionStartByteOffset);

		for (const layout of layouts) {
			const bytes = promptBytes(layout.content);
			assert.equal(layout.extensionRegionStartByteOffset, enabled.extensionRegionStartByteOffset);
			assert.deepEqual(bytes.subarray(0, layout.extensionRegionStartByteOffset), baselinePrefix);
			assert.equal(layout.stablePrefixSha256, createHash("sha256").update(baselinePrefix).digest("hex"));
		}
		assert.notDeepEqual(promptBytes(enabled.content).subarray(enabled.extensionRegionStartByteOffset), promptBytes(reordered.content).subarray(reordered.extensionRegionStartByteOffset));
		assert.equal(disabled.extensionRegionBytes, 0);
		assert.equal(disabled.content?.includes(EXTENSION_PROMPT_REGION_START), false, "disabled extensions emit no region marker");
	});

	it("keeps the cache boundary stable when sectionOrder includes Dynamic Context", () => {
		// `bobbit.promptSectionOrder` may include Dynamic Context, but provider
		// context is protected-last. The one layout must derive the splice point
		// after ordering so zero, one, or two extensions preserve its exact prefix.
		const ordered = { sectionOrder: ["Dynamic Context", "Goal"] };
		const noExtensions = getSystemPromptLayout(parts(ordered));
		const oneExtension = getSystemPromptLayout(parts({ ...ordered, extensionPromptSections: [first] }));
		const twoExtensions = getSystemPromptLayout(parts({ ...ordered, extensionPromptSections: [first, second] }));
		const layouts = [noExtensions, oneExtension, twoExtensions];
		const prefix = promptBytes(noExtensions.content).subarray(0, noExtensions.extensionRegionStartByteOffset);
		const expectedDigest = createHash("sha256").update(prefix).digest("hex");

		for (const layout of layouts) {
			const bytes = promptBytes(layout.content);
			assert.equal(layout.extensionRegionStartByteOffset, noExtensions.extensionRegionStartByteOffset);
			assert.deepEqual(bytes.subarray(0, layout.extensionRegionStartByteOffset), prefix);
			assert.equal(layout.stablePrefixSha256, expectedDigest);
			assert.equal(layout.sections.at(-1)?.label, "Dynamic Context");
		}

		assertInOrder(noExtensions.content!, [
			"VOLATILE GOAL", "CORE SYSTEM 🧭", "CORE AGENTS café", "CORE TOOLS", "CORE SKILL",
			"VOLATILE ROLE", "VOLATILE TASK", "VOLATILE WORKFLOW", "VOLATILE DYNAMIC",
		]);
		assert.equal(noExtensions.content?.includes(EXTENSION_PROMPT_REGION_START), false);

		assertInOrder(oneExtension.content!, [
			"VOLATILE GOAL", "CORE SYSTEM 🧭", "CORE AGENTS café", "CORE TOOLS", "CORE SKILL",
			EXTENSION_PROMPT_REGION_START, "EXTENSION FIRST 🌟", "VOLATILE ROLE", "VOLATILE TASK", "VOLATILE WORKFLOW", "VOLATILE DYNAMIC",
		]);
		assertInOrder(twoExtensions.content!, [
			"VOLATILE GOAL", "CORE SYSTEM 🧭", "CORE AGENTS café", "CORE TOOLS", "CORE SKILL",
			EXTENSION_PROMPT_REGION_START, "EXTENSION FIRST 🌟", "EXTENSION SECOND é", "VOLATILE ROLE", "VOLATILE TASK", "VOLATILE WORKFLOW", "VOLATILE DYNAMIC",
		]);
	});

	it("takes the exact legacy no-extension path for omitted, undefined, and empty extension inputs", () => {
		const omitted = getSystemPromptLayout(parts());
		const undefinedExtensions = getSystemPromptLayout(parts({ extensionPromptSections: undefined }));
		const empty = getSystemPromptLayout(parts({ extensionPromptSections: [] }));

		assert.equal(undefinedExtensions.content, omitted.content);
		assert.equal(empty.content, omitted.content);
		assert.equal(empty.totalPromptBytes, omitted.totalPromptBytes);
		assert.equal(empty.content?.includes(EXTENSION_PROMPT_REGION_START), false);
	});
});

describe("static extension wrapper-inclusive budgets", () => {
	it("rejects per-section and aggregate limits using rendered UTF-8 bytes without truncation", () => {
		const section = { packId: "pack-a", sectionId: "unicode", content: "\u00e9" };
		const renderedBytes = promptExtensionSectionBytes(section);
		const regionBytes = promptExtensionRegionBytes([section]);
		assert.ok(renderedBytes > Buffer.byteLength(section.content, "utf8"), "section marker wrappers must count toward the cap");

		assert.throws(
			() => assertPromptExtensionBudget([section], { maxBytesPerSection: renderedBytes - 1, maxBytesTotal: regionBytes }),
			(error: unknown) => error instanceof PromptExtensionValidationError && error.code === "OVER_BUDGET" && /section exceeds its UTF-8 byte budget/.test(error.message),
		);
		assert.throws(
			() => assertPromptExtensionBudget([section], { maxBytesPerSection: renderedBytes, maxBytesTotal: regionBytes - 1 }),
			(error: unknown) => error instanceof PromptExtensionValidationError && error.code === "OVER_BUDGET" && /region exceeds its UTF-8 byte budget/.test(error.message),
		);
		assert.doesNotThrow(() => assertPromptExtensionBudget([section], { maxBytesPerSection: renderedBytes, maxBytesTotal: regionBytes }));
	});
});
