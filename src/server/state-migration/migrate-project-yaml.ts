/**
 * One-shot migration: synthesize `components: []` (and inline `workflows:`)
 * for legacy single-repo projects.
 *
 * See docs/design/multi-repo-components.md §1.3.
 *
 * Idempotent: if `components:` is already present, this is a no-op. The
 * migration runs once per project at server boot, before any pool fill.
 *
 * Behavior:
 *   1. Read `<configDir>/project.yaml`.
 *   2. If `components:` already present → log nothing and return.
 *   3. Build a one-element `components[]`:
 *        - name: project's name from the registry (NOT "default")
 *        - repo: "."
 *        - worktreeSetupCommand: legacy `worktree_setup_command` if non-empty
 *        - commands: { build, test, check, unit, e2e, ...other *_command }
 *      Drop empty/whitespace values.
 *   4. Move any `<configDir>/workflows/*.yaml` files into the inline
 *      `workflows:` block, then `rm -rf` the workflows dir.
 *   5. Atomic write (tmp + rename). Log `[migrate] project.yaml v2: <name>`.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { buildDefaultWorkflows } from "./seed-default-workflows.js";

interface MigrateOpts {
	configDir: string;
	projectName: string;
}

interface MigrateResult {
	migrated: boolean;
	componentName?: string;
	commandKeys?: string[];
	workflowsMigrated?: number;
	workflowsDirRemoved?: boolean;
	/** True if `workflows:` was missing AND no project-local workflows dir existed,
	 *  and the migration seeded the four canonical default workflows. */
	workflowsSeeded?: boolean;
}

/** Map legacy `*_command` key → component command name. */
const LEGACY_KEY_MAP: Record<string, string> = {
	build_command: "build",
	test_command: "test",
	typecheck_command: "check",
	test_unit_command: "unit",
	test_e2e_command: "e2e",
	lint_command: "lint",
	format_command: "format",
};

function isNonEmpty(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

export function migrateProjectYaml(opts: MigrateOpts): MigrateResult {
	const yamlFile = path.join(opts.configDir, "project.yaml");
	const workflowsDir = path.join(opts.configDir, "workflows");

	let raw: Record<string, unknown> = {};
	let fileExisted = false;
	if (fs.existsSync(yamlFile)) {
		fileExisted = true;
		try {
			const parsed = yaml.parse(fs.readFileSync(yamlFile, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch (err) {
			console.error("[migrate] Failed to parse project.yaml; aborting migration:", err);
			return { migrated: false };
		}
	}

	// Idempotent: skip the components synthesis pass if components: already present.
	// BUT we may still need to seed default workflows for projects that were
	// migrated by an earlier server build (which left them with components but no
	// workflows, since `defaults/workflows/*.yaml` was the runtime fallback). See
	// Issue 1 of the multi-repo follow-up — without this, every existing project
	// loses access to general/feature/bug-fix/quick-fix after Follow-up A.
	if (Array.isArray(raw.components)) {
		return maybeSeedWorkflowsOnly({ raw, yamlFile, configDir: opts.configDir, projectName: opts.projectName });
	}

	// Bail out if there is genuinely nothing to migrate AND no workflows dir.
	const hasLegacyCommands = Object.keys(LEGACY_KEY_MAP).some(k => isNonEmpty(raw[k]))
		|| Object.keys(raw).some(k => k.endsWith("_command") && k !== "qa_start_command" && k !== "qa_build_command" && k !== "worktree_setup_command" && isNonEmpty(raw[k]));
	const hasWorktreeHook = isNonEmpty(raw.worktree_setup_command);
	const hasWorkflowsDir = fs.existsSync(workflowsDir) && fs.statSync(workflowsDir).isDirectory();

	if (!fileExisted && !hasWorkflowsDir) {
		// No project.yaml at all and no workflows dir — nothing to do.
		return { migrated: false };
	}

	// Build the default component named after the project.
	const commands: Record<string, string> = {};
	for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
		const v = raw[legacyKey];
		if (isNonEmpty(v)) commands[newKey] = v.trim();
	}
	// Pass-through: any remaining `*_command` keys we don't recognize get
	// their `_command` suffix stripped and stored under that name. This
	// preserves user-defined extensions to the legacy schema.
	for (const k of Object.keys(raw)) {
		if (!k.endsWith("_command")) continue;
		if (k in LEGACY_KEY_MAP) continue;
		// Skip project-level fields that happen to end in _command.
		if (k === "qa_start_command" || k === "qa_build_command" || k === "worktree_setup_command") continue;
		const v = raw[k];
		if (!isNonEmpty(v)) continue;
		const newKey = k.slice(0, -"_command".length);
		if (newKey && !(newKey in commands)) commands[newKey] = v.trim();
	}

	const component: Record<string, unknown> = {
		name: opts.projectName,
		repo: ".",
	};
	if (hasWorktreeHook) component.worktree_setup_command = (raw.worktree_setup_command as string).trim();
	if (Object.keys(commands).length > 0) component.commands = commands;

	const next: Record<string, unknown> = { ...raw, components: [component] };

	// Strip legacy command keys so the file shape is clean post-migration.
	for (const k of Object.keys(LEGACY_KEY_MAP)) delete next[k];
	for (const k of Object.keys(next)) {
		if (k.endsWith("_command")
			&& k !== "qa_start_command"
			&& k !== "qa_build_command"
			&& k !== "worktree_setup_command") {
			delete next[k];
		}
	}
	// `worktree_setup_command` moved onto the component.
	delete next.worktree_setup_command;

	// Migrate `<configDir>/workflows/*.yaml` files into the inline block.
	let workflowsMigrated = 0;
	let workflowsDirRemoved = false;
	let workflowsSeeded = false;
	const preExistingInlineWorkflows = (raw.workflows && typeof raw.workflows === "object" && !Array.isArray(raw.workflows))
		? { ...(raw.workflows as Record<string, unknown>) }
		: {};
	const inlineWorkflows: Record<string, unknown> = { ...preExistingInlineWorkflows };
	if (hasWorkflowsDir) {
		const entries = fs.readdirSync(workflowsDir);
		for (const entry of entries) {
			if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
			const id = entry.replace(/\.ya?ml$/, "");
			const fp = path.join(workflowsDir, entry);
			try {
				const parsed = yaml.parse(fs.readFileSync(fp, "utf-8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					inlineWorkflows[id] = parsed;
					workflowsMigrated++;
				}
			} catch (err) {
				console.warn(`[migrate] Failed to parse workflow ${fp}:`, err);
			}
		}
		// Remove the workflows directory now that its contents are inlined.
		try {
			fs.rmSync(workflowsDir, { recursive: true, force: true });
			workflowsDirRemoved = true;
		} catch (err) {
			console.warn("[migrate] Failed to remove workflows directory:", err);
		}
	}

	// Seed default workflows if NONE are present (no inline workflows, no project-local dir).
	// After Follow-up A deleted defaults/workflows/*.yaml, projects with no workflow source
	// at all would be left with zero workflows — breaking goal creation entirely.
	if (Object.keys(inlineWorkflows).length === 0) {
		const defaults = buildDefaultWorkflows(opts.projectName);
		for (const [id, wf] of Object.entries(defaults)) inlineWorkflows[id] = wf;
		workflowsSeeded = true;
	}
	if (Object.keys(inlineWorkflows).length > 0) {
		next.workflows = inlineWorkflows;
	}

	// Atomic write.
	try {
		fs.mkdirSync(opts.configDir, { recursive: true });
		const tmp = yamlFile + ".tmp";
		fs.writeFileSync(tmp, yaml.stringify(next), "utf-8");
		fs.renameSync(tmp, yamlFile);
	} catch (err) {
		console.error("[migrate] Failed to write migrated project.yaml:", err);
		return { migrated: false };
	}

	console.log(`[migrate] project.yaml v2: ${opts.projectName}`);
	if (!hasLegacyCommands && !hasWorktreeHook && workflowsMigrated === 0) {
		// Bare-bones write; user will likely need to re-run setup.
		console.warn(`[migrate] project ${opts.projectName} had no legacy commands or workflows; wrote a data-only default component.`);
	}

	return {
		migrated: true,
		componentName: opts.projectName,
		commandKeys: Object.keys(commands),
		workflowsMigrated,
		workflowsDirRemoved,
		workflowsSeeded,
	};
}

/** Secondary pass for projects that already have `components:` set but might be
 *  missing `workflows:` (e.g. a project migrated by an earlier server build,
 *  before default workflows were seeded inline). Strictly idempotent.
 *
 *  Component-name is read from the existing components[0] when available, so
 *  the structural step refs (`{ component, command }`) point at the correct
 *  component even if the user later renamed it. */
function maybeSeedWorkflowsOnly(args: {
	raw: Record<string, unknown>;
	yamlFile: string;
	configDir: string;
	projectName: string;
}): MigrateResult {
	const { raw, yamlFile, configDir, projectName } = args;
	const hasInlineWorkflows = raw.workflows
		&& typeof raw.workflows === "object"
		&& !Array.isArray(raw.workflows)
		&& Object.keys(raw.workflows).length > 0;
	const workflowsDir = path.join(configDir, "workflows");
	const hasWorkflowsDir = fs.existsSync(workflowsDir) && fs.statSync(workflowsDir).isDirectory();

	// If a workflows dir is present, migrate it into the inline block (mirrors the
	// main path so the dir is removed and content is preserved). If neither inline
	// nor dir, seed defaults.
	if (hasInlineWorkflows && !hasWorkflowsDir) {
		return { migrated: false };
	}

	const components = raw.components as Array<Record<string, unknown>> | undefined;
	const componentName = components && components[0] && typeof components[0].name === "string"
		? components[0].name
		: projectName;

	const inlineWorkflows: Record<string, unknown> =
		hasInlineWorkflows ? { ...(raw.workflows as Record<string, unknown>) } : {};

	let workflowsMigrated = 0;
	let workflowsDirRemoved = false;
	if (hasWorkflowsDir) {
		for (const entry of fs.readdirSync(workflowsDir)) {
			if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
			const id = entry.replace(/\.ya?ml$/, "");
			const fp = path.join(workflowsDir, entry);
			try {
				const parsed = yaml.parse(fs.readFileSync(fp, "utf-8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					inlineWorkflows[id] = parsed;
					workflowsMigrated++;
				}
			} catch (err) {
				console.warn(`[migrate] Failed to parse workflow ${fp}:`, err);
			}
		}
		try {
			fs.rmSync(workflowsDir, { recursive: true, force: true });
			workflowsDirRemoved = true;
		} catch (err) {
			console.warn("[migrate] Failed to remove workflows directory:", err);
		}
	}

	let workflowsSeeded = false;
	if (Object.keys(inlineWorkflows).length === 0) {
		const defaults = buildDefaultWorkflows(componentName);
		for (const [id, wf] of Object.entries(defaults)) inlineWorkflows[id] = wf;
		workflowsSeeded = true;
	}

	if (!workflowsSeeded && workflowsMigrated === 0) {
		// Nothing changed.
		return { migrated: false };
	}

	const next = { ...raw, workflows: inlineWorkflows };
	try {
		fs.mkdirSync(configDir, { recursive: true });
		const tmp = yamlFile + ".tmp";
		fs.writeFileSync(tmp, yaml.stringify(next), "utf-8");
		fs.renameSync(tmp, yamlFile);
	} catch (err) {
		console.error("[migrate] Failed to write seeded project.yaml:", err);
		return { migrated: false };
	}

	if (workflowsSeeded) {
		console.log(`[migrate] project.yaml: seeded default workflows for ${projectName} (component=${componentName})`);
	}
	if (workflowsMigrated > 0) {
		console.log(`[migrate] project.yaml: inlined ${workflowsMigrated} workflow files for ${projectName}`);
	}

	return {
		migrated: true,
		componentName,
		workflowsMigrated,
		workflowsDirRemoved,
		workflowsSeeded,
	};
}

/** Run the migration for every registered project. Idempotent across calls. */
export function migrateAllProjects(
	projects: Array<{ id: string; name: string; rootPath: string }>,
): void {
	for (const p of projects) {
		const configDir = path.join(p.rootPath, ".bobbit", "config");
		// If the project's rootPath doesn't exist (provisional, scaffolding) skip.
		if (!fs.existsSync(p.rootPath)) continue;
		try {
			migrateProjectYaml({ configDir, projectName: p.name });
		} catch (err) {
			console.error(`[migrate] project ${p.name} (${p.id}) failed:`, err);
		}
	}
}
