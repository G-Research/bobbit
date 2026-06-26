import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ProjectSandbox, getAgentDirMountStaleness } from "../src/server/agent/project-sandbox.js";

type Call = string | [string, string];

function mount(source: string, destination: string, rw = true, mode = ""): { Source: string; Destination: string; RW: boolean; Mode: string } {
	return { Source: source, Destination: destination, RW: rw, Mode: mode };
}

function makeSandbox(): ProjectSandbox {
	return new ProjectSandbox({
		projectId: "stale-agent-dir-mounts",
		projectDir: path.join(process.cwd(), "tmp-project"),
		repoUrl: "https://example.test/repo.git",
		image: "bobbit-test-image:latest",
	});
}

describe("ProjectSandbox agent-dir mount staleness", () => {
	it("accepts mounts that match the active agent sessions dir and read-only models.json", () => {
		const expected = {
			sessionsDir: path.resolve("/agent-b/sessions"),
			modelsJson: path.resolve("/agent-b/models.json"),
			modelsJsonExists: true,
		};

		const result = getAgentDirMountStaleness([
			mount(expected.sessionsDir, "/home/node/.bobbit/agent/sessions"),
			mount(expected.modelsJson, "/home/node/.bobbit/agent/models.json", false, "ro"),
		], expected);

		assert.equal(result.stale, false, result.reason);
	});

	it("marks containers stale when sessions or models mounts point at a previous agent dir", () => {
		const expected = {
			sessionsDir: path.resolve("/agent-b/sessions"),
			modelsJson: path.resolve("/agent-b/models.json"),
			modelsJsonExists: true,
		};

		const sessionsStale = getAgentDirMountStaleness([
			mount(path.resolve("/agent-a/sessions"), "/home/node/.bobbit/agent/sessions"),
			mount(expected.modelsJson, "/home/node/.bobbit/agent/models.json", false, "ro"),
		], expected);
		assert.equal(sessionsStale.stale, true);
		assert.match(sessionsStale.reason ?? "", /sessions mount/i);

		const modelsStale = getAgentDirMountStaleness([
			mount(expected.sessionsDir, "/home/node/.bobbit/agent/sessions"),
			mount(path.resolve("/agent-a/models.json"), "/home/node/.bobbit/agent/models.json", false, "ro"),
		], expected);
		assert.equal(modelsStale.stale, true);
		assert.match(modelsStale.reason ?? "", /models\.json mount/i);
	});

	it("marks containers stale when the active agent dir has no models.json but the container still mounts one", () => {
		const expected = {
			sessionsDir: path.resolve("/agent-b/sessions"),
			modelsJson: path.resolve("/agent-b/models.json"),
			modelsJsonExists: false,
		};

		const result = getAgentDirMountStaleness([
			mount(expected.sessionsDir, "/home/node/.bobbit/agent/sessions"),
			mount(path.resolve("/agent-a/models.json"), "/home/node/.bobbit/agent/models.json", false, "ro"),
		], expected);

		assert.equal(result.stale, true);
		assert.match(result.reason ?? "", /still has an agent models\.json mount/i);
	});

	it("recreates an existing project container before reconnecting when agent-dir mounts are stale", async () => {
		const sandbox = makeSandbox();
		const calls: Call[] = [];
		(sandbox as any)._findContainerByLabel = async () => "old-container-id";
		(sandbox as any)._hasStaleAgentDirMounts = async () => true;
		(sandbox as any)._isContainerImageStale = async () => { throw new Error("must not inspect image after stale mount"); };
		(sandbox as any)._isContainerRunning = async () => { throw new Error("must not reconnect stale container"); };
		(sandbox as any)._removeContainer = async (containerId: string) => { calls.push(["remove", containerId]); };
		(sandbox as any)._createContainer = async () => { calls.push("create"); (sandbox as any).containerId = "new-container-id"; };
		(sandbox as any)._runInitSequence = async () => { calls.push("init"); };

		await (sandbox as any)._initContainer();

		assert.deepEqual(calls, [["remove", "old-container-id"], "create", "init"]);
		assert.equal((sandbox as any).containerId, "new-container-id");
	});
});
