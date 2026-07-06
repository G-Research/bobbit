import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PROMPT_PLUMBING = fs.readFileSync(
	path.join(process.cwd(), "src/server/agent/session-prompt-plumbing.ts"),
	"utf-8",
);
const SESSION_MANAGER = fs.readFileSync(
	path.join(process.cwd(), "src/server/agent/session-manager.ts"),
	"utf-8",
);

function classMethodWindow(source: string, className: string, marker: string, size = 5_000): string {
	const classStart = source.indexOf(`export class ${className}`);
	assert.ok(classStart >= 0, `${className} must exist`);
	const start = source.indexOf(marker, classStart);
	assert.ok(start >= 0, `${marker} must exist`);
	return source.slice(start, start + size);
}

function promptMethod(marker: string): string {
	return classMethodWindow(PROMPT_PLUMBING, "SessionPromptPlumbing", marker);
}

describe("SessionPromptPlumbing source shape", () => {
	it("keeps moved narrow-delegate helper comments and implementation in the prompt module", () => {
		assert.match(PROMPT_PLUMBING, /F22 \(RECONCILIATION-2026-07-05\.md NEXT QUEUE item 5\)/);
		assert.match(PROMPT_PLUMBING, /NOT the same axis as `read-only-tool-policy\.ts`'s `isReadOnlyToolPolicy`/);
		assert.match(PROMPT_PLUMBING, /const NARROW_WORKER_TOOLS: ReadonlySet<string> = new Set/);
		assert.match(PROMPT_PLUMBING, /return allowedTools\.every\(t => NARROW_WORKER_TOOLS\.has\(t\.toLowerCase\(\)\)\);/);
		assert.match(SESSION_MANAGER, /export \{ isNarrowDelegateAllowedTools \} from "\.\/session-prompt-plumbing\.js";/);
	});

	it("keeps workflow, role, and goal-metadata activation helpers with attached comments", () => {
		assert.match(PROMPT_PLUMBING, /Build a markdown list of available workflows/);
		assert.match(promptMethod("_buildWorkflowList(projectId?: string): string"), /resolveWorkflows\(projectId\)\.map\(r => r\.item\)/);
		assert.match(promptMethod("_buildWorkflowList(projectId?: string): string"), /This project has no workflows configured/);

		assert.match(PROMPT_PLUMBING, /Resolve the effective allowed tools for a role/);
		assert.match(promptMethod("resolveEffectiveAllowedTools(role:"), /computeEffectiveAllowedTools\(this\.toolManager, role, this\.groupPolicyStore/);

		assert.match(promptMethod("mergeToolNames(existing:"), /const seen = new Set<string>\(\);/);
		assert.match(promptMethod("mergeToolNames(existing:"), /return merged\.length > 0 \? merged : undefined;/);

		assert.match(PROMPT_PLUMBING, /Resolve a session's effective \(ancestry-merged\) goal metadata/);
		assert.match(promptMethod("resolveEffectiveGoalMetadataForSession(goalId:"), /getContextForGoal\(goalId\)/);
		assert.match(promptMethod("resolveEffectiveGoalMetadataForSession(goalId:"), /getTestGoalManager\(\)!\.getEffectiveGoalMetadata\(goalId\)/);

		assert.match(PROMPT_PLUMBING, /OUTSIDE the GoalManager \/ session-setup provisioning paths/);
		assert.match(promptMethod("dispatchGoalProvisionedForWorktree(opts:"), /const metadata = this\.resolveEffectiveGoalMetadataForSession/);
		assert.match(promptMethod("dispatchGoalProvisionedForWorktree(opts:"), /dispatchGoalProvisioned\(\{/);
	});

	it("keeps disabled-tools, prompt-order, and tool-activation behavior/comments in the prompt module", () => {
		assert.match(PROMPT_PLUMBING, /Lower-cased set of tool names disabled/);
		assert.match(promptMethod("disabledToolsForGoal(goalId:"), /\["bobbit\.disabledTools"\]/);
		assert.match(promptMethod("disabledToolsForGoal(goalId:"), /map\(s => s\.toLowerCase\(\)\)/);

		assert.match(PROMPT_PLUMBING, /Prompt section order from the `bobbit\.promptSectionOrder` metadata/);
		assert.match(promptMethod("promptSectionOrderForGoal(goalId:"), /\["bobbit\.promptSectionOrder"\]/);
		assert.match(PROMPT_PLUMBING, /without[\s\S]*custom order silently reverts/);

		assert.match(promptMethod("buildToolActivationArgs("), /Goal-metadata disabled tools \(bobbit\.disabledTools\)/);
		assert.match(promptMethod("buildToolActivationArgs("), /writeMcpProxyExtensions\(mcpManager, flatNames, role/);
		assert.match(promptMethod("buildToolActivationArgs("), /prependToolResultErrorBridge\(\[\.\.\.activation\.args, \.\.\.piExtensionActivation\.args\]\)/);
		assert.match(promptMethod("buildToolActivationArgs("), /Provider-bridge extension \(per-turn beforePrompt \/ beforeCompact hooks\)/);
		assert.match(promptMethod("buildToolActivationArgs("), /writeGoogleCodeAssistProviderExtension\(sessionId\)/);
	});

	it("keeps prompt assembly, skills catalog, delegate prompt, and prompt-parts reconstruction bodies/comments", () => {
		assert.match(promptMethod("resolveSessionRole(roleName?:"), /Cascade-first: pack-shipped roles/);
		assert.match(promptMethod("resolveSessionRole(roleName?:"), /resolveRoles\(projectId\)\.find\(r => r\.item\.name === name\)/);

		assert.match(PROMPT_PLUMBING, /Generate tool docs and inject into prompt parts before assembly/);
		assert.match(promptMethod("assemblePrompt(sessionId:"), /profile\("sessionManager\.assemblePrompt"/);

		assert.match(promptMethod("_assemblePrompt(sessionId:"), /Skills catalog — progressive disclosure \(level 1\)/);
		assert.match(promptMethod("_assemblePrompt(sessionId:"), /persistPromptSections\(sessionId, parts\)/);
		assert.match(promptMethod("_assemblePrompt(sessionId:"), /assembleSystemPrompt\(sessionId, parts\)/);

		assert.match(promptMethod("projectConfigStoreForPrompt(projectId?:"), /getOrCreate\(projectId\)\?\.projectConfigStore/);

		assert.match(promptMethod("computeSkillsCatalog("), /allowedTools=\[\] \(EXPLICIT no tools/);
		assert.match(promptMethod("computeSkillsCatalog("), /pack-schema-v1 §7: filter disabled market-pack skills/);
		assert.match(promptMethod("computeSkillsCatalog("), /discoverSlashSkills\(discoveryRoot, projectConfigStore, marketContext\)/);

		assert.match(promptMethod("buildDelegateTaskSpec(instructions:"), /taskSpec \+= "\\n\\n## Context";/);
		assert.match(promptMethod("buildDelegateTaskSpec(instructions:"), /Object\.entries\(context\)/);

		assert.match(promptMethod("buildDelegatePromptParts(opts:"), /F22: a PROVABLY narrow delegate/);
		assert.match(promptMethod("buildDelegatePromptParts(opts:"), /const narrow = isNarrowDelegateAllowedTools\(opts\.allowedTools\);/);
		assert.match(promptMethod("buildDelegatePromptParts(opts:"), /promptProfile: narrow \? "narrow-worker" : undefined/);

		assert.match(promptMethod("getPromptParts(sessionId:"), /Delegate task instructions are durable store data/);
		assert.match(promptMethod("getPromptParts(sessionId:"), /assistantGoalSpec = assistantGoalSpec\.replace\('\{\{AVAILABLE_WORKFLOWS\}\}'/);
		assert.match(promptMethod("getPromptParts(sessionId:"), /session\.promptParts = parts;/);
	});

	it("keeps SessionManager same-named wrapper/retention surface for moved methods", () => {
		assert.match(SESSION_MANAGER, /private retainSessionPromptPlumbingHostSurface\(\): void \{/);
		for (const name of [
			"_buildWorkflowList",
			"resolveEffectiveAllowedTools",
			"mergeToolNames",
			"resolveEffectiveGoalMetadataForSession",
			"dispatchGoalProvisionedForWorktree",
			"disabledToolsForGoal",
			"promptSectionOrderForGoal",
			"buildToolActivationArgs",
			"resolveSessionRole",
			"assemblePrompt",
			"_assemblePrompt",
			"projectConfigStoreForPrompt",
			"computeSkillsCatalog",
			"buildDelegateTaskSpec",
			"buildDelegatePromptParts",
			"getPromptParts",
		]) {
			assert.match(SESSION_MANAGER, new RegExp(`void this\\.${name};`));
			assert.match(SESSION_MANAGER, new RegExp(`this\\.sessionPromptPlumbing\\.${name}\\(`));
		}
	});
});
