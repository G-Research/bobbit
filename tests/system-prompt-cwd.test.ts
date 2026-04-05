import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleSystemPrompt, getPromptSections, initPromptDirs, type PromptParts } from "../src/server/agent/system-prompt.js";

describe("system prompt working directory section", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-cwd-test-"));
		initPromptDirs(tmpDir);
		// Create a minimal cwd directory (no AGENTS.md needed)
		fs.mkdirSync(path.join(tmpDir, "cwd"), { recursive: true });
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeParts(overrides: Partial<PromptParts> = {}): PromptParts {
		return { cwd: path.join(tmpDir, "cwd"), ...overrides };
	}

	describe("assembleSystemPrompt", () => {
		it("includes Working Directory section with Linux path", () => {
			const promptPath = assembleSystemPrompt("test-linux", makeParts({
				cwd: "/workspace-wt/my-branch",
			}));
			assert.ok(promptPath, "should return a prompt file path");
			const content = fs.readFileSync(promptPath, "utf-8");
			assert.ok(content.includes("# Working Directory"), "should contain Working Directory heading");
			assert.ok(content.includes("`/workspace-wt/my-branch`"), "should contain the Linux path");
			assert.ok(content.includes("Stay in this directory"), "should contain stay instruction");
		});

		it("includes Working Directory section with Windows path", () => {
			const promptPath = assembleSystemPrompt("test-windows", makeParts({
				cwd: "C:\\Users\\dev\\bobbit-wt-session\\abc123",
			}));
			assert.ok(promptPath, "should return a prompt file path");
			const content = fs.readFileSync(promptPath, "utf-8");
			assert.ok(content.includes("# Working Directory"), "should contain Working Directory heading");
			assert.ok(content.includes("`C:\\Users\\dev\\bobbit-wt-session\\abc123`"), "should contain the Windows path");
		});

		it("places Working Directory between Project Context and Goal", () => {
			// Create a directory with AGENTS.md
			const cwdWithAgents = path.join(tmpDir, "cwd-agents");
			fs.mkdirSync(cwdWithAgents, { recursive: true });
			fs.writeFileSync(path.join(cwdWithAgents, "AGENTS.md"), "# Agent Guide\nSome instructions.");

			const promptPath = assembleSystemPrompt("test-order", makeParts({
				cwd: cwdWithAgents,
				goalTitle: "Test Goal",
				goalState: "in-progress",
				goalSpec: "Do the thing.",
			}));
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath, "utf-8");

			const projectIdx = content.indexOf("# Project Context");
			const cwdIdx = content.indexOf("# Working Directory");
			const goalIdx = content.indexOf("# Goal");

			assert.ok(projectIdx >= 0, "should have Project Context section");
			assert.ok(cwdIdx >= 0, "should have Working Directory section");
			assert.ok(goalIdx >= 0, "should have Goal section");
			assert.ok(projectIdx < cwdIdx, "Project Context should come before Working Directory");
			assert.ok(cwdIdx < goalIdx, "Working Directory should come before Goal");
		});

		it("omits Working Directory when cwd is empty string", () => {
			const promptPath = assembleSystemPrompt("test-empty", makeParts({
				cwd: "",
				goalSpec: "Some goal so prompt is non-empty.",
			}));
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath, "utf-8");
			assert.ok(!content.includes("# Working Directory"), "should not contain Working Directory when cwd is empty");
		});
	});

	describe("getPromptSections", () => {
		it("returns Working Directory section with correct label", () => {
			const sections = getPromptSections(makeParts({
				cwd: "/workspace-wt/goal-branch",
			}));
			const cwdSection = sections.find(s => s.label === "Working Directory");
			assert.ok(cwdSection, "should have a Working Directory section");
			assert.ok(cwdSection.content.includes("`/workspace-wt/goal-branch`"), "should contain the path");
			assert.strictEqual(cwdSection.source, "/workspace-wt/goal-branch", "source should be the cwd path");
			assert.ok(cwdSection.tokens > 0, "should have positive token count");
		});

		it("omits Working Directory when cwd is empty", () => {
			const sections = getPromptSections(makeParts({
				cwd: "",
				goalSpec: "placeholder",
			}));
			const cwdSection = sections.find(s => s.label === "Working Directory");
			assert.ok(!cwdSection, "should not have Working Directory section when cwd is empty");
		});

		it("places Working Directory between Project Context and Goal", () => {
			const cwdWithAgents = path.join(tmpDir, "cwd-agents2");
			fs.mkdirSync(cwdWithAgents, { recursive: true });
			fs.writeFileSync(path.join(cwdWithAgents, "AGENTS.md"), "# Guide\nInstructions.");

			const sections = getPromptSections(makeParts({
				cwd: cwdWithAgents,
				goalTitle: "Test",
				goalSpec: "Do it.",
			}));

			const labels = sections.map(s => s.label);
			const projectIdx = labels.indexOf("Project Context");
			const cwdIdx = labels.indexOf("Working Directory");
			const goalIdx = labels.indexOf("Goal");

			assert.ok(projectIdx >= 0, "should have Project Context");
			assert.ok(cwdIdx >= 0, "should have Working Directory");
			assert.ok(goalIdx >= 0, "should have Goal");
			assert.ok(projectIdx < cwdIdx, "Project Context before Working Directory");
			assert.ok(cwdIdx < goalIdx, "Working Directory before Goal");
		});
	});
});
