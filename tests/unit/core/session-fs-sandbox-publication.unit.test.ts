import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { activeAgentSessionsDir } from "../../../src/server/agent/agent-session-path.ts";
import {
	canonicalContainerAgentSessionPath,
	CrossRealmCopyError,
	sessionFileDeleteContainerOnly,
	sessionFileRenameAtomic,
	sessionFileWriteAtomic,
} from "../../../src/server/agent/session-fs.ts";
import { SandboxSessionFilesystem } from "../../support/harnesses/shared/sandbox-session-filesystem.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sandbox-session-publish-"));
const hostSessions = activeAgentSessionsDir();
const projectId = `sandbox-publication-${randomUUID()}`;

function target(label: string): string {
	return `/home/node/.bobbit/agent/sessions/${label}-${randomUUID()}/fork.jsonl`;
}

function createFilesystem(label: string): SandboxSessionFilesystem {
	return new SandboxSessionFilesystem({
		root: path.join(root, `${label}-${randomUUID()}`),
		hostAgentSessionsDir: hostSessions,
	});
}

function stagePaths(filesystem: SandboxSessionFilesystem): string[] {
	return filesystem.calls
		.flatMap(call => call.mappedArgs)
		.filter(value => path.dirname(value) === hostSessions && path.basename(value).startsWith(".bobbit-stage-"));
}

function siblingTemps(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory).filter(name => name.includes(".bobbit-stage-") && name.endsWith(".tmp"));
}

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("sandbox session transcript publication", () => {
	it("accepts only canonical paths under the supported container session roots", () => {
		for (const supported of [
			"/home/node/.bobbit/agent/sessions",
			"/home/node/.bobbit/agent/sessions/--workspace--/turn.jsonl",
			"/bobbit-state/sessions",
			"/bobbit-state/sessions/--workspace--/turn.jsonl",
		]) {
			expect(canonicalContainerAgentSessionPath(supported)).toBe(supported);
		}

		for (const rejected of [
			"",
			"\0/home/node/.bobbit/agent/sessions/turn.jsonl",
			"/home/node/.bobbit/agent/sessions\\turn.jsonl",
			"/home/node/.bobbit/agent/sessions/../turn.jsonl",
			"/home/node/.bobbit/agent/sessions/./turn.jsonl",
			"/home/node/.bobbit/agent/sessions//turn.jsonl",
			"home/node/.bobbit/agent/sessions/turn.jsonl",
			"./home/node/.bobbit/agent/sessions/turn.jsonl",
			"/home/node/.bobbit/agent/session/turn.jsonl",
			"/home/node/.bobbit/agent/sessions-lookalike/turn.jsonl",
			"/bobbit-state/session/turn.jsonl",
			"/bobbit-state/sessions-lookalike/turn.jsonl",
		]) {
			expect(canonicalContainerAgentSessionPath(rejected), rejected).toBeNull();
		}
	});

	it("publishes complete bytes through fixed container code without putting content in argv", async () => {
		const filesystem = createFilesystem("atomic");
		const destination = target("atomic");
		const content = `{"secret":"argv-canary-${randomUUID()}"}\nsecond line\n`;
		const hostDestination = filesystem.hostPath(destination);
		fs.mkdirSync(path.dirname(hostDestination), { recursive: true });
		fs.writeFileSync(hostDestination, "old-complete-content", "utf8");

		await sessionFileWriteAtomic(
			{ sandboxed: true, projectId },
			destination,
			content,
			filesystem.manager(projectId) as any,
		);

		expect(fs.readFileSync(hostDestination, "utf8")).toBe(content);
		expect(filesystem.calls).toHaveLength(1);
		expect(filesystem.calls[0].args.slice(0, 4)).toEqual(["node", "-e", expect.any(String), "--"]);
		expect(filesystem.calls[0].args.join("\n")).not.toContain(content.trim());
		expect(filesystem.calls[0].args[2]).toContain("COPYFILE_EXCL");
		expect(filesystem.calls[0].args[2]).toContain("renameSync");
		expect(stagePaths(filesystem).every(stage => !fs.existsSync(stage))).toBe(true);
		expect(siblingTemps(path.dirname(hostDestination))).toEqual([]);
		if (process.platform !== "win32") expect(fs.statSync(hostDestination).mode & 0o777).toBe(0o600);
	});

	it("keeps host symlink canaries untouched when an attacker swaps the predictable parent before publication", async (context) => {
		const filesystem = createFilesystem("symlink-race");
		const relativeParent = `hostile-parent-${randomUUID()}`;
		const destination = `/home/node/.bobbit/agent/sessions/${relativeParent}/fork.jsonl`;
		const sentinel = path.join(root, `host-sentinel-${randomUUID()}`);
		const hostParent = path.join(hostSessions, relativeParent);
		fs.mkdirSync(sentinel, { recursive: true });
		fs.writeFileSync(path.join(sentinel, "sentinel.txt"), "unchanged", "utf8");

		filesystem.beforeExec = async () => {
			try {
				fs.symlinkSync(sentinel, hostParent, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) context.skip();
				throw error;
			}
		};
		try {
			await sessionFileWriteAtomic(
				{ sandboxed: true, projectId },
				destination,
				"container-scoped transcript\n",
				filesystem.manager(projectId) as any,
			);
			expect(fs.readFileSync(path.join(sentinel, "sentinel.txt"), "utf8")).toBe("unchanged");
			expect(fs.existsSync(path.join(sentinel, "fork.jsonl"))).toBe(false);
			expect(fs.readFileSync(filesystem.hostPath(destination), "utf8")).toBe("container-scoped transcript\n");
		} finally {
			fs.rmSync(hostParent, { recursive: true, force: true });
		}
	});

	it("uses unique stages and publishes one complete winner under concurrent writes", async () => {
		const filesystem = createFilesystem("concurrent");
		const destination = target("concurrent");
		const first = `first-${"a".repeat(32_000)}\n`;
		const second = `second-${"b".repeat(32_000)}\n`;
		let entered = 0;
		let release!: () => void;
		const bothEntered = new Promise<void>(resolve => { release = resolve; });
		filesystem.beforeExec = async () => {
			entered++;
			if (entered === 2) release();
			await bothEntered;
		};

		await Promise.all([
			sessionFileWriteAtomic({ sandboxed: true, projectId }, destination, first, filesystem.manager(projectId) as any),
			sessionFileWriteAtomic({ sandboxed: true, projectId }, destination, second, filesystem.manager(projectId) as any),
		]);

		expect([first, second]).toContain(fs.readFileSync(filesystem.hostPath(destination), "utf8"));
		const stages = stagePaths(filesystem);
		expect(new Set(stages).size).toBe(2);
		expect(stages.every(stage => !fs.existsSync(stage))).toBe(true);
		expect(siblingTemps(path.dirname(filesystem.hostPath(destination)))).toEqual([]);
	});

	it("fails closed and cleans caller-owned stages and sibling temps without host fallback", async () => {
		const filesystem = createFilesystem("failure");
		const destination = target("failure");
		const hostDestination = filesystem.hostPath(destination);
		fs.mkdirSync(hostDestination, { recursive: true });

		await expect(sessionFileWriteAtomic(
			{ sandboxed: true, projectId },
			destination,
			"must-not-publish",
			filesystem.manager(projectId) as any,
		)).rejects.toThrow();
		expect(stagePaths(filesystem).every(stage => !fs.existsSync(stage))).toBe(true);
		expect(siblingTemps(path.dirname(hostDestination))).toEqual([]);
		expect(fs.statSync(hostDestination).isDirectory()).toBe(true);

		await expect(sessionFileWriteAtomic(
			{ sandboxed: true, projectId },
			destination,
			"unavailable",
			null,
		)).rejects.toThrow(`sandbox unavailable for project ${projectId}`);

		const hostCanary = path.join(hostSessions, `delete-canary-${randomUUID()}.jsonl`);
		fs.mkdirSync(path.dirname(hostCanary), { recursive: true });
		fs.writeFileSync(hostCanary, "preserve", "utf8");
		const containerCanary = `/home/node/.bobbit/agent/sessions/${path.basename(hostCanary)}`;
		try {
			expect(await sessionFileDeleteContainerOnly(
				{ sandboxed: true, projectId }, containerCanary, null,
			)).toBe(false);
			expect(fs.readFileSync(hostCanary, "utf8")).toBe("preserve");
		} finally {
			fs.rmSync(hostCanary, { force: true });
		}

		await expect(sessionFileRenameAtomic(
			{ sandboxed: true, projectId },
			"/home/node/.bobbit/agent/sessions/../escape.jsonl",
			"/home/node/.bobbit/agent/sessions/safe.jsonl",
			filesystem.manager(projectId) as any,
		)).rejects.toBeInstanceOf(CrossRealmCopyError);
	});
});
