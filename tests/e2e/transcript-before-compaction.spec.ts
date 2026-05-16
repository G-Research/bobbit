/**
 * E2E: GET /api/sessions/:id/transcript/before-compaction
 *
 * Backs the Part C "Show N messages before compaction" affordance.
 * Sidecar entries are written via `appendCompactionSidecarEntry`;
 * the JSONL on disk plus the sidecar's `firstKeptEntryId` (or the
 * `type:"compaction"` legacy fallback) defines the split.
 *
 * Covers:
 *   - happy path: total + pagination (cursor / nextCursor)
 *   - bad compactionId \u2192 404 compaction_not_found
 *   - cross-project caller \u2192 403 permission_denied
 *   - missing transcript \u2192 404 transcript_unavailable
 *
 * See docs/design/persist-compaction-history.md \u00a76.2.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
	appendCompactionSidecarEntry,
	initCompactionSidecarDir,
} from "../../src/server/agent/compaction-sidecar.js";

let token: string;
test.beforeAll(() => { token = readE2EToken(); });

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
}

/** Build a JSONL whose entries carry pi-coding-agent's entry-id schema. */
function makeJsonl(entries: Array<{
	id: string;
	type?: "message" | "compaction";
	role?: string;
	content?: any;
	summary?: string;
	firstKeptEntryId?: string;
	ts?: string;
}>): string {
	const lines: string[] = [];
	for (const e of entries) {
		if (e.type === "compaction") {
			lines.push(JSON.stringify({
				type: "compaction",
				id: e.id,
				parentId: null,
				timestamp: e.ts ?? new Date().toISOString(),
				summary: e.summary ?? "",
				firstKeptEntryId: e.firstKeptEntryId ?? "",
				tokensBefore: 1000,
			}));
		} else {
			lines.push(JSON.stringify({
				type: "message",
				id: e.id,
				parentId: null,
				timestamp: e.ts ?? new Date().toISOString(),
				ts: e.ts,
				message: { role: e.role ?? "user", content: e.content ?? "" },
			}));
		}
	}
	return lines.join("\n") + "\n";
}

function seedSession(
	gw: { sessionManager: any; bobbitDir: string },
	jsonl: string,
	overrides: Record<string, unknown> = {},
): { id: string; agentSessionFile: string; projectId: string } {
	const sm = gw.sessionManager;
	const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
	const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;
	const defaultProjectId: string =
		(pcm?.getDefaultProjectId?.() as string | undefined) ??
		(reg?.list?.()?.[0]?.id as string);
	expect(defaultProjectId).toBeTruthy();

	const id = crypto.randomUUID();
	const agentSessionFile = path.join(gw.bobbitDir, "state", `${id}.jsonl`);
	fs.writeFileSync(agentSessionFile, jsonl);

	const projectId = (overrides.projectId as string | undefined) ?? defaultProjectId;
	const ps = {
		id,
		title: "before-compaction test",
		cwd: gw.bobbitDir,
		agentSessionFile,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
		projectId,
	};
	const store = sm.getSessionStore(projectId);
	store.put(ps);
	return { id, agentSessionFile, projectId };
}

test.describe("GET /api/sessions/:id/transcript/before-compaction", () => {
	test("happy path \u2014 pagination via cursor / nextCursor", async ({ gateway }) => {
		// Re-init sidecar dir to the e2e isolated state dir so appended
		// sidecar entries land in a place the server can read.
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const orphanCount = 6;
		const entries: Array<any> = [];
		for (let i = 0; i < orphanCount; i++) {
			entries.push({
				id: `pre-${i}`,
				role: i % 2 === 0 ? "user" : "assistant",
				content: `pre-msg-${i}`,
				ts: new Date(2026, 0, 1, 0, i, 0).toISOString(),
			});
		}
		// Boundary: kept entry
		entries.push({
			id: "kept-1",
			role: "user",
			content: "kept-msg-1",
			ts: new Date(2026, 0, 1, 1, 0, 0).toISOString(),
		});
		entries.push({
			id: "kept-2",
			role: "assistant",
			content: "kept-msg-2",
			ts: new Date(2026, 0, 1, 1, 1, 0).toISOString(),
		});
		const jsonl = makeJsonl(entries);
		const { id } = seedSession(gateway, jsonl);

		const compactionId = "c_test_happy";
		appendCompactionSidecarEntry(id, {
			schemaVersion: 1,
			id: compactionId,
			trigger: "manual",
			tokensBefore: 1000,
			tokensAfter: null,
			durationMs: 500,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			success: true,
			firstKeptEntryId: "kept-1",
		});

		// First page \u2014 limit 4 of 6 orphaned.
		const r1 = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction?compactionId=${compactionId}&limit=4`, { headers: authHeaders() });
		expect(r1.status).toBe(200);
		const b1 = await r1.json();
		expect(b1.total).toBe(orphanCount);
		expect(b1.returned).toBe(4);
		expect(b1.nextCursor).toBe(4);
		expect(b1.messages[0].text).toBe("pre-msg-0");
		expect(b1.messages[3].text).toBe("pre-msg-3");

		// Second page \u2014 remaining 2.
		const r2 = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction?compactionId=${compactionId}&limit=4&cursor=4`, { headers: authHeaders() });
		expect(r2.status).toBe(200);
		const b2 = await r2.json();
		expect(b2.total).toBe(orphanCount);
		expect(b2.returned).toBe(2);
		expect(b2.nextCursor).toBeNull();
		expect(b2.messages[0].text).toBe("pre-msg-4");
		expect(b2.messages[1].text).toBe("pre-msg-5");
	});

	test("compaction_not_found for unknown compactionId", async ({ gateway }) => {
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const jsonl = makeJsonl([
			{ id: "m1", role: "user", content: "hi" },
			{ id: "m2", role: "assistant", content: "yo" },
		]);
		const { id } = seedSession(gateway, jsonl);
		const r = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction?compactionId=does-not-exist`, { headers: authHeaders() });
		expect(r.status).toBe(404);
		expect((await r.json()).error).toBe("compaction_not_found");
	});

	test("invalid_params when compactionId missing", async ({ gateway }) => {
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const jsonl = makeJsonl([{ id: "m1", role: "user", content: "hi" }]);
		const { id } = seedSession(gateway, jsonl);
		const r = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction`, { headers: authHeaders() });
		expect(r.status).toBe(400);
		expect((await r.json()).error).toBe("invalid_params");
	});

	test("transcript_unavailable when .jsonl empty", async ({ gateway }) => {
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const { id } = seedSession(gateway, "");
		appendCompactionSidecarEntry(id, {
			schemaVersion: 1,
			id: "c_empty",
			trigger: "manual",
			tokensBefore: 100,
			tokensAfter: null,
			durationMs: 50,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			success: true,
			firstKeptEntryId: "nope",
		});
		const r = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction?compactionId=c_empty`, { headers: authHeaders() });
		expect(r.status).toBe(404);
		expect((await r.json()).error).toBe("transcript_unavailable");
	});

	test("permission_denied for cross-project caller", async ({ gateway }) => {
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const sm = gateway.sessionManager as any;
		const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
		const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;

		const otherRoot = path.join(gateway.bobbitDir, "other-proj-precomp");
		fs.mkdirSync(otherRoot, { recursive: true });
		// Use the shared helper so rootPath is canonicalized (handles the macOS
		// /var → /private/var tmpdir symlink) and acceptCanonical:true is set.
		const { registerProject } = await import("./e2e-setup.js");
		const otherProj = await registerProject({
			name: "other-precomp",
			rootPath: otherRoot,
			upsert: true,
			seedWorkflows: false,
		});
		const otherProjectId = otherProj.id;
		expect(otherProjectId).toBeTruthy();
		expect(otherProjectId).not.toBe(reg?.list?.()?.[0]?.id);

		const jsonl = makeJsonl([
			{ id: "p1", role: "user", content: "secret-1" },
			{ id: "p2", role: "assistant", content: "secret-2" },
			{ id: "k1", role: "user", content: "kept" },
		]);
		const { id: targetId } = seedSession(gateway, jsonl);
		appendCompactionSidecarEntry(targetId, {
			schemaVersion: 1,
			id: "c_secret",
			trigger: "manual",
			tokensBefore: 100,
			tokensAfter: null,
			durationMs: 50,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			success: true,
			firstKeptEntryId: "k1",
		});
		const { id: callerId } = seedSession(gateway, "", { projectId: otherProjectId });

		const r = await fetch(`${base()}/api/sessions/${targetId}/transcript/before-compaction?compactionId=c_secret`, {
			headers: authHeaders({ "x-bobbit-session-id": callerId }),
		});
		expect(r.status).toBe(403);
		expect((await r.json()).error).toBe("permission_denied");
	});

	test("legacy fallback \u2014 scans for in-jsonl `type:\"compaction\"` marker when firstKeptEntryId is null", async ({ gateway }) => {
		initCompactionSidecarDir(path.join(gateway.bobbitDir, "state"));
		const jsonl = makeJsonl([
			{ id: "pre-a", role: "user", content: "legacy-pre-a" },
			{ id: "pre-b", role: "assistant", content: "legacy-pre-b" },
			{ id: "cmark", type: "compaction", summary: "...", firstKeptEntryId: "post-a" },
			{ id: "post-a", role: "user", content: "kept-a" },
		]);
		const { id } = seedSession(gateway, jsonl);
		appendCompactionSidecarEntry(id, {
			schemaVersion: 1,
			id: "c_legacy",
			trigger: "auto",
			tokensBefore: 200,
			tokensAfter: null,
			durationMs: 100,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			success: true,
			firstKeptEntryId: null,
		});
		const r = await fetch(`${base()}/api/sessions/${id}/transcript/before-compaction?compactionId=c_legacy`, { headers: authHeaders() });
		expect(r.status).toBe(200);
		const b = await r.json();
		expect(b.total).toBe(2);
		expect(b.messages.map((m: any) => m.text)).toEqual(["legacy-pre-a", "legacy-pre-b"]);
	});
});
