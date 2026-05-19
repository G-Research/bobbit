/**
 * API E2E — Reopen Archived Proposals (Path B).
 *
 * Path B of the design lifts the 422 block on continuing assistant sessions
 * and clones the source's `<stateDir>/proposal-drafts/<sid>/` directory
 * verbatim into the new session's slot. The cloned directory contains the
 * live `<type>.{md,yaml}` file plus the entire `<type>.history/<rev>.<ext>`
 * snapshot tree so the new agent picks up the in-progress draft and rev
 * counter without colliding.
 *
 * Coverage:
 *   - Goal / role / tool / staff / project assistant happy paths.
 *   - History snapshots survive the clone byte-identical.
 *   - `response.assistantType` is echoed in the 201 body for the UI.
 *   - Negative: goal-linked + delegate sessions still 422.
 *   - No-draft assistant: continue succeeds; no `proposal-drafts/<newId>/`
 *     directory is created (silent no-op).
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	connectWs,
	agentEndPredicate,
	nonGitCwd,
	createSession as createSessionFromHarness,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────────

async function archive(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `archive ${id}: ${resp.status}`).toBe(true);
}

async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		ws.close();
	}
}

async function createAssistantSession(assistantType: string): Promise<string> {
	const body: Record<string, unknown> = { cwd: nonGitCwd(), assistantType };
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.status, `create ${assistantType} assistant`).toBe(201);
	const data = await resp.json();
	return data.id as string;
}

function extFor(type: string): string {
	return type === "goal" ? "md" : "yaml";
}

function proposalRoot(bobbitDir: string, sid: string): string {
	return path.join(bobbitDir, "state", "proposal-drafts", sid);
}

function proposalFile(bobbitDir: string, sid: string, type: string): string {
	return path.join(proposalRoot(bobbitDir, sid), `${type}.${extFor(type)}`);
}

function historyDir(bobbitDir: string, sid: string, type: string): string {
	return path.join(proposalRoot(bobbitDir, sid), `${type}.history`);
}

/** Seed a draft + at least one history snapshot via the public REST API. */
async function seedDraftWithHistory(
	sid: string,
	type: string,
	args: Record<string, unknown>,
	editPairs: Array<{ old_text: string; new_text: string }>,
): Promise<void> {
	const seed = await apiFetch(`/api/sessions/${sid}/proposal/${type}/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
	expect(seed.status, `seed ${type}`).toBe(200);
	for (const pair of editPairs) {
		const edit = await apiFetch(`/api/sessions/${sid}/proposal/${type}/edit`, {
			method: "POST",
			body: JSON.stringify(pair),
		});
		expect(edit.status, `edit ${type} (${pair.old_text} → ${pair.new_text})`).toBe(200);
	}
}

async function continueArchived(sid: string): Promise<Response> {
	return apiFetch(`/api/sessions/${sid}/continue`, {
		method: "POST",
		body: JSON.stringify({}),
	});
}

function diffBytes(a: string, b: string): void {
	expect(fs.existsSync(a), `missing ${a}`).toBe(true);
	expect(fs.existsSync(b), `missing ${b}`).toBe(true);
	const aBytes = fs.readFileSync(a);
	const bBytes = fs.readFileSync(b);
	expect(bBytes.equals(aBytes), `byte mismatch between ${a} and ${b}`).toBe(true);
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe("Continue-Archived (assistant) — Path B", () => {
	test("goal-assistant: clones live file + history snapshots byte-identical", async ({ gateway }) => {
		const sid = await createAssistantSession("goal");
		// Continue route rejects empty `.jsonl` with 404 — prime the transcript.
		await sendPromptAndWait(sid, "prime goal-assistant transcript");
		await seedDraftWithHistory(sid, "goal",
			{ title: "Original Title", spec: "Original spec\n", workflow: "feature" },
			[
				{ old_text: "Original Title", new_text: "Edited Title" },
				{ old_text: "Original spec", new_text: "Polished spec" },
			],
		);
		// Sanity: source file and history exist before archive.
		const srcLive = proposalFile(gateway.bobbitDir, sid, "goal");
		const srcHist = historyDir(gateway.bobbitDir, sid, "goal");
		expect(fs.existsSync(srcLive)).toBe(true);
		const histFiles = fs.readdirSync(srcHist).sort();
		expect(histFiles.length).toBeGreaterThanOrEqual(2);

		await archive(sid);

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(sid);
		expect(data.assistantType).toBe("goal");

		const newId: string = data.id;
		const dstLive = proposalFile(gateway.bobbitDir, newId, "goal");
		const dstHist = historyDir(gateway.bobbitDir, newId, "goal");

		// Wait for the clone to settle (fs.cpSync is sync in the request handler,
		// but the response races the disk flush on some Windows FS — pollUntil
		// keeps the test robust without artificial sleeps).
		await pollUntil(async () => fs.existsSync(dstLive), {
			timeoutMs: 5_000,
			intervalMs: 25,
			label: "cloned live proposal file exists",
		});

		diffBytes(srcLive, dstLive);
		const dstHistFiles = fs.readdirSync(dstHist).sort();
		expect(dstHistFiles).toEqual(histFiles);
		for (const f of histFiles) {
			diffBytes(path.join(srcHist, f), path.join(dstHist, f));
		}
	});

	test("role-assistant: yaml draft + history clone verbatim", async ({ gateway }) => {
		const sid = await createAssistantSession("role");
		await sendPromptAndWait(sid, "prime role-assistant transcript");
		await seedDraftWithHistory(sid, "role",
			{ name: "alpha", label: "Alpha Role", prompt: "do alpha things" },
			[{ old_text: "Alpha Role", new_text: "Alpha Role v2" }],
		);
		await archive(sid);

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("role");

		const newId: string = data.id;
		const srcLive = proposalFile(gateway.bobbitDir, sid, "role");
		const dstLive = proposalFile(gateway.bobbitDir, newId, "role");
		await pollUntil(async () => fs.existsSync(dstLive), {
			timeoutMs: 5_000,
			intervalMs: 25,
			label: "cloned role proposal file exists",
		});
		diffBytes(srcLive, dstLive);
	});

	test("tool-assistant: yaml draft clone", async ({ gateway }) => {
		const sid = await createAssistantSession("tool");
		await sendPromptAndWait(sid, "prime tool-assistant transcript");
		await seedDraftWithHistory(sid, "tool",
			{ tool: "alpha", action: "create", content: "name: alpha\nlabel: Alpha Tool\n" },
			[],
		);
		await archive(sid);

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("tool");

		const newId: string = data.id;
		const dstLive = proposalFile(gateway.bobbitDir, newId, "tool");
		await pollUntil(async () => fs.existsSync(dstLive), {
			timeoutMs: 5_000,
			intervalMs: 25,
			label: "cloned tool proposal file exists",
		});
		const srcLive = proposalFile(gateway.bobbitDir, sid, "tool");
		diffBytes(srcLive, dstLive);
	});

	test("staff-assistant: clone happy path", async ({ gateway }) => {
		const sid = await createAssistantSession("staff");
		await sendPromptAndWait(sid, "prime staff-assistant transcript");
		await seedDraftWithHistory(sid, "staff",
			{ name: "alpha-staff", prompt: "do staff things" },
			[],
		);
		await archive(sid);

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("staff");

		const newId: string = data.id;
		const dstLive = proposalFile(gateway.bobbitDir, newId, "staff");
		await pollUntil(async () => fs.existsSync(dstLive), {
			timeoutMs: 5_000,
			intervalMs: 25,
			label: "cloned staff proposal file exists",
		});
		const srcLive = proposalFile(gateway.bobbitDir, sid, "staff");
		diffBytes(srcLive, dstLive);
	});

	test("no-draft assistant: continue succeeds, no proposal-drafts dir created", async ({ gateway }) => {
		const sid = await createAssistantSession("goal");
		// Send a prompt so the .jsonl has content (continue rejects empty transcripts).
		await sendPromptAndWait(sid, "no draft, just chatter");
		// Source has no draft on disk.
		expect(fs.existsSync(proposalRoot(gateway.bobbitDir, sid))).toBe(false);
		await archive(sid);

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("goal");

		const newId: string = data.id;
		// Give the silent no-op a beat — but it really should be synchronous.
		await pollUntil(async () => true, { timeoutMs: 100, intervalMs: 25, label: "settle" }).catch(() => {});
		expect(fs.existsSync(proposalRoot(gateway.bobbitDir, newId))).toBe(false);
	});

	test("goal-linked session is still rejected with 422 (regression guard)", async () => {
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Path B guard goal",
				cwd: nonGitCwd(),
				team: false,
				worktree: false,
				workflowId: "general",
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const sessionResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), goalId: goal.id }),
		});
		expect(sessionResp.status).toBe(201);
		const sid = (await sessionResp.json()).id as string;
		await sendPromptAndWait(sid, "goal session message");
		await archive(sid);

		const cont = await continueArchived(sid);
		expect(cont.status).toBe(422);
	});

	test("delegate session is still rejected with 422 (regression guard)", async () => {
		const parentId = await createSessionFromHarness();
		await sendPromptAndWait(parentId, "parent");
		const delegateId = await createSessionFromHarness();
		const patch = await apiFetch(`/api/sessions/${delegateId}`, {
			method: "PATCH",
			body: JSON.stringify({ delegateOf: parentId }),
		});
		expect(patch.ok).toBe(true);
		await sendPromptAndWait(delegateId, "delegate msg");
		await archive(delegateId);

		const resp = await continueArchived(delegateId);
		expect(resp.status).toBe(422);
		await archive(parentId).catch(() => {});
	});
});
