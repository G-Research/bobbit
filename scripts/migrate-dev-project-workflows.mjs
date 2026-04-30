#!/usr/bin/env node
/**
 * One-shot migration helper for the bobbit dev environment.
 *
 * Phase 2 of multi-repo & components removed `{{project.X}}` substitution
 * (replaced by structural `{ component, command }` step refs). The dev
 * project.yaml at <repoRoot>/.bobbit/config/project.yaml is gitignored
 * runtime state and won't be touched by Phase 1's automatic migration
 * for `{{project.X}}` rewrites.
 *
 * This script:
 *   1. Reads the four built-in workflow YAMLs in defaults/workflows/.
 *   2. Rewrites every `{{project.<key>}}` token in `run:` strings into
 *      a structural `{ component: <name>, command: <key minus _command> }`
 *      step, preserving phase/timeout/expect/etc.
 *   3. Inlines the resulting workflows into the dev project.yaml under
 *      `workflows:`, alongside any pre-existing entries (e.g. pr-review).
 *   4. Adds/preserves `components: [{ name, repo: ".", commands: {...},
 *      worktree_setup_command: ... }]` synthesized from legacy command keys.
 *
 * Idempotent: re-running with `components:` and `workflows:` already present
 * just overwrites the four canonical workflows; pr-review and other
 * user-added flows are preserved.
 *
 * Usage:
 *   node scripts/migrate-dev-project-workflows.mjs <pathToProjectRoot>
 *
 * If no path is given, defaults to the current working directory.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const projectRoot = process.argv[2]
	? path.resolve(process.argv[2])
	: process.cwd();

const projectYaml = path.join(projectRoot, ".bobbit", "config", "project.yaml");
if (!fs.existsSync(projectYaml)) {
	console.error(`No project.yaml at ${projectYaml}`);
	process.exit(1);
}

const raw = yaml.parse(fs.readFileSync(projectYaml, "utf-8"));
if (!raw || typeof raw !== "object") {
	console.error(`Failed to parse ${projectYaml}`);
	process.exit(1);
}

const projectName = path.basename(projectRoot);

// 1. Synthesize components[]
const LEGACY_KEY_MAP = {
	build_command: "build",
	test_command: "test",
	typecheck_command: "check",
	test_unit_command: "unit",
	test_e2e_command: "e2e",
	lint_command: "lint",
	format_command: "format",
};

const commands = {};
for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
	const v = raw[legacyKey];
	if (typeof v === "string" && v.trim()) commands[newKey] = v.trim();
}
// Idempotent rerun: if legacy keys were stripped on a prior run, re-read
// the canonical commands map from the existing first component so step
// rewriting still works.
if (Object.keys(commands).length === 0 && Array.isArray(raw.components)) {
	const c0 = raw.components[0];
	if (c0?.commands && typeof c0.commands === "object") {
		for (const [k, v] of Object.entries(c0.commands)) {
			if (typeof v === "string" && v.trim()) commands[k] = v.trim();
		}
	}
}

const componentName = (Array.isArray(raw.components) && raw.components[0]?.name)
	? raw.components[0].name
	: projectName;

const component = {
	name: componentName,
	repo: ".",
};
if (typeof raw.worktree_setup_command === "string" && raw.worktree_setup_command.trim()) {
	component.worktree_setup_command = raw.worktree_setup_command.trim();
}
if (Object.keys(commands).length > 0) component.commands = commands;

// 2. Rewrite each canonical builtin workflow.
const WORKFLOW_FILES = ["general.yaml", "feature.yaml", "bug-fix.yaml", "quick-fix.yaml"];
const KEY_TO_NAME = Object.fromEntries(Object.entries(LEGACY_KEY_MAP));

function rewriteSteps(steps) {
	if (!Array.isArray(steps)) return steps;
	return steps.map(step => {
		if (step.type !== "command" || typeof step.run !== "string") return step;
		const m = /^\s*\{\{\s*project\.([a-zA-Z0-9_]+)\s*\}\}\s*$/.exec(step.run);
		if (!m) return step;
		const cmdName = KEY_TO_NAME[m[1]];
		if (!cmdName || !commands[cmdName]) return step;
		// Build structural step.
		const out = { ...step };
		delete out.run;
		out.component = componentName;
		out.command = cmdName;
		return out;
	});
}

function rewriteWorkflow(wf) {
	const gates = Array.isArray(wf.gates) ? wf.gates.map(g => ({ ...g, verify: rewriteSteps(g.verify) })) : [];
	return { ...wf, gates };
}

const inlineWorkflows = (raw.workflows && typeof raw.workflows === "object" && !Array.isArray(raw.workflows))
	? { ...raw.workflows }
	: {};

// Pull in any pre-existing per-project workflow YAMLs (e.g. pr-review) so
// they survive the move into the inline block. The Phase 1 migration would
// also do this on first server boot, but we run earlier here.
const legacyDir = path.join(projectRoot, ".bobbit", "config", "workflows");
if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory()) {
	for (const entry of fs.readdirSync(legacyDir)) {
		if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
		const id = entry.replace(/\.ya?ml$/, "");
		try {
			const parsed = yaml.parse(fs.readFileSync(path.join(legacyDir, entry), "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				// Don't override entries we'll overwrite from defaults/ below.
				inlineWorkflows[id] = inlineWorkflows[id] ?? parsed;
			}
		} catch (err) {
			console.warn(`Failed to parse legacy ${entry}:`, err);
		}
	}
}

for (const file of WORKFLOW_FILES) {
	const wfPath = path.join(repoRoot, "defaults", "workflows", file);
	const wf = yaml.parse(fs.readFileSync(wfPath, "utf-8"));
	if (wf?.id) {
		inlineWorkflows[wf.id] = rewriteWorkflow(wf);
	}
}

// 3. Build the next yaml. Strip legacy command keys.
const next = { ...raw };
for (const k of Object.keys(LEGACY_KEY_MAP)) delete next[k];
for (const k of Object.keys(next)) {
	if (k.endsWith("_command") && k !== "qa_start_command" && k !== "qa_build_command" && k !== "worktree_setup_command") {
		delete next[k];
	}
}
delete next.worktree_setup_command;
next.components = [component];
next.workflows = inlineWorkflows;

fs.writeFileSync(projectYaml, yaml.stringify(next), "utf-8");
console.log(`Rewrote ${projectYaml}`);
console.log(`  Component: ${componentName} (${Object.keys(commands).length} commands)`);
console.log(`  Workflows: ${Object.keys(inlineWorkflows).join(", ")}`);
