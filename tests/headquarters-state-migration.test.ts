import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { migrateToPerProjectState } = await import("../src/server/agent/state-migration.ts");
const {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	ProjectRegistry,
} = await import("../src/server/agent/project-registry.ts");

function tmpRoot(prefix = "bobbit-hq-migration-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T = any>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function seedProject(stateDir: string, project: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): void {
	writeJson(path.join(stateDir, "projects.json"), [project, ...extra]);
}

function hqProject(rootPath: string): Record<string, unknown> {
	return {
		id: HEADQUARTERS_PROJECT_ID,
		name: HEADQUARTERS_PROJECT_NAME,
		kind: "headquarters",
		rootPath,
		createdAt: 1,
		colorLight: "#fff",
		colorDark: "#000",
	};
}

describe("Headquarters state migration aliasing", () => {
	it("keeps central state in place for Headquarters and backfills project ids", () => {
		const root = tmpRoot();
		const stateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		seedProject(stateDir, hqProject(root));
		writeJson(path.join(stateDir, "goals.json"), [{ id: "g1", title: "G", cwd: root, state: "todo", spec: "", createdAt: 1, updatedAt: 1 }]);
		writeJson(path.join(stateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: root, agentSessionFile: "a.jsonl", createdAt: 1, lastActivity: 1 }]);
		writeJson(path.join(stateDir, "staff.json"), [{ id: "st1", name: "Staff", description: "", systemPrompt: "", cwd: root, state: "active", triggers: [], memory: "", accessory: "none", createdAt: 1, updatedAt: 1, sandboxed: false }]);

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), root);

		assert.equal(fs.existsSync(path.join(stateDir, ".migrated-to-per-project")), true);
		assert.equal(fs.existsSync(path.join(stateDir, "goals.json.pre-migration")), false, "central HQ state must not be renamed away from itself");
		assert.equal(readJson(path.join(stateDir, "goals.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(readJson(path.join(stateDir, "sessions.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(readJson(path.join(stateDir, "staff.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
	});

	it("uses the server state directory for Headquarters when it is redirected away from the server root", () => {
		const serverRoot = tmpRoot();
		const redirected = tmpRoot("bobbit-hq-redirected-state-");
		const stateDir = path.join(redirected, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		seedProject(stateDir, hqProject(serverRoot));
		writeJson(path.join(stateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: serverRoot, agentSessionFile: "a.jsonl", createdAt: 1, lastActivity: 1 }]);

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), serverRoot);

		assert.equal(readJson(path.join(stateDir, "sessions.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(
			fs.existsSync(path.join(serverRoot, ".bobbit", "state", "sessions.json")),
			false,
			"Headquarters migration must not duplicate redirected server state under <root>/.bobbit/state",
		);
	});

	it("promotes an existing server-root project id to Headquarters and rewrites structured references", () => {
		const root = tmpRoot();
		const stateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const oldId = "server-root-project";
		seedProject(stateDir, {
			id: oldId,
			name: "Old Server Root",
			rootPath: root,
			createdAt: 1,
			position: 0,
			colorLight: "#fff",
			colorDark: "#000",
		}, [{
			id: "child",
			name: "Child",
			rootPath: path.join(root, "child"),
			createdAt: 2,
			parentProjectId: oldId,
			colorLight: "#fff",
			colorDark: "#000",
		}]);
		writeJson(path.join(stateDir, "goals.json"), [{ id: "g1", title: "G", cwd: root, state: "todo", spec: "", projectId: oldId, createdAt: 1, updatedAt: 1 }]);
		writeJson(path.join(stateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: root, agentSessionFile: "a.jsonl", projectId: oldId, createdAt: 1, lastActivity: 1, provisionalProjectId: oldId }]);
		writeJson(path.join(stateDir, "staff.json"), [{ id: "st1", name: "Staff", description: "", systemPrompt: "", cwd: root, state: "active", triggers: [], memory: "", accessory: "none", projectId: oldId, createdAt: 1, updatedAt: 1, sandboxed: false }]);
		writeJson(path.join(stateDir, "sidecar.json"), { nested: { projectId: oldId } });
		fs.mkdirSync(path.join(stateDir, "search.flex"), { recursive: true });

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), root);

		const projects = readJson<Array<Record<string, unknown>>>(path.join(stateDir, "projects.json"));
		assert.equal(projects.some(p => p.id === oldId), false);
		const hq = projects.find(p => p.id === HEADQUARTERS_PROJECT_ID)!;
		assert.equal(hq.name, HEADQUARTERS_PROJECT_NAME);
		assert.equal(hq.kind, "headquarters");
		assert.equal(hq.position, undefined);
		assert.equal(projects.find(p => p.id === "child")?.parentProjectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(readJson(path.join(stateDir, "goals.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		const session = readJson(path.join(stateDir, "sessions.json"))[0];
		assert.equal(session.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(session.provisionalProjectId, undefined);
		assert.equal(readJson(path.join(stateDir, "staff.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(readJson(path.join(stateDir, "sidecar.json")).nested.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(fs.existsSync(path.join(stateDir, "projects.json.pre-headquarters-id-migration")), true);
		assert.equal(fs.existsSync(path.join(stateDir, ".headquarters-project-id-migrated")), true);
		assert.equal(fs.existsSync(path.join(stateDir, "search.flex")), false, "search indexes should be dropped for rebuild after project id rewrite");
		assert.equal(fs.existsSync(path.join(stateDir, "search.flex.pre-headquarters-id-migration")), true);
		assert.equal(JSON.stringify(projects).includes(oldId), false);
	});

	it("runs server-root id promotion even when the older per-project marker already exists", () => {
		const root = tmpRoot();
		const stateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const oldId = "already-migrated-root";
		seedProject(stateDir, {
			id: oldId,
			name: "Old Server Root",
			rootPath: root,
			createdAt: 1,
			colorLight: "#fff",
			colorDark: "#000",
		});
		writeJson(path.join(stateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: root, agentSessionFile: "a.jsonl", projectId: oldId, createdAt: 1, lastActivity: 1 }]);
		fs.writeFileSync(path.join(stateDir, ".migrated-to-per-project"), "old", "utf-8");

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), root);

		const projects = readJson<Array<Record<string, unknown>>>(path.join(stateDir, "projects.json"));
		assert.equal(projects.some(p => p.id === oldId), false);
		assert.equal(projects.some(p => p.id === HEADQUARTERS_PROJECT_ID), true);
		assert.equal(readJson(path.join(stateDir, "sessions.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
	});
});
