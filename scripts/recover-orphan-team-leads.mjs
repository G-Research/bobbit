#!/usr/bin/env node
/**
 * Recover team-lead sessions whose session record was destroyed but whose
 * agent .jsonl transcript survives on disk.
 *
 * Background: the user's "Audit subgoals branch" and "Extract generic fixes"
 * team-lead sessions disappeared from sessions.json — but the .jsonl files
 * remain in `~/.bobbit/agent/sessions/<slug-dir>/` (the slug-dir is derived
 * from the worktree path, NOT the bobbit session id, so the .jsonl survives
 * any session-id-keyed cleanup). The bobbit session id and the agent
 * session id printed inside the .jsonl are different — that's why a naive
 * search by bobbit session id finds nothing.
 *
 * What this script does:
 *
 *   1. Loads .bobbit/state/{team-state, sessions, goals}.json.
 *   2. For each team-store entry whose `teamLeadSessionId` is NOT in
 *      sessions.json, finds the team-lead's worktree slug-dir and picks the
 *      canonical .jsonl (largest + most recently appended, where the first
 *      line's `cwd` matches `goal.worktreePath`). This filters out any
 *      stale/abandoned .jsonl files in the same dir.
 *   3. Reconstructs a fresh `PersistedSession` row pointing at that .jsonl,
 *      with metadata derived from the goal record, the team-store entry,
 *      and the .jsonl itself.
 *   4. Writes the new entries back to sessions.json. A timestamped backup of
 *      the original is written next to it.
 *
 * Idempotent — running a second time is a no-op (the team-store entries are
 * no longer orphaned). Pass --dry-run to preview without writing.
 *
 * Usage:
 *   node scripts/recover-orphan-team-leads.mjs              # write
 *   node scripts/recover-orphan-team-leads.mjs --dry-run    # preview only
 *
 * Run from your project's root (the dir that contains `.bobbit/state/`).
 * Restart bobbit afterwards — TeamManager.restoreTeams will see the team-lead
 * session record and SessionManager will restore the agent process from the
 * .jsonl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const STATE = path.resolve(".bobbit/state");
const TEAMS_FILE = path.join(STATE, "team-state.json");
const SESSIONS_FILE = path.join(STATE, "sessions.json");
const GOALS_FILE = path.join(STATE, "goals.json");
const AGENT_SESSIONS = path.join(os.homedir(), ".bobbit", "agent", "sessions");

function loadJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/**
 * Slug-dir name from a cwd: replace path separators with `-` and wrap with `--`.
 * Mirrors the pi-coding-agent slug derivation used at agent-session-path.ts.
 */
function slugDirForCwd(cwd) {
	return "--" + cwd.replace(/^\/+/, "").replace(/\//g, "-") + "--";
}

/**
 * Read the first line of a .jsonl to get the session-start record.
 * Returns null on malformed files.
 */
function readFirstLine(jsonlPath) {
	const buf = fs.readFileSync(jsonlPath, { encoding: "utf-8" });
	const firstNl = buf.indexOf("\n");
	const line = firstNl === -1 ? buf : buf.slice(0, firstNl);
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/**
 * For a given team-lead session id + owning goal, find the canonical .jsonl
 * in the team-lead's worktree slug-dir. Picks the largest file whose first
 * line has a `cwd` matching the goal's worktreePath. Ties broken by mtime.
 * Returns { jsonlPath, agentSessionId, agentStartedAt, lastAppendedAt } or null.
 */
function findCanonicalJsonl(goal) {
	if (!goal.worktreePath) return null;
	const slug = slugDirForCwd(goal.worktreePath);
	const dir = path.join(AGENT_SESSIONS, slug);
	if (!fs.existsSync(dir)) return null;
	const candidates = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".jsonl")) continue;
		const full = path.join(dir, f);
		let st;
		try { st = fs.statSync(full); } catch { continue; }
		const first = readFirstLine(full);
		if (!first || first.type !== "session" || first.cwd !== goal.worktreePath) continue;
		candidates.push({
			path: full,
			size: st.size,
			mtime: st.mtime.getTime(),
			agentSessionId: first.id,
			agentStartedAt: first.timestamp,
		});
	}
	if (candidates.length === 0) return null;
	// Most-recent mtime wins — that's the file that was actively being
	// appended to when the session disappeared. Size is the tiebreaker.
	// Initially we sorted size-first, but that broke for the "Extract
	// generic fixes" case where a short-lived sibling .jsonl from a later
	// failed-restart attempt was bigger than the team-lead's actually-
	// canonical file. mtime correctly picks the longest-lived ongoing
	// transcript in both shapes.
	candidates.sort((a, b) => (b.mtime - a.mtime) || (b.size - a.size));
	const chosen = candidates[0];
	return {
		jsonlPath: chosen.path,
		agentSessionId: chosen.agentSessionId,
		agentStartedAt: chosen.agentStartedAt,
		lastAppendedAt: chosen.mtime,
		candidatesConsidered: candidates.length,
	};
}

/**
 * Best-effort model lookup from the surviving model-name-<sessionId>.txt
 * file. Format on disk is "provider/modelId" or similar (we tolerate either
 * "anthropic/claude-…" or just "claude-…"). Defaults to anthropic + opus 4.7.
 */
function readModelName(sessionId) {
	const p = path.join(STATE, `model-name-${sessionId}.txt`);
	if (!fs.existsSync(p)) return { modelProvider: "anthropic", modelId: "claude-opus-4-7" };
	const raw = fs.readFileSync(p, "utf-8").trim();
	if (!raw) return { modelProvider: "anthropic", modelId: "claude-opus-4-7" };
	if (raw.includes("/")) {
		const [provider, ...rest] = raw.split("/");
		return { modelProvider: provider, modelId: rest.join("/") };
	}
	return { modelProvider: "anthropic", modelId: raw };
}

function reconstructSession(teamLeadSessionId, goal, recovered) {
	const { modelProvider, modelId } = readModelName(teamLeadSessionId);
	// Title: bobbit usually generates "Team Lead: <fun-name>" at start. The
	// fun name isn't in any surviving file, so we use the goal title as a
	// recovery placeholder. The user can rename via the UI.
	const title = `Team Lead: ${goal.title || "(recovered)"} (recovered)`;
	return {
		id: teamLeadSessionId,
		title,
		cwd: goal.worktreePath,
		projectId: goal.projectId,
		status: "idle",
		createdAt: new Date(recovered.agentStartedAt).getTime(),
		lastActivity: recovered.lastAppendedAt,
		clientCount: 0,
		goalId: undefined,
		role: "team-lead",
		teamGoalId: goal.id,
		teamLeadSessionId: undefined,
		worktreePath: goal.worktreePath,
		repoPath: goal.repoPath,
		branch: goal.branch,
		agentSessionFile: recovered.jsonlPath,
		modelProvider,
		modelId,
		sandboxed: !!goal.sandboxed,
		accessory: "crown",
		archived: false,
	};
}

function main() {
	if (!fs.existsSync(TEAMS_FILE) || !fs.existsSync(SESSIONS_FILE) || !fs.existsSync(GOALS_FILE)) {
		console.error("Missing one of team-state.json / sessions.json / goals.json under .bobbit/state.");
		console.error("Run from your project root.");
		process.exit(1);
	}
	const teams = loadJson(TEAMS_FILE);
	const sessions = loadJson(SESSIONS_FILE);
	const goals = loadJson(GOALS_FILE);
	const sessionIds = new Set(sessions.map((s) => s.id));

	console.log(`Loaded ${teams.length} teams, ${sessions.length} sessions, ${goals.length} goals.`);
	console.log(`Looking for team-store entries with a missing team-lead session…\n`);

	const recoveries = [];
	for (const t of teams) {
		if (!t.teamLeadSessionId) continue;
		if (sessionIds.has(t.teamLeadSessionId)) continue;
		const goal = goals.find((g) => g.id === t.goalId);
		if (!goal) {
			console.warn(`  [skip] team-store entry for unknown goal ${t.goalId} — let the boot sweep drop it.`);
			continue;
		}
		const recovered = findCanonicalJsonl(goal);
		if (!recovered) {
			console.warn(`  [skip] "${goal.title}" (${goal.id.slice(0, 8)}): no .jsonl found in slug-dir for worktree "${goal.worktreePath}".`);
			continue;
		}
		console.log(`  [recover] "${goal.title}" (${goal.id.slice(0, 8)})`);
		console.log(`            team-lead session id : ${t.teamLeadSessionId}`);
		console.log(`            agent session id     : ${recovered.agentSessionId}`);
		console.log(`            .jsonl               : ${recovered.jsonlPath}`);
		console.log(`            considered ${recovered.candidatesConsidered} candidate .jsonl(s) in slug-dir`);
		const reconstructed = reconstructSession(t.teamLeadSessionId, goal, recovered);
		recoveries.push(reconstructed);
	}

	if (recoveries.length === 0) {
		console.log("\nNothing to recover.");
		return;
	}

	if (DRY) {
		console.log(`\nDRY RUN — would write ${recoveries.length} session record(s) to ${SESSIONS_FILE}.`);
		console.log("Re-run without --dry-run to apply.");
		return;
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${SESSIONS_FILE}.recovery-backup-${stamp}.json`;
	fs.copyFileSync(SESSIONS_FILE, backupPath);
	console.log(`\nBackup written to ${backupPath}`);

	const updated = [...sessions, ...recoveries];
	fs.writeFileSync(SESSIONS_FILE, JSON.stringify(updated, null, 2), "utf-8");
	console.log(`Wrote ${recoveries.length} recovered session(s) to ${SESSIONS_FILE}.`);
	console.log("\nNext step: restart bobbit. The team-leads will reappear in the sidebar with their full history.");
}

main();
