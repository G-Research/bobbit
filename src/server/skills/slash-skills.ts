/**
 * Slash-skill discovery and parsing.
 *
 * Discovers SKILL.md files from Claude Code-compatible locations:
 *   - .claude/skills/<name>/SKILL.md  (project)
 *   - ~/.claude/skills/<name>/SKILL.md (personal)
 *   - .claude/commands/<name>.md       (legacy)
 *
 * Skills provide slash-command autocomplete and can inject instructions
 * into the agent's prompt when invoked via `/skill-name`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SlashSkill {
	/** Slash command name (without leading /) */
	name: string;
	/** Human-readable description */
	description: string;
	/** Hint shown during autocomplete for expected arguments */
	argumentHint?: string;
	/** If true, Claude cannot auto-invoke this skill */
	disableModelInvocation?: boolean;
	/** If false, hidden from / menu (background knowledge only) */
	userInvocable?: boolean;
	/** Raw markdown content (instructions) */
	content: string;
	/** Source: "project", "personal", or "legacy" */
	source: "project" | "personal" | "legacy";
	/** Absolute path to the SKILL.md or command .md file */
	filePath: string;
	/** Optional allowed tools list */
	allowedTools?: string[];
	/** Optional context mode (e.g. "fork") */
	context?: string;
	/** Optional agent type for forked context */
	agent?: string;
}

interface FrontMatter {
	name?: string;
	description?: string;
	"argument-hint"?: string;
	"disable-model-invocation"?: boolean;
	"user-invocable"?: boolean;
	"allowed-tools"?: string;
	context?: string;
	agent?: string;
}

/** Parse YAML frontmatter from a SKILL.md or command .md file. */
function parseFrontmatter(raw: string): { frontmatter: FrontMatter; content: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { frontmatter: {}, content: raw };

	const yamlBlock = match[1];
	const content = match[2];
	const fm: FrontMatter = {};

	// Simple YAML parser for flat key: value pairs
	for (const line of yamlBlock.split(/\r?\n/)) {
		const kv = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
		if (!kv) continue;
		const key = kv[1].trim();
		let value: string | boolean = kv[2].trim();

		// Handle boolean values
		if (value === "true") value = true;
		else if (value === "false") value = false;

		(fm as any)[key] = value;
	}

	return { frontmatter: fm, content };
}

/** Apply $ARGUMENTS, $ARGUMENTS[N], and $N substitutions. */
export function applySubstitutions(content: string, args: string): string {
	// Split arguments by whitespace
	const argParts = args.trim() ? args.trim().split(/\s+/) : [];

	// Replace $ARGUMENTS[N] and $N (indexed)
	let result = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => argParts[parseInt(idx)] ?? "");
	result = result.replace(/\$(\d+)/g, (_, idx) => argParts[parseInt(idx)] ?? "");

	// Replace $ARGUMENTS (full string)
	result = result.replace(/\$ARGUMENTS/g, args);

	return result;
}

/** Scan a directory for SKILL.md files (each in a subdirectory). */
function scanSkillDir(dir: string, source: SlashSkill["source"]): SlashSkill[] {
	const skills: SlashSkill[] = [];
	if (!fs.existsSync(dir)) return skills;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return skills;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillFile = path.join(dir, entry.name, "SKILL.md");
		if (!fs.existsSync(skillFile)) continue;

		try {
			const raw = fs.readFileSync(skillFile, "utf-8");
			const { frontmatter, content } = parseFrontmatter(raw);

			const name = frontmatter.name || entry.name;
			const description = frontmatter.description ||
				content.split("\n").find((l) => l.trim().length > 0)?.trim() || "";

			skills.push({
				name,
				description,
				argumentHint: frontmatter["argument-hint"],
				disableModelInvocation: frontmatter["disable-model-invocation"],
				userInvocable: frontmatter["user-invocable"],
				content,
				source,
				filePath: skillFile,
				allowedTools: frontmatter["allowed-tools"]
					? frontmatter["allowed-tools"].split(/,\s*/)
					: undefined,
				context: frontmatter.context,
				agent: frontmatter.agent,
			});
		} catch (err) {
			console.warn(`[slash-skills] Failed to parse ${skillFile}:`, err);
		}
	}

	return skills;
}

/** Scan legacy .claude/commands/ directory for .md files. */
function scanCommandsDir(dir: string): SlashSkill[] {
	const skills: SlashSkill[] = [];
	if (!fs.existsSync(dir)) return skills;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return skills;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		const baseName = entry.name.replace(/\.md$/, "");

		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, content } = parseFrontmatter(raw);

			const name = frontmatter.name || baseName;
			const description = frontmatter.description ||
				content.split("\n").find((l) => l.trim().length > 0)?.trim() || "";

			skills.push({
				name,
				description,
				argumentHint: frontmatter["argument-hint"],
				disableModelInvocation: frontmatter["disable-model-invocation"],
				userInvocable: frontmatter["user-invocable"],
				content,
				source: "legacy",
				filePath,
				allowedTools: frontmatter["allowed-tools"]
					? frontmatter["allowed-tools"].split(/,\s*/)
					: undefined,
				context: frontmatter.context,
				agent: frontmatter.agent,
			});
		} catch (err) {
			console.warn(`[slash-skills] Failed to parse command ${filePath}:`, err);
		}
	}

	return skills;
}

// Simple TTL cache
let _cache: { skills: SlashSkill[]; cwd: string; ts: number } | null = null;
const CACHE_TTL_MS = 5_000;

/**
 * Discover all slash skills for a given working directory.
 * Merges project, personal, and legacy sources. Project skills take priority
 * over personal skills with the same name. Legacy commands have lowest priority.
 */
export function discoverSlashSkills(cwd: string): SlashSkill[] {
	if (_cache && _cache.cwd === cwd && Date.now() - _cache.ts < CACHE_TTL_MS) {
		return _cache.skills;
	}

	const projectSkillsDir = path.join(cwd, ".claude", "skills");
	const personalSkillsDir = path.join(os.homedir(), ".claude", "skills");
	const legacyCommandsDir = path.join(cwd, ".claude", "commands");

	const projectSkills = scanSkillDir(projectSkillsDir, "project");
	const personalSkills = scanSkillDir(personalSkillsDir, "personal");
	const legacyCommands = scanCommandsDir(legacyCommandsDir);

	// Merge with priority: project > personal > legacy
	const byName = new Map<string, SlashSkill>();
	for (const skill of legacyCommands) byName.set(skill.name, skill);
	for (const skill of personalSkills) byName.set(skill.name, skill);
	for (const skill of projectSkills) byName.set(skill.name, skill);

	// Filter to user-invocable skills only (default is true)
	const skills = Array.from(byName.values()).filter(
		(s) => s.userInvocable !== false
	);

	// Sort alphabetically
	skills.sort((a, b) => a.name.localeCompare(b.name));

	_cache = { skills, cwd, ts: Date.now() };
	return skills;
}

/** Look up a single slash skill by name. */
export function getSlashSkill(cwd: string, name: string): SlashSkill | undefined {
	return discoverSlashSkills(cwd).find((s) => s.name === name);
}

/**
 * Build the prompt text to inject when a slash skill is invoked.
 * Applies argument substitutions and returns the processed content.
 * If $ARGUMENTS is not present in the content, appends "ARGUMENTS: <args>" at the end.
 */
export function buildSlashSkillPrompt(skill: SlashSkill, args: string): string {
	let content = skill.content;

	if (args.trim()) {
		const hasArgsPlaceholder = /\$ARGUMENTS|\$\d+/.test(content);
		content = applySubstitutions(content, args);
		if (!hasArgsPlaceholder) {
			content += `\n\nARGUMENTS: ${args}`;
		}
	}

	return content;
}
