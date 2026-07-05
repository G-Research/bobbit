/**
 * Write-side counterpart to `slash-skills.ts` discovery (F26 — the
 * propose_skill half; the goalCompleted lesson-extraction reviewer that
 * would draft these proposals lives in the hindsight pack, a separate lane).
 *
 * Writes a single `skills/<name>/SKILL.md` file into a scope's user-pack
 * directory (`ProjectContext.configDir`, or `bobbitConfigDir()` for the
 * Headquarters/server scope — see docs/marketplace.md "one resolver over
 * one ordered list"). This is the ONLY write path for skills today; there is
 * no create/update REST resource before this (the Skills page is read-only
 * — see src/app/skills-page.ts).
 *
 * Frontmatter shape mirrors `parseFrontmatter` / `scanSkillDir` in
 * slash-skills.ts exactly (`name`, `description`, `argument-hint`,
 * `allowed-tools`) so a skill written here round-trips through discovery
 * unchanged.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";

/** Same identifier shape as role/tool names (role-store.ts NAME_PATTERN). */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export function isValidSkillName(name: unknown): name is string {
	return typeof name === "string" && SKILL_NAME_PATTERN.test(name);
}

export interface SkillWriteInput {
	name: string;
	description: string;
	content: string;
	argumentHint?: string;
	/** Allowed-tools list; serialized as a comma-joined `allowed-tools` frontmatter string. */
	allowedTools?: string[];
}

/** Build the SKILL.md file content (frontmatter + body) for a skill. */
export function serializeSkillFile(input: SkillWriteInput): string {
	const fm: Record<string, unknown> = {
		name: input.name,
		description: input.description,
	};
	if (input.argumentHint && input.argumentHint.trim()) fm["argument-hint"] = input.argumentHint.trim();
	if (input.allowedTools && input.allowedTools.length > 0) fm["allowed-tools"] = input.allowedTools.join(", ");
	const fmYaml = yamlStringify(fm).trimEnd();
	const body = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
	return `---\n${fmYaml}\n---\n\n${body}`;
}

/**
 * Write `<configDir>/skills/<name>/SKILL.md` atomically (write-tmp + rename).
 * `configDir` is the target scope's user-pack root — `ProjectContext.configDir`
 * for a project, or `bobbitConfigDir()` for Headquarters/server scope; both
 * already equal `scopePaths(scope, base).userPackRoot` (pack-types.ts).
 */
export async function writeSkillFile(configDir: string, input: SkillWriteInput): Promise<{ filePath: string }> {
	if (!isValidSkillName(input.name)) {
		throw new Error("Skill name must be lowercase alphanumeric + hyphens");
	}
	if (!input.description || !input.description.trim()) {
		throw new Error("Missing description");
	}
	if (!input.content || !input.content.trim()) {
		throw new Error("Missing content");
	}
	const dir = path.join(configDir, "skills", input.name);
	await fsp.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	const tmpPath = `${filePath}.tmp`;
	await fsp.writeFile(tmpPath, serializeSkillFile(input), "utf8");
	await fsp.rename(tmpPath, filePath);
	return { filePath };
}
