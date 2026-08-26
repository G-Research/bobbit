import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { SandboxManager } from "../../src/server/agent/sandbox-manager.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import type { SessionTranscriptRuntimeOperation } from "../../src/server/agent/project-sandbox.ts";
import {
	canonicalContainerAgentSessionPath,
	CrossRealmCopyError,
	sessionFileCopy,
	sessionFileDelete,
	sessionFileDeleteContainerOnly,
	sessionFileExists,
	sessionFileRead,
	sessionFileRenameAtomic,
	sessionFileWriteAtomic,
} from "../../src/server/agent/session-fs.ts";

const owners = [`publication-a-${randomUUID()}`, `publication-b-${randomUUID()}`];
const projectId = `sandbox-publication-${randomUUID()}`;
const canonical = "/home/node/.bobbit/agent/sessions/--workspace--/turn.jsonl";
const renamed = "/home/node/.bobbit/agent/sessions/--workspace--/renamed.jsonl";
const ctx = (sessionId: string) => ({ sandboxed: true, projectId, sessionId });
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-fs-adversary-"));

type OperationCall = {
	projectId: string;
	sessionId: string;
	operation: SessionTranscriptRuntimeOperation;
};

function fakeAttestedRuntime(beforeOperation?: (call: OperationCall) => void) {
	const files = new Map<string, string>();
	const calls: OperationCall[] = [];
	const key = (sessionId: string, filePath: string) => `${sessionId}\0${filePath}`;
	const runSessionTranscriptOperation = vi.fn(async (
		actualProjectId: string,
		sessionId: string,
		operation: SessionTranscriptRuntimeOperation,
	): Promise<string | boolean | void> => {
		const call = { projectId: actualProjectId, sessionId, operation };
		calls.push(call);
		beforeOperation?.(call);
		if (actualProjectId !== projectId || !owners.includes(sessionId)) {
			throw new Error("runtime attestation rejected");
		}
		switch (operation.kind) {
			case "exists": return files.has(key(sessionId, operation.path));
			case "read": {
				const content = files.get(key(sessionId, operation.path));
				if (content === undefined) throw new Error("missing transcript");
				return content;
			}
			case "writeAtomic":
				files.set(key(sessionId, operation.path), Buffer.isBuffer(operation.content)
					? operation.content.toString("utf8")
					: operation.content);
				return;
			case "renameAtomic": {
				const source = key(sessionId, operation.sourcePath);
				const content = files.get(source);
				if (content === undefined) throw new Error("missing transcript");
				files.delete(source);
				files.set(key(sessionId, operation.targetPath), content);
				return;
			}
			case "delete":
				files.delete(key(sessionId, operation.path));
				return;
		}
	});
	return {
		manager: { runSessionTranscriptOperation } as unknown as SandboxManager,
		files,
		calls,
		key,
		runSessionTranscriptOperation,
	};
}

afterAll(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

describe("owner-scoped sandbox transcript publication", () => {
	it("accepts only canonical paths under Pi's primary session root", () => {
		expect(canonicalContainerAgentSessionPath(canonical)).toBe(canonical);
		for (const rejected of [
			"", "/bobbit-state/sessions/turn.jsonl",
			"/home/node/.bobbit/agent/sessions/../turn.jsonl",
			"/home/node/.bobbit/agent/sessions\\turn.jsonl",
			"/home/node/.bobbit/agent/sessions/turn\n.jsonl",
			"/home/node/.bobbit/agent/sessions-lookalike/turn.jsonl",
		]) expect(canonicalContainerAgentSessionPath(rejected), rejected).toBeNull();
	});

	it("fails closed without exact project, owner, runtime, or canonical path authority", async () => {
		await expect(sessionFileWriteAtomic({ sandboxed: true, projectId }, canonical, "no owner", null)).rejects.toBeInstanceOf(CrossRealmCopyError);
		await expect(sessionFileWriteAtomic(ctx(owners[0]), canonical, "no runtime", null)).rejects.toBeInstanceOf(CrossRealmCopyError);
		await expect(sessionFileWriteAtomic(ctx(owners[0]), "/home/node/.bobbit/agent/sessions/../escape", "escape", fakeAttestedRuntime().manager)).rejects.toBeInstanceOf(CrossRealmCopyError);
		expect(await sessionFileRead(ctx(owners[0]), canonical, null)).toBeNull();
		expect(await sessionFileExists(ctx(owners[0]), canonical, null)).toBe(false);
		expect(await sessionFileDelete(ctx(owners[0]), canonical, null)).toBe(false);
	});

	it("routes write/read/exists/copy/rename/delete through exact owner runtimes", async () => {
		const runtime = fakeAttestedRuntime();
		await sessionFileWriteAtomic(ctx(owners[0]), canonical, "complete owner bytes", runtime.manager);
		expect(await sessionFileExists(ctx(owners[0]), canonical, runtime.manager)).toBe(true);
		expect(await sessionFileRead(ctx(owners[0]), canonical, runtime.manager)).toBe("complete owner bytes");
		expect(await sessionFileRead(ctx(owners[1]), canonical, runtime.manager)).toBeNull();

		await sessionFileCopy(ctx(owners[0]), canonical, ctx(owners[1]), canonical, runtime.manager, {
			mkdirSync: vi.fn(() => { throw new Error("host mkdir forbidden"); }),
			copyFileSync: vi.fn(() => { throw new Error("host copy forbidden"); }),
		});
		await sessionFileRenameAtomic(ctx(owners[1]), canonical, renamed, runtime.manager);
		expect(await sessionFileRead(ctx(owners[1]), renamed, runtime.manager)).toBe("complete owner bytes");
		expect(await sessionFileDeleteContainerOnly(ctx(owners[1]), renamed, runtime.manager)).toBe(true);
		expect(await sessionFileDelete(ctx(owners[0]), canonical, runtime.manager, {
			unlink: vi.fn(async () => { throw new Error("host unlink forbidden"); }),
		})).toBe(true);

		expect(runtime.calls.map(call => [call.projectId, call.sessionId, call.operation.kind])).toEqual([
			[projectId, owners[0], "writeAtomic"],
			[projectId, owners[0], "exists"],
			[projectId, owners[0], "read"],
			[projectId, owners[1], "read"],
			[projectId, owners[0], "read"],
			[projectId, owners[1], "writeAtomic"],
			[projectId, owners[1], "renameAtomic"],
			[projectId, owners[1], "read"],
			[projectId, owners[1], "delete"],
			[projectId, owners[0], "delete"],
		]);
	});

	it("never follows host symlink swaps for any sandbox transcript operation", async () => {
		const sentinelDirectory = path.join(outsideRoot, `sentinel-dir-${randomUUID()}`);
		const hostileParent = path.join(outsideRoot, `sandbox-parent-${randomUUID()}`);
		const sentinel = path.join(sentinelDirectory, "turn.jsonl");
		const hostileEntry = path.join(hostileParent, "turn.jsonl");
		const sentinelBytes = "OUTSIDE_HOST_SENTINEL";
		fs.mkdirSync(sentinelDirectory);
		fs.writeFileSync(sentinel, sentinelBytes);

		const runtime = fakeAttestedRuntime(() => {
			// Deterministic adversarial seam: swap the checked parent to a host
			// symlink/junction immediately before every runtime operation.
			try { fs.unlinkSync(hostileParent); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
			fs.symlinkSync(sentinelDirectory, hostileParent, process.platform === "win32" ? "junction" : "dir");
			expect(fs.lstatSync(hostileParent).isSymbolicLink()).toBe(true);
		});
		runtime.files.set(runtime.key(owners[0], canonical), "INSIDE_RUNTIME_TRANSCRIPT");

		expect(await sessionFileRead(ctx(owners[0]), canonical, runtime.manager)).toBe("INSIDE_RUNTIME_TRANSCRIPT");
		await sessionFileWriteAtomic(ctx(owners[0]), canonical, "UPDATED_INSIDE", runtime.manager);
		await sessionFileRenameAtomic(ctx(owners[0]), canonical, renamed, runtime.manager);
		await sessionFileCopy(ctx(owners[0]), renamed, ctx(owners[1]), canonical, runtime.manager);
		expect(await sessionFileDelete(ctx(owners[0]), renamed, runtime.manager)).toBe(true);

		expect(fs.readFileSync(sentinel, "utf8")).toBe(sentinelBytes);
		expect(fs.lstatSync(hostileParent).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(hostileEntry, "utf8")).toBe(sentinelBytes);
		expect(runtime.calls.every(call => call.projectId === projectId && owners.includes(call.sessionId))).toBe(true);
		expect(JSON.stringify(runtime.calls)).not.toContain(sentinel);
		expect(JSON.stringify(runtime.calls)).not.toContain(hostileEntry);
	});

	it("reads a quiescent legacy source by bound handle but publishes only through the owner runtime", async () => {
		const legacySource = path.join(outsideRoot, `legacy-${randomUUID()}.jsonl`);
		const legacyBytes = Buffer.from('{"type":"message","text":"legacy"}\n', "utf8");
		fs.writeFileSync(legacySource, legacyBytes);
		const sentinel = path.join(outsideRoot, `legacy-destination-sentinel-${randomUUID()}`);
		fs.writeFileSync(sentinel, "DESTINATION_SENTINEL");
		const runtime = fakeAttestedRuntime();
		const ps = { id: owners[0], sandboxed: true, projectId };

		await (SessionManager.prototype as any)._publishLegacySandboxFile.call(
			{ sandboxManager: runtime.manager },
			ps,
			legacySource,
			canonical,
		);

		expect(runtime.files.get(runtime.key(owners[0], canonical))).toBe(legacyBytes.toString("utf8"));
		expect(runtime.calls.map(call => call.operation.kind)).toEqual(["read", "writeAtomic"]);
		expect(runtime.calls.every(call => call.projectId === projectId && call.sessionId === owners[0])).toBe(true);
		expect(JSON.stringify(runtime.calls)).not.toContain(legacySource);
		expect(JSON.stringify(runtime.calls)).not.toContain(sentinel);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("DESTINATION_SENTINEL");
	});

	it("rejects cross-project owner copies before invoking a runtime", async () => {
		const runtime = fakeAttestedRuntime();
		await expect(sessionFileCopy(
			ctx(owners[0]), canonical,
			{ ...ctx(owners[1]), projectId: "other" }, canonical,
			runtime.manager,
		)).rejects.toBeInstanceOf(CrossRealmCopyError);
		expect(runtime.runSessionTranscriptOperation).not.toHaveBeenCalled();
	});
});
