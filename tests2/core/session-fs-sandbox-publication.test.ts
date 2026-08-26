import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { sessionTranscriptHostPath, sessionTranscriptRoot } from "../../src/server/agent/agent-session-path.ts";
import {
	canonicalContainerAgentSessionPath,
	CrossRealmCopyError,
	sessionFileCopy,
	sessionFileDelete,
	sessionFileRead,
	sessionFileRenameAtomic,
	sessionFileWriteAtomic,
} from "../../src/server/agent/session-fs.ts";

const owners = [`publication-a-${randomUUID()}`, `publication-b-${randomUUID()}`];
const projectId = `sandbox-publication-${randomUUID()}`;
const canonical = "/home/node/.bobbit/agent/sessions/--workspace--/turn.jsonl";
const renamed = "/home/node/.bobbit/agent/sessions/--workspace--/renamed.jsonl";
const ctx = (sessionId: string) => ({ sandboxed: true, projectId, sessionId });

afterAll(() => {
	for (const owner of owners) fs.rmSync(sessionTranscriptRoot(owner), { recursive: true, force: true });
});

describe("owner-scoped sandbox transcript publication", () => {
	it("accepts only canonical paths under Pi's primary session root", () => {
		expect(canonicalContainerAgentSessionPath(canonical)).toBe(canonical);
		for (const rejected of [
			"", "/bobbit-state/sessions/turn.jsonl",
			"/home/node/.bobbit/agent/sessions/../turn.jsonl",
			"/home/node/.bobbit/agent/sessions\\turn.jsonl",
			"/home/node/.bobbit/agent/sessions-lookalike/turn.jsonl",
		]) expect(canonicalContainerAgentSessionPath(rejected), rejected).toBeNull();
	});

	it("publishes atomically to the owner root without a live container", async () => {
		await sessionFileWriteAtomic(ctx(owners[0]), canonical, "complete owner bytes", null);
		expect(await sessionFileRead(ctx(owners[0]), canonical, null)).toBe("complete owner bytes");
		expect(fs.readFileSync(sessionTranscriptHostPath(owners[0], canonical)!, "utf8")).toBe("complete owner bytes");
		expect(await sessionFileRead(ctx(owners[1]), canonical, null)).toBeNull();
	});

	it("keeps owner-to-owner clone and rename operations independently translated", async () => {
		await sessionFileCopy(ctx(owners[0]), canonical, ctx(owners[1]), canonical, null);
		expect(await sessionFileRead(ctx(owners[1]), canonical, null)).toBe("complete owner bytes");
		await sessionFileRenameAtomic(ctx(owners[1]), canonical, renamed, null);
		expect(await sessionFileRead(ctx(owners[1]), canonical, null)).toBeNull();
		expect(await sessionFileRead(ctx(owners[1]), renamed, null)).toBe("complete owner bytes");
	});

	it("fails closed for absent owners, cross-project clones, traversal, and symlink parents", async (testContext) => {
		await expect(sessionFileWriteAtomic({ sandboxed: true, projectId }, canonical, "no owner", null)).rejects.toBeInstanceOf(CrossRealmCopyError);
		await expect(sessionFileCopy(ctx(owners[0]), canonical, { ...ctx(owners[1]), projectId: "other" }, canonical, null)).rejects.toBeInstanceOf(CrossRealmCopyError);
		await expect(sessionFileWriteAtomic(ctx(owners[0]), "/home/node/.bobbit/agent/sessions/../escape", "escape", null)).rejects.toBeInstanceOf(CrossRealmCopyError);

		const hostileContainer = "/home/node/.bobbit/agent/sessions/hostile/turn.jsonl";
		const hostileParent = path.dirname(sessionTranscriptHostPath(owners[0], hostileContainer)!);
		const sentinel = path.join(sessionTranscriptRoot(owners[0]), `sentinel-${randomUUID()}`);
		fs.mkdirSync(sentinel, { recursive: true });
		try {
			fs.symlinkSync(sentinel, hostileParent, process.platform === "win32" ? "junction" : "dir");
		} catch (error: any) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) testContext.skip();
			throw error;
		}
		await expect(sessionFileWriteAtomic(ctx(owners[0]), hostileContainer, "blocked", null)).rejects.toThrow(/unsafe/i);
		expect(fs.existsSync(path.join(sentinel, "turn.jsonl"))).toBe(false);
		fs.rmSync(hostileParent, { recursive: true, force: true });
	});

	it("deletes only the selected owner's exact transcript", async () => {
		expect(await sessionFileDelete(ctx(owners[1]), renamed, null)).toBe(true);
		expect(await sessionFileRead(ctx(owners[1]), renamed, null)).toBeNull();
		expect(await sessionFileRead(ctx(owners[0]), canonical, null)).toBe("complete owner bytes");
	});
});
