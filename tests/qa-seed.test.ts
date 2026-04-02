/**
 * Unit tests for scripts/qa-seed/seed.mjs
 *
 * Runs the seed script against a temp directory and validates:
 * - All expected files are created
 * - JSON files parse correctly
 * - JSONL files use correct pi-ai format
 * - Referential integrity across state files
 * - agentSessionFile paths are absolute and point to existing files
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SEED_SCRIPT = path.resolve(
	import.meta.dirname,
	"..",
	"scripts",
	"qa-seed",
	"seed.mjs",
);

let tmpDir: string;
let stateDir: string;
let configDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-seed-test-"));
	execFileSync("node", [SEED_SCRIPT, tmpDir], { stdio: "pipe" });
	stateDir = path.join(tmpDir, ".bobbit", "state");
	configDir = path.join(tmpDir, ".bobbit", "config");
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper: read JSON file ──────────────────────────────────────────
function readJSON(filename: string): any {
	return JSON.parse(fs.readFileSync(path.join(stateDir, filename), "utf-8"));
}

function readJSONL(filePath: string): any[] {
	const content = fs.readFileSync(filePath, "utf-8").trim();
	return content.split("\n").map((line) => JSON.parse(line));
}

// ── File existence ──────────────────────────────────────────────────
describe("qa-seed: file creation", () => {
	const expectedStateFiles = [
		"sessions.json",
		"goals.json",
		"gates.json",
		"tasks.json",
		"team-state.json",
		"projects.json",
	];

	for (const file of expectedStateFiles) {
		it(`creates ${file}`, () => {
			assert.ok(
				fs.existsSync(path.join(stateDir, file)),
				`${file} should exist in state dir`,
			);
		});
	}

	it("creates messages/coder.jsonl", () => {
		assert.ok(
			fs.existsSync(path.join(stateDir, "messages", "coder.jsonl")),
			"coder.jsonl should exist",
		);
	});

	it("creates messages/reviewer.jsonl", () => {
		assert.ok(
			fs.existsSync(path.join(stateDir, "messages", "reviewer.jsonl")),
			"reviewer.jsonl should exist",
		);
	});

	it("creates config/project.yaml", () => {
		assert.ok(
			fs.existsSync(path.join(configDir, "project.yaml")),
			"project.yaml should exist in config dir",
		);
	});
});

// ── JSON validity ───────────────────────────────────────────────────
describe("qa-seed: JSON validity", () => {
	const jsonFiles = [
		"sessions.json",
		"goals.json",
		"gates.json",
		"tasks.json",
		"team-state.json",
		"projects.json",
	];

	for (const file of jsonFiles) {
		it(`${file} is valid JSON`, () => {
			const data = readJSON(file);
			assert.ok(Array.isArray(data), `${file} should contain a JSON array`);
		});
	}
});

// ── JSONL validity ──────────────────────────────────────────────────
describe("qa-seed: JSONL validity", () => {
	it("coder.jsonl — each line is valid JSON", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "coder.jsonl"));
		assert.ok(lines.length > 0, "coder.jsonl should have lines");
		for (const entry of lines) {
			assert.equal(entry.type, "message", "each line should have type: message");
			assert.ok(entry.message, "each line should have a message field");
			assert.ok(entry.message.role, "each message should have a role");
		}
	});

	it("reviewer.jsonl — each line is valid JSON", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "reviewer.jsonl"));
		assert.ok(lines.length > 0, "reviewer.jsonl should have lines");
		for (const entry of lines) {
			assert.equal(entry.type, "message");
			assert.ok(entry.message);
			assert.ok(entry.message.role);
		}
	});
});

// ── JSONL pi-ai format ──────────────────────────────────────────────
describe("qa-seed: JSONL pi-ai format", () => {
	it("assistant messages have content as array", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "coder.jsonl"));
		const assistantMsgs = lines
			.map((l) => l.message)
			.filter((m) => m.role === "assistant");
		assert.ok(assistantMsgs.length > 0, "should have assistant messages");
		for (const msg of assistantMsgs) {
			assert.ok(
				Array.isArray(msg.content),
				`assistant content should be array, got ${typeof msg.content}`,
			);
		}
	});

	it("tool calls use type: toolCall with arguments (not tool_use/input)", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "coder.jsonl"));
		const assistantMsgs = lines
			.map((l) => l.message)
			.filter((m) => m.role === "assistant");
		const toolCalls = assistantMsgs.flatMap((m) =>
			(m.content as any[]).filter((c: any) => c.type === "toolCall"),
		);
		assert.ok(toolCalls.length > 0, "should have tool calls");
		for (const tc of toolCalls) {
			assert.equal(tc.type, "toolCall", "type should be toolCall, not tool_use");
			assert.ok(tc.id, "tool call should have an id");
			assert.ok(tc.name, "tool call should have a name");
			assert.ok(
				tc.arguments !== undefined,
				"tool call should use 'arguments', not 'input'",
			);
			assert.equal(tc.input, undefined, "tool call should NOT have 'input'");
		}
	});

	it("tool results have top-level toolCallId, toolName, isError", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "coder.jsonl"));
		const toolResults = lines
			.map((l) => l.message)
			.filter((m) => m.role === "toolResult");
		assert.ok(toolResults.length > 0, "should have tool result messages");
		for (const tr of toolResults) {
			assert.ok(tr.toolCallId, "toolResult should have top-level toolCallId");
			assert.ok(tr.toolName, "toolResult should have top-level toolName");
			assert.equal(
				typeof tr.isError,
				"boolean",
				"toolResult should have isError as boolean",
			);
			assert.ok(
				Array.isArray(tr.content),
				"toolResult content should be an array",
			);
			assert.ok(
				typeof tr.timestamp === "number",
				"toolResult should have a timestamp",
			);
		}
	});

	it("assistant messages have required metadata fields", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "coder.jsonl"));
		const assistantMsgs = lines
			.map((l) => l.message)
			.filter((m) => m.role === "assistant");
		for (const msg of assistantMsgs) {
			assert.ok(msg.api, "assistant message should have api field");
			assert.ok(msg.provider, "assistant message should have provider field");
			assert.ok(msg.model, "assistant message should have model field");
			assert.ok(msg.usage, "assistant message should have usage field");
			assert.ok(
				typeof msg.usage.input === "number",
				"usage.input should be a number",
			);
			assert.ok(
				typeof msg.usage.output === "number",
				"usage.output should be a number",
			);
			assert.ok(msg.stopReason, "assistant message should have stopReason");
			assert.ok(
				typeof msg.timestamp === "number",
				"assistant message should have timestamp",
			);
		}
	});

	it("reviewer JSONL contains verification_result tool call", () => {
		const lines = readJSONL(path.join(stateDir, "messages", "reviewer.jsonl"));
		const assistantMsgs = lines
			.map((l) => l.message)
			.filter((m) => m.role === "assistant");
		const vrCalls = assistantMsgs.flatMap((m) =>
			(m.content as any[]).filter(
				(c: any) => c.type === "toolCall" && c.name === "verification_result",
			),
		);
		assert.ok(
			vrCalls.length > 0,
			"reviewer should have a verification_result tool call",
		);
		const vr = vrCalls[0];
		assert.ok(vr.arguments.verdict, "verification_result should have verdict");
		assert.ok(vr.arguments.summary, "verification_result should have summary");
	});

	it("user messages have timestamp", () => {
		const allLines = [
			...readJSONL(path.join(stateDir, "messages", "coder.jsonl")),
			...readJSONL(path.join(stateDir, "messages", "reviewer.jsonl")),
		];
		const userMsgs = allLines
			.map((l) => l.message)
			.filter((m) => m.role === "user");
		assert.ok(userMsgs.length > 0, "should have user messages");
		for (const msg of userMsgs) {
			assert.ok(
				typeof msg.timestamp === "number",
				"user message should have a numeric timestamp",
			);
		}
	});
});

// ── Referential integrity ───────────────────────────────────────────
describe("qa-seed: referential integrity", () => {
	it("task assignedSessionId values match session IDs", () => {
		const sessions = readJSON("sessions.json");
		const tasks = readJSON("tasks.json");
		const sessionIds = new Set(sessions.map((s: any) => s.id));
		for (const task of tasks) {
			if (task.assignedSessionId) {
				assert.ok(
					sessionIds.has(task.assignedSessionId),
					`task ${task.id} assignedSessionId ${task.assignedSessionId} not found in sessions`,
				);
			}
		}
	});

	it("gate goalIds match goals.json", () => {
		const goals = readJSON("goals.json");
		const gates = readJSON("gates.json");
		const goalIds = new Set(goals.map((g: any) => g.id));
		for (const gate of gates) {
			assert.ok(
				goalIds.has(gate.goalId),
				`gate ${gate.gateId} goalId ${gate.goalId} not found in goals`,
			);
		}
	});

	it("task goalIds match goals.json", () => {
		const goals = readJSON("goals.json");
		const tasks = readJSON("tasks.json");
		const goalIds = new Set(goals.map((g: any) => g.id));
		for (const task of tasks) {
			assert.ok(
				goalIds.has(task.goalId),
				`task ${task.id} goalId ${task.goalId} not found in goals`,
			);
		}
	});

	it("projectId on goal matches projects.json", () => {
		const projects = readJSON("projects.json");
		const goals = readJSON("goals.json");
		const projectIds = new Set(projects.map((p: any) => p.id));
		for (const goal of goals) {
			if (goal.projectId) {
				assert.ok(
					projectIds.has(goal.projectId),
					`goal projectId ${goal.projectId} not found in projects`,
				);
			}
		}
	});

	it("projectId on sessions matches projects.json", () => {
		const projects = readJSON("projects.json");
		const sessions = readJSON("sessions.json");
		const projectIds = new Set(projects.map((p: any) => p.id));
		for (const session of sessions) {
			if (session.projectId) {
				assert.ok(
					projectIds.has(session.projectId),
					`session ${session.id} projectId ${session.projectId} not found in projects`,
				);
			}
		}
	});

	it("team agent sessionIds match sessions.json", () => {
		const sessions = readJSON("sessions.json");
		const teamState = readJSON("team-state.json");
		const sessionIds = new Set(sessions.map((s: any) => s.id));
		for (const team of teamState) {
			for (const agent of team.agents) {
				assert.ok(
					sessionIds.has(agent.sessionId),
					`team agent sessionId ${agent.sessionId} not found in sessions`,
				);
			}
		}
	});

	it("team goalId matches goals.json", () => {
		const goals = readJSON("goals.json");
		const teamState = readJSON("team-state.json");
		const goalIds = new Set(goals.map((g: any) => g.id));
		for (const team of teamState) {
			assert.ok(
				goalIds.has(team.goalId),
				`team goalId ${team.goalId} not found in goals`,
			);
		}
	});
});

// ── agentSessionFile paths ──────────────────────────────────────────
describe("qa-seed: agentSessionFile paths", () => {
	it("agentSessionFile paths are absolute", () => {
		const sessions = readJSON("sessions.json");
		for (const session of sessions) {
			if (session.agentSessionFile && session.agentSessionFile !== "") {
				// On Windows, absolute paths start with drive letter; on Unix with /
				const isAbsolute =
					path.isAbsolute(session.agentSessionFile);
				assert.ok(
					isAbsolute,
					`agentSessionFile for ${session.id} should be absolute: ${session.agentSessionFile}`,
				);
			}
		}
	});

	it("agentSessionFile paths point to existing files", () => {
		const sessions = readJSON("sessions.json");
		for (const session of sessions) {
			if (session.agentSessionFile && session.agentSessionFile !== "") {
				assert.ok(
					fs.existsSync(session.agentSessionFile),
					`agentSessionFile for ${session.id} should exist: ${session.agentSessionFile}`,
				);
			}
		}
	});
});

// ── Data shape ──────────────────────────────────────────────────────
describe("qa-seed: data shape", () => {
	it("produces exactly 1 project", () => {
		const projects = readJSON("projects.json");
		assert.equal(projects.length, 1);
		assert.ok(projects[0].id);
		assert.ok(projects[0].name);
		assert.ok(projects[0].rootPath);
	});

	it("produces exactly 1 goal in in-progress state with workflow", () => {
		const goals = readJSON("goals.json");
		assert.equal(goals.length, 1);
		assert.equal(goals[0].state, "in-progress");
		assert.ok(goals[0].workflow, "goal should have frozen workflow");
		assert.ok(goals[0].workflowId, "goal should have workflowId");
	});

	it("produces exactly 3 sessions, all archived", () => {
		const sessions = readJSON("sessions.json");
		assert.equal(sessions.length, 3);
		for (const s of sessions) {
			assert.equal(s.archived, true, `session ${s.id} should be archived`);
		}
	});

	it("produces 4 gates with correct statuses", () => {
		const gates = readJSON("gates.json");
		assert.equal(gates.length, 4);
		const byId = Object.fromEntries(gates.map((g: any) => [g.gateId, g]));
		assert.equal(byId["design-doc"].status, "passed");
		assert.equal(byId["implementation"].status, "passed");
		assert.equal(byId["documentation"].status, "pending");
		assert.equal(byId["ready-to-merge"].status, "pending");
	});

	it("produces exactly 3 tasks, all complete", () => {
		const tasks = readJSON("tasks.json");
		assert.equal(tasks.length, 3);
		for (const t of tasks) {
			assert.equal(t.state, "complete", `task ${t.id} should be complete`);
		}
	});

	it("team-state has 2 agents", () => {
		const teamState = readJSON("team-state.json");
		assert.equal(teamState.length, 1);
		assert.equal(teamState[0].agents.length, 2);
	});
});
