import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	ensurePrivateSessionRoot,
	sessionStateSessionsRoot,
	sessionTranscriptHostPath,
	sessionTranscriptRoot,
	sessionTranscriptStorageKey,
} from "../../src/server/agent/agent-session-path.ts";
import { buildDockerRunArgs } from "../../src/server/agent/docker-args.ts";
import { getSessionTranscriptMountStaleness } from "../../src/server/agent/project-sandbox.ts";
import { containerPathToHost, toDockerPath } from "../../src/server/agent/rpc-bridge.ts";
import { sessionFileRead, sessionFileWriteAtomic } from "../../src/server/agent/session-fs.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-transcript-roots-"));
const sessionsRoot = path.join(root, "agent", "sessions");
const stateDir = path.join(root, "project", ".bobbit", "state");
const containerFile = "/home/node/.bobbit/agent/sessions/--workspace--/turn.jsonl";

function mount(source: string, destination: string, rw = true, mode = "") {
	return { Type: "bind", Source: source, Destination: destination, RW: rw, Mode: mode };
}

function volumeSources(args: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) if (args[i] === "-v") result.push(args[i + 1]);
	return result;
}

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
	for (const id of ["owner-a", "owner-b"]) fs.rmSync(sessionTranscriptRoot(id), { recursive: true, force: true });
});

describe("deterministic session transcript roots", () => {
	it("derives stable filename-inert roots and translates the same Pi coordinate by owner", () => {
		expect(sessionTranscriptStorageKey("owner-a")).toMatch(/^[a-f0-9]{64}$/);
		expect(sessionTranscriptStorageKey("owner-a")).toBe(sessionTranscriptStorageKey("owner-a"));
		expect(sessionTranscriptStorageKey("owner-a")).not.toBe(sessionTranscriptStorageKey("owner-b"));
		const a = sessionTranscriptHostPath("owner-a", containerFile, sessionsRoot);
		const b = sessionTranscriptHostPath("owner-b", containerFile, sessionsRoot);
		expect(a).not.toBe(b);
		expect(a).toBe(path.join(sessionTranscriptRoot("owner-a", sessionsRoot), "--workspace--", "turn.jsonl"));
		expect(sessionTranscriptHostPath("owner-a", "/bobbit-state/sessions/turn.jsonl", sessionsRoot)).toBeNull();
		expect(sessionTranscriptHostPath("owner-a", "/home/node/.bobbit/agent/sessions/../escape", sessionsRoot)).toBeNull();
	});

	it("mounts exact private transcript/state roots for sessions and broad roots only for control containers", () => {
		const sessionArgs = buildDockerRunArgs({
			image: "bobbit-test", workspaceDir: root, stateDir, sessionId: "owner-a",
		});
		const sessionVolumes = volumeSources(sessionArgs);
		expect(sessionVolumes).toContain(`${toDockerPath(sessionTranscriptRoot("owner-a"))}:/home/node/.bobbit/agent/sessions`);
		expect(sessionVolumes).toContain(`${toDockerPath(sessionStateSessionsRoot(stateDir, "owner-a"))}:/bobbit-state/sessions`);
		expect(sessionVolumes).not.toContain(`${toDockerPath(path.join(stateDir, "sessions"))}:/bobbit-state/sessions`);

		const controlArgs = buildDockerRunArgs({ image: "bobbit-test", workspaceDir: root, stateDir, projectId: "control" });
		const controlVolumes = volumeSources(controlArgs);
		expect(controlVolumes).toContain(`${toDockerPath(path.join(stateDir, "sessions"))}:/bobbit-state/sessions`);
	});

	it("attests exact writable owner binds and rejects shared, sibling, hidden, duplicate, and read-only mounts", () => {
		const ownAgent = ensurePrivateSessionRoot(sessionTranscriptRoot("owner-a", sessionsRoot), sessionsRoot);
		const siblingAgent = ensurePrivateSessionRoot(sessionTranscriptRoot("owner-b", sessionsRoot), sessionsRoot);
		const ownState = ensurePrivateSessionRoot(sessionStateSessionsRoot(stateDir, "owner-a"), path.join(stateDir, "sessions"));
		const valid = [mount(ownAgent, "/home/node/.bobbit/agent/sessions"), mount(ownState, "/bobbit-state/sessions")];
		const expected = { stateDir, sessionId: "owner-a", agentSessionsRoot: sessionsRoot };
		expect(getSessionTranscriptMountStaleness(valid, expected).stale).toBe(false);
		for (const forged of [
			[mount(sessionsRoot, "/home/node/.bobbit/agent/sessions"), mount(ownState, "/bobbit-state/sessions")],
			[mount(siblingAgent, "/home/node/.bobbit/agent/sessions"), mount(ownState, "/bobbit-state/sessions")],
			[...valid, mount(siblingAgent, "/tmp/hidden-sibling")],
			[...valid, mount(ownAgent, "/home/node/.bobbit/agent/sessions")],
			[mount(ownAgent, "/home/node/.bobbit/agent/sessions", false, "ro"), mount(ownState, "/bobbit-state/sessions")],
		]) expect(getSessionTranscriptMountStaleness(forged, expected).stale).toBe(true);
	});

	it("reads and publishes the same canonical path only inside its trusted owner root", async () => {
		const ctxA = { sandboxed: true, projectId: "project", sessionId: "owner-a" };
		const ctxB = { sandboxed: true, projectId: "project", sessionId: "owner-b" };
		await sessionFileWriteAtomic(ctxA, containerFile, "owner-a marker", null);
		await sessionFileWriteAtomic(ctxB, containerFile, "owner-b marker", null);
		expect(await sessionFileRead(ctxA, containerFile, null)).toBe("owner-a marker");
		expect(await sessionFileRead(ctxB, containerFile, null)).toBe("owner-b marker");
		expect(containerPathToHost(containerFile, { sessionId: "owner-a" })).toBe(sessionTranscriptHostPath("owner-a", containerFile));
		await expect(sessionFileWriteAtomic({ sandboxed: true, projectId: "project" }, containerFile, "missing owner", null)).rejects.toThrow(/owner/i);
	});
});
