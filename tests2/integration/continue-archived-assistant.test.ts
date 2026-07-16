/**
 * API E2E — Reopen Archived Proposals (Path B).
 *
 * Path B lifts the 422 block on continuing assistant sessions and clones the
 * source proposal draft directory verbatim into the new session's slot.
 */
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	createSession as createSessionFromHarness,
} from "./_e2e/e2e-setup.js";
import { createSessionTracker, seedSessionTranscript, trackGoal } from "./helpers/session-fixtures.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const sessions = createSessionTracker();

async function archive(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `archive ${id}: ${resp.status}`).toBe(true);
}

async function createAssistantSession(assistantType: string): Promise<string> {
	const body: Record<string, unknown> = { cwd: nonGitCwd(), assistantType };
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.status, `create ${assistantType} assistant`).toBe(201);
	const data = await resp.json();
	return sessions.add(data.id as string);
}

async function archiveWithTranscript(gateway: any, id: string, text: string): Promise<void> {
	await archive(id);
	seedSessionTranscript(gateway, id, [{ role: "user", text }]);
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
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));
	test("goal-assistant: clones live file + history snapshots byte-identical", async ({ gateway }) => {
		const sid = await createAssistantSession("goal");
		await seedDraftWithHistory(sid, "goal",
			{ title: "Original Title", spec: "Original spec\n", workflow: "feature" },
			[
				{ old_text: "Original Title", new_text: "Edited Title" },
				{ old_text: "Original spec", new_text: "Polished spec" },
			],
		);
		const srcLive = proposalFile(gateway.bobbitDir, sid, "goal");
		const srcHist = historyDir(gateway.bobbitDir, sid, "goal");
		expect(fs.existsSync(srcLive)).toBe(true);
		const histFiles = fs.readdirSync(srcHist).sort();
		expect(histFiles.length).toBeGreaterThanOrEqual(2);

		await archiveWithTranscript(gateway, sid, "prime goal-assistant transcript");

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(sid);
		expect(data.assistantType).toBe("goal");

		const newId = sessions.add(data.id as string);
		const dstLive = proposalFile(gateway.bobbitDir, newId, "goal");
		const dstHist = historyDir(gateway.bobbitDir, newId, "goal");

		// copyProposalDirIfPresent uses cpSync before the response is written.
		diffBytes(srcLive, dstLive);
		const dstHistFiles = fs.readdirSync(dstHist).sort();
		expect(dstHistFiles).toEqual(histFiles);
		for (const f of histFiles) {
			diffBytes(path.join(srcHist, f), path.join(dstHist, f));
		}
	});

	test("role-assistant: yaml draft + history clone verbatim", async ({ gateway }) => {
		const sid = await createAssistantSession("role");
		await seedDraftWithHistory(sid, "role",
			{ name: "alpha", label: "Alpha Role", prompt: "do alpha things" },
			[{ old_text: "Alpha Role", new_text: "Alpha Role v2" }],
		);
		await archiveWithTranscript(gateway, sid, "prime role-assistant transcript");

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("role");

		const newId = sessions.add(data.id as string);
		diffBytes(
			proposalFile(gateway.bobbitDir, sid, "role"),
			proposalFile(gateway.bobbitDir, newId, "role"),
		);
	});

	test("tool-assistant: yaml draft clone", async ({ gateway }) => {
		const sid = await createAssistantSession("tool");
		await seedDraftWithHistory(sid, "tool",
			{ tool: "alpha", action: "create", content: "name: alpha\nlabel: Alpha Tool\n" },
			[],
		);
		await archiveWithTranscript(gateway, sid, "prime tool-assistant transcript");

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("tool");

		const newId = sessions.add(data.id as string);
		diffBytes(
			proposalFile(gateway.bobbitDir, sid, "tool"),
			proposalFile(gateway.bobbitDir, newId, "tool"),
		);
	});

	test("staff-assistant: clone happy path", async ({ gateway }) => {
		const sid = await createAssistantSession("staff");
		await seedDraftWithHistory(sid, "staff",
			{ name: "alpha-staff", prompt: "do staff things" },
			[],
		);
		await archiveWithTranscript(gateway, sid, "prime staff-assistant transcript");

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("staff");

		const newId = sessions.add(data.id as string);
		diffBytes(
			proposalFile(gateway.bobbitDir, sid, "staff"),
			proposalFile(gateway.bobbitDir, newId, "staff"),
		);
	});

	test("no-draft assistant: continue succeeds, no proposal-drafts dir created", async ({ gateway }) => {
		const sid = await createAssistantSession("goal");
		expect(fs.existsSync(proposalRoot(gateway.bobbitDir, sid))).toBe(false);
		await archiveWithTranscript(gateway, sid, "no draft, just chatter");

		const resp = await continueArchived(sid);
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.assistantType).toBe("goal");

		const newId = sessions.add(data.id as string);
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
		trackGoal(goal.id);
		const sessionResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), goalId: goal.id }),
		});
		expect(sessionResp.status).toBe(201);
		const sid = sessions.add((await sessionResp.json()).id as string);
		await archive(sid);

		const cont = await continueArchived(sid);
		expect(cont.status).toBe(422);
	});

	test("delegate session is still rejected with 422 (regression guard)", async () => {
		const parentId = sessions.add(await createSessionFromHarness());
		const delegateId = sessions.add(await createSessionFromHarness());
		const patch = await apiFetch(`/api/sessions/${delegateId}`, {
			method: "PATCH",
			body: JSON.stringify({ delegateOf: parentId }),
		});
		expect(patch.ok).toBe(true);
		await archive(delegateId);

		const resp = await continueArchived(delegateId);
		expect(resp.status).toBe(422);
		await archive(parentId).catch(() => {});
	});
});
