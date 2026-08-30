import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type GatewayInfo } from "../../../tests2/browser/gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	defaultProject,
	deleteGoal,
	deleteSession,
	waitForHealth,
	waitForSessionStatus,
} from "../../../tests2/browser/e2e-setup.js";

type BootMetrics = {
	wallMs: number;
	preListenMs?: number;
	reconciliationPhaseMs?: number;
	restoredRegular: number;
	restoredDelegates: number;
};

type Health = {
	status?: string;
	sessions?: number;
	orphanedTranscripts?: number;
};

function logMessage(line: string): string {
	return line.replace(/^\S+ \[(?:log|warn|error)\] /, "");
}

function requireLog(lines: string[], pattern: RegExp, label: string): { line: string; match: RegExpMatchArray } {
	for (const raw of lines) {
		const line = logMessage(raw);
		const match = line.match(pattern);
		if (match) return { line, match };
	}
	throw new Error(`${label} log missing:\n${lines.join("\n")}`);
}

function optionalDuration(lines: string[], phase: string): number | undefined {
	const escaped = phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const raw of lines) {
		const match = logMessage(raw).match(new RegExp(`\\[boot\\] pre-listen ${escaped} in (\\d+)ms`));
		if (match) return Number(match[1]);
	}
	return undefined;
}

function parseBootMetrics(lines: string[], wallMs: number): BootMetrics {
	const restore = requireLog(
		lines,
		/\[session-manager\] Restoring (\d+) session\(s\) \+ (\d+) delegate\(s\) live\.\.\./,
		"session restore count",
	).match;
	const preListen = requireLog(
		lines,
		/\[boot\] pre-listen phases complete in (\d+)ms/,
		"pre-listen timing",
	).match;
	return {
		wallMs,
		preListenMs: Number(preListen[1]),
		reconciliationPhaseMs: optionalDuration(lines, "reconcile-archived-team-ownership"),
		restoredRegular: Number(restore[1]),
		restoredDelegates: Number(restore[2]),
	};
}

async function readHealth(): Promise<Health> {
	const response = await apiFetch("/api/health");
	const text = await response.text();
	expect(response.status, `health: ${text}`).toBe(200);
	return JSON.parse(text) as Health;
}

async function restartAndMeasure(
	gateway: GatewayInfo,
	markOnline: (online: boolean) => void,
): Promise<{ logs: string[]; wallMs: number }> {
	await gateway.crash();
	markOnline(false);
	const logStart = gateway.logs.ring.length;
	const startedAt = Date.now();
	await gateway.restart();
	markOnline(true);
	await waitForHealth(20_000);
	return { logs: gateway.logs.ring.slice(logStart), wallMs: Date.now() - startedAt };
}

function teamStatePath(projectRoot: string): string {
	return join(projectRoot, ".bobbit", "state", "team-state.json");
}

function readTeamState(file: string): Array<{ goalId?: string }> {
	return JSON.parse(readFileSync(file, "utf8")) as Array<{ goalId?: string }>;
}

test.describe.serial("archived team ownership hard-restart reconciliation", () => {
	test("repairs leaked team sessions before dispatch and is write-idempotent on the second boot", async ({ gateway }) => {
		test.setTimeout(120_000);
		const project = await defaultProject();
		const goal = await createGoal({
			title: `Archived team restart repair ${Date.now()}`,
			projectId: project.id,
			team: true,
			autoStartTeam: false,
			worktree: false,
			spec: "Restart E2E fixture for an archived goal whose durable team-owned sessions survived the archive publication crash window.",
		});
		const goalId = goal.id as string;
		const leadId = await createSession({ projectId: project.id, goalId });
		const workerId = await createSession({ projectId: project.id, goalId });
		// Negative control: goalId alone is not team ownership. It deliberately
		// points at the same archived goal and must still restore eagerly.
		const controlId = await createSession({ projectId: project.id, goalId });
		// This row is structurally a child of that goal-only control, but its exact
		// teamGoalId stamp is independently authoritative durable ownership.
		const matchingChildId = await createSession({ projectId: project.id, goalId });
		const leakedIds = [leadId, workerId, matchingChildId];
		let serverOnline = true;

		const bridgeModule = await import("../../../tests/e2e/in-process-mock-bridge.mjs");
		const bridgePrototype = bridgeModule.InProcessMockBridge.prototype as {
			start: (this: { options?: { env?: Record<string, string> } }) => Promise<void>;
		};
		const originalBridgeStart = bridgePrototype.start;
		const startedSessionIds: string[] = [];
		bridgePrototype.start = async function trackedStart() {
			const sessionId = this.options?.env?.BOBBIT_SESSION_ID;
			if (sessionId) startedSessionIds.push(sessionId);
			return originalBridgeStart.call(this);
		};

		try {
			await Promise.all([
				waitForSessionStatus(leadId, "idle", 20_000),
				waitForSessionStatus(workerId, "idle", 20_000),
				waitForSessionStatus(controlId, "idle", 20_000),
				waitForSessionStatus(matchingChildId, "idle", 20_000),
			]);

			const sessionManager = gateway.sessionManager;
			const contextManager = sessionManager?.getProjectContextManager?.();
			const context = contextManager?.getContextForGoal(goalId);
			expect(context, "goal must resolve to its project context").toBeTruthy();

			// Seed the exact crash window: session/team ownership remains live, then
			// the archived goal bit becomes durable without invoking GoalManager's
			// post-archive reconciliation callback.
			expect(sessionManager.updateSessionMeta(leadId, {
				role: "team-lead",
				teamGoalId: goalId,
			})).toBe(true);
			expect(sessionManager.updateSessionMeta(workerId, {
				role: "coder",
				teamGoalId: goalId,
				teamLeadSessionId: leadId,
			})).toBe(true);
			expect(sessionManager.updateSessionMeta(matchingChildId, {
				delegateOf: controlId,
				teamGoalId: goalId,
			})).toBe(true);
			context.teamStore.put({
				goalId,
				teamLeadSessionId: leadId,
				agents: [{
					sessionId: workerId,
					role: "coder",
					kind: "worker",
					task: "Persist across the simulated crash window.",
					createdAt: Date.now(),
				}],
				maxConcurrent: 1,
			});
			const persistedGoal = context.goalStore.get(goalId);
			expect(persistedGoal).toBeTruthy();
			const archivedAt = Date.now();
			context.goalStore.put({
				...persistedGoal,
				archived: true,
				archivedAt,
				updatedAt: archivedAt,
			});
			await context.goalStore.flush();
			await context.sessionStore.flushAsync();

			const stateFile = teamStatePath(project.rootPath);
			expect(readTeamState(stateFile).some((entry) => entry.goalId === goalId)).toBe(true);
			for (const id of leakedIds) {
				expect(sessionManager.getPersistedSession(id)?.archived).not.toBe(true);
			}

			startedSessionIds.length = 0;
			const firstBoot = await restartAndMeasure(gateway, (online) => { serverOnline = online; });
			const firstMetrics = parseBootMetrics(firstBoot.logs, firstBoot.wallMs);
			const repair = requireLog(
				firstBoot.logs,
				/\[team-manager\] Boot archived-team repair: goals=(\d+) sessionsArchived=(\d+) teamsRemoved=(\d+) blocked=(\d+) suppressed=(\d+) errors=(\d+)/,
				"archived-team repair summary",
			);
			expect(repair.match.slice(1).map(Number)).toEqual([1, 3, 1, 0, 0, 0]);
			expect(firstMetrics.restoredRegular).toBe(1);
			expect(firstMetrics.restoredDelegates).toBe(0);
			expect(startedSessionIds).toContain(controlId);
			for (const id of leakedIds) expect(startedSessionIds).not.toContain(id);

			const repairLogIndex = firstBoot.logs.indexOf(repair.line) >= 0
				? firstBoot.logs.indexOf(repair.line)
				: firstBoot.logs.findIndex((line) => logMessage(line) === repair.line);
			const restoreLogIndex = firstBoot.logs.findIndex((line) => logMessage(line).includes("[session-manager] Restoring 1 session(s) + 0 delegate(s) live..."));
			const subscribeLogIndex = firstBoot.logs.findIndex((line) => logMessage(line).includes("[team-manager] Re-subscribed to events for 0 team(s)"));
			expect(repairLogIndex, "repair completes before restore dispatch").toBeGreaterThanOrEqual(0);
			expect(restoreLogIndex).toBeGreaterThan(repairLogIndex);
			expect(subscribeLogIndex, "archived team entry is absent before event subscription").toBeGreaterThan(restoreLogIndex);

			const repairedTeamState = readFileSync(stateFile, "utf8");
			expect(readTeamState(stateFile).some((entry) => entry.goalId === goalId)).toBe(false);
			expect((gateway.teamManager as any).teams.has(goalId)).toBe(false);
			for (const id of leakedIds) {
				expect(gateway.sessionManager?.getSession(id), `${id} must not have a live process`).toBeUndefined();
				expect(gateway.sessionManager?.getPersistedSession(id)?.archived).toBe(true);
			}
			expect(gateway.sessionManager?.getSession(controlId), "goalId-only control restores eagerly").toBeTruthy();
			expect(gateway.sessionManager?.getPersistedSession(controlId)?.archived).not.toBe(true);
			expect(await readHealth()).toMatchObject({ status: "ok", orphanedTranscripts: 0 });

			const archivedSnapshot = leakedIds.map((id) => {
				const row = gateway.sessionManager?.getPersistedSession(id);
				return { id: row?.id, archived: row?.archived, archivedAt: row?.archivedAt };
			});
			const teamStateMtime = statSync(stateFile).mtimeMs;
			startedSessionIds.length = 0;
			const secondBoot = await restartAndMeasure(gateway, (online) => { serverOnline = online; });
			const secondMetrics = parseBootMetrics(secondBoot.logs, secondBoot.wallMs);

			expect(
				secondBoot.logs.some((line) => logMessage(line).includes("Boot archived-team repair:")),
				"clean second boot must not enter or log reconciliation work",
			).toBe(false);
			expect(secondMetrics.restoredRegular).toBe(1);
			expect(secondMetrics.restoredDelegates).toBe(0);
			expect(startedSessionIds).toContain(controlId);
			for (const id of leakedIds) expect(startedSessionIds).not.toContain(id);
			expect(readFileSync(stateFile, "utf8")).toBe(repairedTeamState);
			expect(statSync(stateFile).mtimeMs, "clean boot performs no TeamStore write").toBe(teamStateMtime);
			expect(leakedIds.map((id) => {
				const row = gateway.sessionManager?.getPersistedSession(id);
				return { id: row?.id, archived: row?.archived, archivedAt: row?.archivedAt };
			})).toEqual(archivedSnapshot);
			expect(gateway.sessionManager?.getSession(controlId)).toBeTruthy();
			expect(await readHealth()).toMatchObject({ status: "ok", orphanedTranscripts: 0 });

			// Phase timing is threshold-logged only when it reaches 50 ms, so the
			// deterministic comparison always exposes wall/pre-listen timings and
			// includes the reconciliation phase only when the server emitted it.
			console.log(`[archived-team-restart-e2e] ${JSON.stringify({
				firstRepairBoot: firstMetrics,
				secondCleanBoot: secondMetrics,
			})}`);
			expect(firstMetrics.wallMs).toBeGreaterThanOrEqual(firstMetrics.preListenMs ?? 0);
			expect(secondMetrics.wallMs).toBeGreaterThanOrEqual(secondMetrics.preListenMs ?? 0);
		} finally {
			bridgePrototype.start = originalBridgeStart;
			if (!serverOnline) {
				await gateway.restart().then(() => waitForHealth(20_000)).catch(() => undefined);
			}
			await deleteSession(matchingChildId).catch(() => undefined);
			await deleteSession(controlId).catch(() => undefined);
			await deleteSession(workerId).catch(() => undefined);
			await deleteSession(leadId).catch(() => undefined);
			await deleteGoal(goalId, true).catch(() => undefined);
		}
	});
});
