import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { basename, dirname, join } from "node:path";
import { awaitableRm } from "../../../tests/e2e/test-utils/cleanup.js";
import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd, registerProject } from "../../../tests2/integration/_e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../../../tests2/harness/server-runtime.js";
import { createCommandSpawnAdapter } from "../../../src/server/owned-tree-command-spawn.js";

let serverModule: any;
let forceRequestedAt = 1_000;
type PersistenceMode = "sqlite" | "json" | undefined;
interface MutableProjectPersistenceOptions {
	goalPersistence?: PersistenceMode;
	taskPersistence?: PersistenceMode;
	gatePersistence?: PersistenceMode;
}
let projectPersistenceOptions: MutableProjectPersistenceOptions | undefined;
let previousPersistence: MutableProjectPersistenceOptions | undefined;

function deterministicGitStatus(opts?: { untracked?: boolean }) {
	return {
		branch: "main",
		primaryBranch: "main",
		primaryRef: "refs/heads/main",
		isOnPrimary: true,
		status: [],
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: true,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: false,
		partial: false,
		untrackedIncluded: opts?.untracked === true,
	};
}

function crossForceCoalescingWindow(): void {
	forceRequestedAt += 251;
}

function unexpectedRunnerCommand(file: string, args: readonly string[], options?: any): never {
	throw new Error(`unexpected route command: ${commandName(file)} ${args.join(" ")} (cwd=${String(options?.cwd ?? "")})`);
}

function standardSingleRepositoryProbe(
	file: string,
	args: readonly string[],
	repositoryRoot: string,
): { stdout: string; stderr: string } | undefined {
	if (commandName(file) !== "git") return undefined;
	const command = args.join(" ");
	if (command === "rev-parse --show-toplevel") return { stdout: `${repositoryRoot}\n`, stderr: "" };
	if (command === "rev-parse --path-format=absolute --git-common-dir" || command === "rev-parse --git-common-dir") {
		return { stdout: `${join(repositoryRoot, ".git")}\n`, stderr: "" };
	}
	if (command === "rev-parse --git-dir") return { stdout: ".git\n", stderr: "" };
	if (command === "symbolic-ref --quiet --short HEAD") return { stdout: "fixture/route-head\n", stderr: "" };
	if (args[0] === "check-ref-format" && args[1] === "--branch" && typeof args[2] === "string") {
		if (/^[\-]|[\u0000-\u001f\u007f]|:\/\//.test(args[2])) throw new Error("invalid fixture branch");
		return { stdout: `${args[2]}\n`, stderr: "" };
	}
	return undefined;
}

function commandName(file: string): string {
	return basename(file).toLowerCase().replace(/\.(?:cmd|exe)$/, "");
}

function credentialHelperResult(output: string): any {
	const child: any = new EventEmitter();
	child.stdout = new PassThrough();
	child.stdin = new PassThrough();
	child.kill = () => { throw new Error("credential route fixture must use owned-tree control"); };
	setImmediate(() => {
		child.stdout.end(output);
		child.emit("close", 0, null);
	});
	return {
		child,
		ownershipReady: Promise.resolve(),
		killTree: () => {},
		waitForTreeExit: async () => true,
		killed: () => false,
		timedOut: () => false,
	};
}

function ownedHeadEvidence(owner: string, repository: string): Record<string, unknown> {
	return {
		headRepository: { name: repository },
		headRepositoryOwner: { login: owner },
		isCrossRepository: false,
	};
}

function ownedHeadEvidenceForSlug(slug: string): Record<string, unknown> {
	const [owner, repository, extra] = slug.split("/");
	if (!owner || !repository || extra) throw new Error(`invalid test repository slug: ${slug}`);
	return ownedHeadEvidence(owner, repository);
}

async function createRemoteStateSession(gateway: any, cwd: string, requestedProjectId?: string): Promise<string> {
	const projectId = requestedProjectId ?? await defaultProjectId();
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	const body = await response.json().catch(() => ({})) as Record<string, unknown>;
	expect(response.status, `remote-state fixture session creation failed: ${JSON.stringify(body)}`).toBe(201);
	expect(body.id).toEqual(expect.any(String));
	const sessionId = String(body.id);
	// Route fixtures must stay on the exact supplied repository/worktree. The
	// ordinary helper permits asynchronous session worktree provisioning, which
	// can finish (or fail and remove the live session) halfway through a slow
	// Windows run and turn later route reads into unrelated 404s.
	expect(gateway.sessionManager.getSession(sessionId)).toMatchObject({
		id: sessionId,
		cwd,
		status: "idle",
	});
	expect(gateway.sessionManager.getSession(sessionId)?.worktreePath).toBeUndefined();
	return sessionId;
}

async function removeSiblingWorktree(runner: any, primary: string, sibling: string): Promise<void> {
	// Windows can briefly retain handles after the session and websocket close.
	// Remove the filesystem tree with the shared bounded retry policy, then prune
	// Git's administrative entry and prove that both halves of teardown settled.
	const cleanup = await awaitableRm(sibling, { maxAttempts: 5, backoffMs: 50 });
	expect(cleanup.removed, `sibling worktree cleanup failed after ${cleanup.attempts} attempts: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
	await runner.execFile("git", ["worktree", "prune", "--expire", "now"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listed = await runner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listedPaths = String(listed.stdout)
		.split(/\r?\n/)
		.filter((line: string) => line.startsWith("worktree "))
		.map((line: string) => line.slice("worktree ".length).replaceAll("\\", "/").toLowerCase());
	expect(listedPaths).not.toContain(sibling.replaceAll("\\", "/").toLowerCase());
}

/**
 * Route-level proof that the coordinator is the only remote-read authority.
 * The runner fixture has no network access: GitHub-shaped responses are local
 * and the only observed fetch is the injected command below.
 */
test.describe("remote-state coordinator routes", () => {
	test.beforeAll(async ({ gateway }) => {
		// This route suite creates four temporary real-filesystem projects but does
		// not test store persistence. Keep those lazy contexts on the existing JSON
		// fixture seam; native SQLite ownership is covered by the focused store/E2E
		// suites and otherwise adds synchronous handles to the tier-1 route budget.
		projectPersistenceOptions = (gateway.projectContextManager as { options: MutableProjectPersistenceOptions }).options;
		previousPersistence = {
			goalPersistence: projectPersistenceOptions.goalPersistence,
			taskPersistence: projectPersistenceOptions.taskPersistence,
			gatePersistence: projectPersistenceOptions.gatePersistence,
		};
		projectPersistenceOptions.goalPersistence = "json";
		projectPersistenceOptions.taskPersistence = "json";
		projectPersistenceOptions.gatePersistence = "json";

		serverModule = (await loadServerTestRuntime()).server;
		expect(typeof serverModule.__setGitStatusFake).toBe("function");
		expect(typeof serverModule.__clearGitStatusFake).toBe("function");
		expect(typeof serverModule.__setRemoteStateForceNowFake).toBe("function");
		expect(typeof serverModule.__clearRemoteStateForceNowFake).toBe("function");
	});

	test.afterAll(() => {
		if (!projectPersistenceOptions || !previousPersistence) return;
		projectPersistenceOptions.goalPersistence = previousPersistence.goalPersistence;
		projectPersistenceOptions.taskPersistence = previousPersistence.taskPersistence;
		projectPersistenceOptions.gatePersistence = previousPersistence.gatePersistence;
	});

	test.beforeEach(() => {
		forceRequestedAt = 1_000;
		serverModule.__setRemoteStateForceNowFake(() => forceRequestedAt);
		serverModule.__setGitStatusFake(async (_cwd: string, _containerId?: string, opts?: { untracked?: boolean }) => deterministicGitStatus(opts));
	});

	test.afterEach(() => {
		serverModule.__clearGitStatusFake();
		serverModule.__clearRemoteStateForceNowFake();
	});

	test("trusts a gh-config-only enterprise host for status, permissions, merge, and trust checks", async ({ gateway }) => {
		test.setTimeout(30_000);
		const host = "ghe.config-only.test";
		const unknownHost = "unknown.config-only.test";
		const ghConfigDir = realpathSync(mkdtempSync(join(nonGitCwd(), "gh-config-")));
		writeFileSync(join(ghConfigDir, "hosts.yml"), `${host}:\n    user: route-fixture\n`, "utf8");
		const previousGhConfigDir = process.env.GH_CONFIG_DIR;
		process.env.GH_CONFIG_DIR = ghConfigDir;
		const branch = `fixture/gh-config-host-${Date.now()}`;
		let sessionId: string | undefined;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let remoteHost = host;
		let discoveryCalls = 0;
		const remoteGhCalls: string[][] = [];
		let originalTrustedHosts: unknown = [];

		try {
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					return { stdout: `https://${remoteHost}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh" && args[0] === "auth" && args[1] === "status") {
					discoveryCalls += 1;
					return unexpectedRunnerCommand(file, args, options);
				}
				if (command === "gh") {
					remoteGhCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 74,
								url: `https://${host}/acme/widget/pull/74`,
								title: "Configured enterprise host",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") {
						return {
							stdout: JSON.stringify({ data: { repository: { viewerPermission: "ADMIN", pullRequest: { viewerCanMergeAsAdmin: true } } } }),
							stderr: "",
						};
					}
					if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				}
				const probe = standardSingleRepositoryProbe(file, args, gitCwd());
				if (probe) return probe;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			// The fork-scoped gateway may have cached discovery from an earlier
			// integration file. Cross the short resolver TTL deterministically.
			gateway.clock.advance(60_000);

			const trustedCheck = await apiFetch(`/api/github/trusted-hosts/check?host=${host.toUpperCase()}.`);
			expect(trustedCheck.status).toBe(200);
			expect(await trustedCheck.json()).toEqual({ host, trusted: true });
			const unknownCheck = await apiFetch(`/api/github/trusted-hosts/check?host=${unknownHost}`);
			expect(await unknownCheck.json()).toEqual({ host: unknownHost, trusted: false });
			expect((await apiFetch("/api/github/trusted-hosts/check?host=https%3A%2F%2Fevil.test%2Fpath")).status).toBe(400);

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({ data: { number: 74, title: "Configured enterprise host", viewerIsAdmin: true, viewerCanMergeAsAdmin: true } });

			const merge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch }),
			});
			expect(merge.status).toBe(200);
			expect(discoveryCalls).toBe(0);
			expect(remoteGhCalls.find(args => args[0] === "pr" && args[1] === "list")?.slice(0, 4)).toEqual([
				"pr", "list", "--repo", `${host}/acme/widget`,
			]);
			const permissionCalls = remoteGhCalls.filter(args => args[0] === "api");
			expect(permissionCalls.length).toBeGreaterThan(0);
			expect(permissionCalls.every(args => args[1] === "--hostname" && args[2] === host)).toBe(true);
			expect(remoteGhCalls.find(args => args[0] === "pr" && args[1] === "merge")?.slice(0, 5)).toEqual([
				"pr", "merge", "74", "--repo", `${host}/acme/widget`,
			]);

			remoteHost = unknownHost;
			const callsBeforeUnknown = remoteGhCalls.length;
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`)).status).toBe(204);
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch }),
			})).status).toBe(409);
			expect(remoteGhCalls).toHaveLength(callsBeforeUnknown);
		} finally {
			runner.execFile = originalExecFile;
			if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
			else process.env.GH_CONFIG_DIR = previousGhConfigDir;
			// Expire the fixture discovery so its host cannot bleed into the next test.
			gateway.clock.advance(60_000);
			try {
				if (sessionId) await deleteSession(sessionId);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
				const cleanup = await awaitableRm(ghConfigDir, { maxAttempts: 5, backoffMs: 50 });
				expect(cleanup.removed, `GH_CONFIG_DIR fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
			}
		}
	});

	test("admits only credential-vouched unlisted enterprise hosts to exact-bound PR lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const vouchedHost = `credential-vouched-${Date.now()}.invalid`;
		const unvouchedHost = `credential-unvouched-${Date.now()}.invalid`;
		const branch = `fixture/credential-vouched-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		let remoteHost = vouchedHost;
		let sessionId: string | undefined;
		let goalId: string | undefined;
		let originalTrustedHosts: unknown = [];
		const ghCalls: string[][] = [];
		const probes: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; request: string }> = [];

		try {
			// The production trust object reads the environment at admission time. Clear
			// host-class ambient tokens for this fixture only, then restore them exactly.
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });
			const goal = await createGoal({
				title: `credential trust merge boundary ${Date.now()}`,
				cwd: gitCwd(),
				worktree: false,
				autoStartTeam: false,
			});
			goalId = String(goal.id);
			if (typeof goal.projectId !== "string") throw new Error("fixture goal project unavailable");
			gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
				cwd: gitCwd(),
				repoPath: gitCwd(),
				worktreePath: gitCwd(),
				branch,
				setupStatus: "ready",
			});

			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential fixture received an ordinary spawn"); },
				((file: string, args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(remoteHost === vouchedHost
						? `protocol=https\nhost=${vouchedHost}\nusername=route-fixture\npassword=fixture-secret\n`
						: `protocol=https\nhost=${unvouchedHost}\nusername=route-fixture\n`);
					const probe = {
						file: commandName(file),
						args: [...args],
						cwd: String(options?.cwd ?? ""),
						env: options?.env ?? {},
						request: "",
					};
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					return { stdout: `https://${remoteHost}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 91,
								url: `https://${vouchedHost}/acme/widget/pull/91`,
								title: "Credential-vouched enterprise host",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") throw new Error("fixture GraphQL unavailable");
					if (args[0] === "repo" && args[1] === "view") {
						return { stdout: JSON.stringify({ viewerPermission: "ADMIN" }), stderr: "" };
					}
				}
				const standard = standardSingleRepositoryProbe(file, args, gitCwd());
				if (standard) return standard;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			gateway.clock.advance(60_000);
			expect(await (await apiFetch(`/api/github/trusted-hosts/check?host=${vouchedHost}`)).json())
				.toEqual({ host: vouchedHost, trusted: false });

			const vouched = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(vouched.status).toBe(200);
			expect(await vouched.json()).toMatchObject({
				source: "pr",
				stale: false,
				data: { number: 91, viewerIsAdmin: true },
			});
			expect(ghCalls.find(args => args[0] === "pr" && args[1] === "list")?.slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${vouchedHost}/acme/widget`, "--head", branch,
			]);
			expect(ghCalls.filter(args => args[0] === "api").every(args => (
				args[1] === "--hostname" && args[2] === vouchedHost
			))).toBe(true);
			expect(ghCalls.find(args => args[0] === "repo" && args[1] === "view")).toEqual([
				"repo", "view", "--repo", `${vouchedHost}/acme/widget`, "--json", "viewerPermission",
			]);
			expect(probes).toHaveLength(1);
			expect(probes[0]).toMatchObject({
				file: "git",
				args: ["credential", "fill"],
				request: `url=https://${vouchedHost}\n\n`,
			});
			expect(probes[0].cwd).not.toBe(gitCwd());
			expect(probes[0].cwd.startsWith(tmpdir())).toBe(true);
			expect(probes[0].env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(probes[0].env.GCM_INTERACTIVE).toBe("never");

			crossForceCoalescingWindow();
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`)).status).toBe(200);
			expect(probes).toHaveLength(1);

			// Credential-derived trust is status-only. Both destructive routes must use
			// listed-host admission and fail before another probe or any gh operation.
			const probesBeforeMerge = probes.length;
			const ghCallsBeforeMerge = ghCalls.length;
			for (const mergeUrl of [
				`/api/sessions/${sessionId}/pr-merge`,
				`/api/goals/${goalId}/pr-merge`,
			]) {
				const merge = await apiFetch(mergeUrl, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch }),
				});
				expect(merge.status, mergeUrl).toBe(409);
				expect(await merge.json()).toEqual({ error: "PR repository unavailable" });
			}
			expect(probes).toHaveLength(probesBeforeMerge);
			expect(ghCalls).toHaveLength(ghCallsBeforeMerge);

			remoteHost = unvouchedHost;
			const ghCallsBeforeUnvouched = ghCalls.length;
			const unavailable = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(unavailable.status).toBe(204);
			expect(probes).toHaveLength(2);
			expect(probes[1].request).toBe(`url=https://${unvouchedHost}\n\n`);
			expect(ghCalls).toHaveLength(ghCallsBeforeUnvouched);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			gateway.clock.advance(60_000);
			try {
				await Promise.all([
					sessionId ? deleteSession(sessionId) : Promise.resolve(),
					goalId ? deleteGoal(goalId) : Promise.resolve(),
				]);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
			}
		}
	});

	test("serializes staggered explicit credential refreshes before exact-bound PR lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const host = `credential-serialized-${Date.now()}.invalid`;
		const branch = `fixture/credential-serialized-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		let sessionId: string | undefined;
		let originalTrustedHosts: unknown = [];
		let activeTrees = 0;
		let maxActiveTrees = 0;
		let remoteReads = 0;
		const ghCalls: string[][] = [];
		const probes: Array<{
			request: string;
			complete: (trusted: boolean) => void;
		}> = [];
		const routeRequests: Array<Promise<Response>> = [];
		// Bound each phase-aware wait by wall time: yielding through both the check
		// phase and the timers phase lets queued I/O progress under full CI load.
		// Four 2-second ceilings cap aggregate waiting at eight seconds, so these
		// waits cannot consume the integration file's entire 25-second budget.
		// Keep the final assertion exact.
		const waitForCount = async (read: () => number, expected: number) => {
			const deadline = Date.now() + 2_000;
			while (read() < expected && Date.now() < deadline) {
				await new Promise<void>(resolve => setImmediate(resolve));
				if (read() >= expected) break;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			expect(read()).toBe(expected);
		};

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });

			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential serialization fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[]) => {
					const child: any = new EventEmitter();
					child.stdout = new PassThrough();
					child.stdin = new PassThrough();
					child.kill = () => { throw new Error("credential serialization fixture must use owned-tree control"); };
					activeTrees++;
					maxActiveTrees = Math.max(maxActiveTrees, activeTrees);
					let reaped = false;
					let completed = false;
					const probe = {
						request: "",
						complete: (trusted: boolean) => {
							if (completed) return;
							completed = true;
							child.stdout.end(trusted
								? `protocol=https\nhost=${host}\nusername=route-fixture\npassword=fixture-secret\n`
								: `protocol=https\nhost=${host}\nusername=route-fixture\n`);
							child.emit("close", 0, null);
						},
					};
					child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					probes.push(probe);
					return {
						child,
						ownershipReady: Promise.resolve(),
						killTree: () => {},
						waitForTreeExit: async () => {
							if (!reaped) { reaped = true; activeTrees--; }
							return true;
						},
						killed: () => false,
						timedOut: () => false,
					};
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					remoteReads++;
					return { stdout: `https://${host}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 93,
								url: `https://${host}/acme/widget/pull/93`,
								title: "Serialized credential refresh",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") throw new Error("fixture GraphQL unavailable");
					if (args[0] === "repo" && args[1] === "view") {
						return { stdout: JSON.stringify({ viewerPermission: "ADMIN" }), stderr: "" };
					}
				}
				const standard = standardSingleRepositoryProbe(file, args, gitCwd());
				if (standard) return standard;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			gateway.clock.advance(60_000);

			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => probes.length, 1);
			expect(activeTrees).toBe(1);

			// Each request advances the refresh generation after the prior helper tree
			// has started. They must update one queued successor, not spawn siblings.
			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => remoteReads, 2);
			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => remoteReads, 3);
			expect(probes).toHaveLength(1);
			expect(activeTrees).toBe(1);
			expect(ghCalls).toHaveLength(0);

			probes[0].complete(true);
			await waitForCount(() => probes.length, 2);
			expect(probes[1].request).toBe(`url=https://${host}\n\n`);
			expect(activeTrees).toBe(1);
			expect(maxActiveTrees).toBe(1);
			expect(ghCalls).toHaveLength(0);

			probes[1].complete(true);
			const responses = await Promise.all(routeRequests);
			// Each route keeps its own refresh-generation view even though G1 and G2
			// share one successor internally. Only the latest caller may authorize.
			expect(responses.map(response => response.status)).toEqual([204, 204, 200]);
			expect(activeTrees).toBe(0);
			expect(maxActiveTrees).toBe(1);
			expect(probes).toHaveLength(2);
			const prLookups = ghCalls.filter(args => args[0] === "pr" && args[1] === "list");
			expect(prLookups).toHaveLength(1);
			expect(prLookups[0].slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${host}/acme/widget`, "--head", branch,
			]);
			expect(ghCalls.filter(args => args[0] === "api").every(args => (
				args[1] === "--hostname" && args[2] === host
			))).toBe(true);
			expect(ghCalls.find(args => args[0] === "repo" && args[1] === "view")).toEqual([
				"repo", "view", "--repo", `${host}/acme/widget`, "--json", "viewerPermission",
			]);
		} finally {
			// Restore shared runner state before any cleanup await. A stale helper may
			// schedule a serialized successor in a microtask; that successor must use
			// the normal fenced runner rather than leaking this fixture into later tests.
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			for (const probe of probes) probe.complete(false);
			gateway.clock.advance(60_000);
			await new Promise<void>(resolve => setImmediate(resolve));
			await Promise.allSettled(routeRequests);
			try {
				if (sessionId) await deleteSession(sessionId);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
			}
		}
	});

	test("credential-vouches only the selected repository in a multi-repository PR status lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-credential-selected-"));
		const selectedSource = join(projectRoot, "selected");
		const siblingSource = join(projectRoot, "sibling");
		mkdirSync(selectedSource, { recursive: true });
		mkdirSync(siblingSource, { recursive: true });
		const selectedHost = `selected-credential-${Date.now()}.invalid`;
		const siblingHost = `unrelated-sibling-${Date.now()}.invalid`;
		const branch = `fixture/selected-credential-${Date.now()}`;
		const project = await registerProject({
			name: `Selected credential repository ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "selected", repo: "selected" },
				{ name: "sibling", repo: "sibling" },
			],
			seedWorkflows: false,
		});
		const sessionId = await createRemoteStateSession(gateway, selectedSource, project.id);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: projectRoot });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.cwd = selectedSource;
		session.repoPath = projectRoot;

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		const probes: Array<{ request: string; cwd: string }> = [];
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const repositoryFor = (cwd: string) => {
			if (cwd === selectedSource) return {
				host: selectedHost,
				slug: "acme/selected-repository",
				commonDir: join(selectedSource, ".git"),
			};
			if (cwd === siblingSource) return {
				host: siblingHost,
				slug: "acme/unrelated-sibling",
				commonDir: join(siblingSource, ".git"),
			};
			return undefined;
		};

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(
						`protocol=https\nhost=${selectedHost}\nusername=route-fixture\npassword=fixture-secret\n`,
					);
					const probe = { request: "", cwd: String(options?.cwd ?? "") };
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				const cwd = String(options?.cwd ?? "");
				const repository = repositoryFor(cwd);
				if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
					if (!repository) throw new Error("not a configured repository source");
					return { stdout: `${cwd}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
					if (!repository) throw new Error("unknown repository identity");
					return { stdout: `${repository.commonDir}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
					if (cwd !== selectedSource) throw new Error("PR execution escaped selected repository");
					return { stdout: ".git\n", stderr: "" };
				}
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					if (!repository) throw new Error("unknown repository remote");
					return { stdout: `https://${repository.host}/${repository.slug}.git\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
					return { stdout: `${branch}\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push({ args: [...args], cwd });
					if (cwd !== selectedSource) throw new Error("gh escaped selected repository");
					if (args[0] === "pr" && args[1] === "list") {
						return { stdout: JSON.stringify([{
							number: 119,
							url: `https://${selectedHost}/acme/selected-repository/pull/119`,
							title: "selected credential repository",
							state: "OPEN",
							mergeable: "MERGEABLE",
							headRefName: branch,
							baseRefName: "main",
							...ownedHeadEvidence("acme", "selected-repository"),
						}]), stderr: "" };
					}
					if (args[0] === "api") {
						return {
							stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }),
							stderr: "",
						};
					}
				}
				return unexpectedRunnerCommand(file, args, options);
			};

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({
				stale: false,
				data: { number: 119, title: "selected credential repository" },
			});
			expect(probes).toEqual([expect.objectContaining({
				request: `url=https://${selectedHost}\n\n`,
			})]);
			expect(probes[0].cwd).not.toBe(selectedSource);
			expect(probes[0].request).not.toContain(siblingHost);
			const listCall = ghCalls.find(call => call.args[0] === "pr" && call.args[1] === "list");
			expect(listCall).toMatchObject({ cwd: selectedSource });
			expect(listCall?.args.slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${selectedHost}/acme/selected-repository`, "--head", branch,
			]);
			expect(ghCalls.filter(call => call.args[0] === "api").every(call => (
				call.args[1] === "--hostname" && call.args[2] === selectedHost
			))).toBe(true);
			expect(JSON.stringify(ghCalls)).not.toContain(siblingHost);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			const cleanup = await awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `selected credential fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});

	test("rejects an unlisted configured sibling alias without probing it or invoking gh", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-credential-alias-"));
		const selectedSource = join(projectRoot, "selected");
		const siblingSource = join(projectRoot, "sibling");
		mkdirSync(selectedSource, { recursive: true });
		mkdirSync(siblingSource, { recursive: true });
		const host = `credential-alias-${Date.now()}.invalid`;
		const branch = `fixture/credential-alias-${Date.now()}`;
		const commonDir = join(projectRoot, ".git", "shared");
		const project = await registerProject({
			name: `Credential repository alias ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "selected", repo: "selected" },
				{ name: "sibling", repo: "sibling" },
			],
			seedWorkflows: false,
		});
		const sessionId = await createRemoteStateSession(gateway, selectedSource, project.id);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: projectRoot });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.cwd = selectedSource;
		session.repoPath = projectRoot;

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		const probes: Array<{ request: string; cwd: string }> = [];
		let ghCalls = 0;

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential alias fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(
						`protocol=https\nhost=${host}\nusername=route-fixture\npassword=fixture-secret\n`,
					);
					const probe = { request: "", cwd: String(options?.cwd ?? "") };
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				const cwd = String(options?.cwd ?? "");
				const configuredSource = cwd === selectedSource || cwd === siblingSource;
				if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
					if (!configuredSource) throw new Error("not a configured repository source");
					return { stdout: `${cwd}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
					if (!configuredSource) throw new Error("unknown repository identity");
					return { stdout: `${commonDir}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					if (!configuredSource) throw new Error("unknown repository remote");
					return { stdout: `https://${host}/acme/shared-repository.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls += 1;
					throw new Error("ambiguous configured repository reached gh");
				}
				return unexpectedRunnerCommand(file, args, options);
			};

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(status.status).toBe(204);
			expect(await status.text()).toBe("");
			expect(probes).toEqual([expect.objectContaining({
				request: `url=https://${host}\n\n`,
			})]);
			expect(probes[0].cwd).not.toBe(selectedSource);
			expect(probes[0].request).not.toContain(siblingSource);
			expect(ghCalls).toBe(0);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			const cleanup = await awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `credential alias fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});

	test("coalesces session Git and PR reads and only broadcasts redacted snapshot envelopes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let gitFetches = 0;
		let prReads = 0;
		const permissionApiCalls: string[][] = [];
		let localOnly = false;
		let remoteHost = "example.github.test";
		let remoteOrigin: string | undefined;
		let goalId: string | undefined;
		let originalTrustedHosts: unknown = [];
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;
		let sandboxWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let sandboxProjectId: string | undefined;
		const telemetry: Array<Record<string, unknown>> = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (!line.startsWith("[remote-state] ")) return;
			try { telemetry.push(JSON.parse(line.slice("[remote-state] ".length))); } catch { /* assertion below catches missing events */ }
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				if (localOnly) throw new Error("no origin configured");
				return { stdout: `${remoteOrigin ?? `https://token:secret@${remoteHost}/acme/widget.git`}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "fetch --quiet") {
				gitFetches += 1;
				return { stdout: "", stderr: "" };
			}
			if (commandName(file) === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				const customApiPort = Number(remoteOrigin?.match(/^https:\/\/[^/]+:(8443)\//)?.[1]);
				const number = customApiPort || 42;
				const responseHost = customApiPort ? `example.github.test:${customApiPort}` : "example.github.test";
				return {
					stdout: JSON.stringify([{
						number,
						url: `https://${responseHost}/acme/widget/pull/${number}`,
						title: `safe title ${number}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[args.indexOf("--head") + 1],
						baseRefName: customApiPort ? "private/base" : "master",
						...ownedHeadEvidence("acme", "widget"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				permissionApiCalls.push([...args]);
				if (args.includes("graphql")) {
					// A missing GraphQL repository still takes the best-effort branch-rules
					// path, and every API call must stay on the exact trusted GHE authority.
					return { stdout: JSON.stringify({ data: { repository: null } }), stderr: "" };
				}
				const endpoint = String(args.at(-1));
				if (endpoint.includes("/rules/branches/")) return { stdout: JSON.stringify([{ ruleset_id: 73 }]), stderr: "" };
				if (endpoint.endsWith("/rulesets/73")) return { stdout: JSON.stringify({ current_user_can_bypass: "pull_requests_only" }), stderr: "" };
				throw new Error(`unexpected permission API args: ${args.join(" ")}`);
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			const trusted = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: ["example.github.test"] }),
			});
			expect(trusted.status).toBe(200);
			ws = await connectWs(sessionId);
			const cursor = ws.messageCount();
			const gitTelemetryCursor = telemetry.length;
			const gitResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
			]);
			const gitBodies = await Promise.all(gitResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(gitFetches).toBe(1);
			const gitTelemetry = telemetry.slice(gitTelemetryCursor).filter(event => event.source === "repository");
			expect(gitTelemetry, "successful repository lifecycle events must stay out of the normal server log").toHaveLength(0);
			for (const body of gitBodies) {
				expect(body).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), refreshedAt: expect.any(Number), ageMs: expect.any(Number) });
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			const gitFrame = await ws.waitForFrom(cursor, message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "git");
			expect(gitFrame.snapshot).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), ageMs: expect.any(Number) });
			expect(JSON.stringify(gitFrame)).not.toContain("token:secret");
			expect(JSON.stringify(gitFrame)).not.toContain("example.github.test/acme/widget.git");

			const prTelemetryCursor = telemetry.length;
			const prResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
			]);
			const prBodies = await Promise.all(prResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(prReads).toBe(1);
			const prTelemetry = telemetry.slice(prTelemetryCursor).filter(event => event.source === "pull_request");
			expect(prTelemetry, "successful PR lifecycle events must stay out of the normal server log").toHaveLength(0);
			for (const body of prBodies) {
				expect(body).toMatchObject({ source: "pr", stale: false, data: { number: 42 }, observedAt: expect.any(Number), refreshedAt: expect.any(Number) });
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			// Sidebar demand retains the fresh PR record; an active read becomes due
			// after its shorter 20-second window without browser-count multiplication.
			await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=sidebar`);
			expect(prReads).toBe(1);
			gateway.clock.advance(20_000);
			await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(2);

			// Sidebar goal demand is addressed to the viewer/global channel rather than
			// only goal-attached sockets. This unrelated session socket observes it.
			const goal = await createGoal({
				title: `remote state sidebar ${Date.now()}`,
				cwd: gitCwd(),
				worktree: false,
				autoStartTeam: false,
			});
			goalId = String(goal.id);
			if (typeof goal.projectId !== "string") throw new Error("remote-state goal did not resolve a project");
			gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
				cwd: gitCwd(),
				repoPath: gitCwd(),
				worktreePath: gitCwd(),
				branch: `remote-state-sidebar-${Date.now()}`,
				setupStatus: "ready",
			});
			gateway.clock.advance(60_000);

			// The server derives a restricted principal from the sandbox credential.
			// Even though this socket is authorized for the session, it must not see
			// unrelated global sidebar state for the goal below.
			sandboxProjectId = goal.projectId;
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(sandboxProjectId);
			gateway.sessionManager.sandboxTokenStore.addSession(sandboxProjectId, sessionId);
			sandboxWs = await connectWs(sessionId, sandboxToken);
			const sidebarCursor = ws.messageCount();
			const sandboxSidebarCursor = sandboxWs.messageCount();
			const beforeSidebarRead = prReads;
			const sidebarResponse = await apiFetch(`/api/goals/${goalId}/pr-status?intent=sidebar`);
			expect(sidebarResponse.status).toBe(200);
			const sidebarFrame = await ws.waitForFrom(
				sidebarCursor,
				message => message.type === "remote_state_snapshot" && message.goalId === goalId && message.resource === "pr",
			);
			expect(sidebarFrame.snapshot).toMatchObject({ source: "pr", data: { number: 42 } });
			expect(prReads).toBe(beforeSidebarRead + 1);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(sandboxWs.messages.slice(sandboxSidebarCursor).filter(
				message => message.type === "remote_state_snapshot" && message.goalId === goalId && message.resource === "pr",
			)).toHaveLength(0);

			// Restricted sockets keep entity-addressed delivery for their authorized
			// session; only the UI-only sidebar fanout is filtered.
			crossForceCoalescingWindow();
			const targetedCursor = sandboxWs.messageCount();
			const beforeTargetedRead = prReads;
			const targetedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(targetedResponse.status).toBe(200);
			const targetedFrame = await sandboxWs.waitForFrom(
				targetedCursor,
				message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "pr",
			);
			expect(targetedFrame.snapshot).toMatchObject({ source: "pr", data: { number: 42 } });
			expect(prReads).toBe(beforeTargetedRead + 1);

			// Cache-bust completes canonical invalidation before replying, so the next
			// automatic read is immediately eligible and remains one single flight.
			const beforeBust = prReads;
			const bust = await apiFetch(`/api/goals/${goalId}/pr-cache-bust`, { method: "POST" });
			expect(bust.status).toBe(200);
			await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
			]);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(beforeBust + 1);

			// Trusted-looking substrings inside an untrusted URL must not alias the
			// genuine record, trigger `gh`, or broadcast retained genuine PR data.
			for (const spoof of [
				"https://evil.example/a/https://example.github.test/acme/widget.git",
				"ssh://git@evil.example/a/git@example.github.test:acme/widget.git",
			]) {
				remoteOrigin = spoof;
				const beforeSpoof = prReads;
				const spoofCursor = ws.messageCount();
				for (const intent of ["automatic", "explicit"]) {
					const response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=${intent}&optional=1`);
					expect(response.status).toBe(204);
				}
				await new Promise<void>(resolve => setImmediate(resolve));
				expect(prReads).toBe(beforeSpoof);
				expect(ws.messages.slice(spoofCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
			}
			remoteOrigin = undefined;

			// SSH transport ports do not become GitHub API authorities. Equivalent
			// SSH forms share one PR record, while a real HTTPS API port stays distinct.
			const beforeCustomPorts = prReads;
			remoteOrigin = "ssh://git@example.github.test:2222/acme/widget.git";
			// This SSH remote intentionally aliases the earlier HTTPS PR identity.
			// Cross the explicit-refresh coalescing window deterministically so this
			// observes a new authority-pinned permission cycle on every runner speed.
			crossForceCoalescingWindow();
			const sshPermissionStart = permissionApiCalls.length;
			const sshResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(sshResponse.status).toBe(200);
			const sshBody = await sshResponse.json();
			expect(sshBody).toMatchObject({ data: { number: 42, url: "https://example.github.test/acme/widget/pull/42" } });
			const sshPermissionCalls = permissionApiCalls.slice(sshPermissionStart);
			expect(sshPermissionCalls).toHaveLength(3);
			expect(sshPermissionCalls.every(args => (
				args[0] === "api" && args[1] === "--hostname" && args[2] === "example.github.test"
			))).toBe(true);

			remoteOrigin = "ssh://git@example.github.test:2223/acme/widget.git";
			const equivalentSsh = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(equivalentSsh.status).toBe(200);
			expect(await equivalentSsh.json()).toMatchObject({ data: { number: 42 } });
			expect(prReads).toBe(beforeCustomPorts + 1);

			remoteOrigin = "https://example.github.test:8443/acme/widget.git";
			const apiPortPermissionStart = permissionApiCalls.length;
			const apiPortResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(apiPortResponse.status).toBe(200);
			const apiPortBody = await apiPortResponse.json();
			expect(apiPortBody).toMatchObject({ data: { number: 8443, url: "https://example.github.test:8443/acme/widget/pull/8443" } });
			const apiPortPermissionCalls = permissionApiCalls.slice(apiPortPermissionStart);
			expect(apiPortPermissionCalls).toHaveLength(3);
			expect(apiPortPermissionCalls.every(args => (
				args[0] === "api" && args[1] === "--hostname" && args[2] === "example.github.test:8443"
			))).toBe(true);
			expect(apiPortPermissionCalls.some(args => String(args.at(-1)).includes("private%2Fbase"))).toBe(true);
			expect(prReads).toBe(beforeCustomPorts + 2);
			for (const body of [sshBody, apiPortBody]) {
				expect(JSON.stringify(body)).not.toContain("ssh://");
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			// An untrusted remote is rejected before any `gh` call; configured GHE and
			// local-only repositories retain their separate supported paths.
			remoteOrigin = undefined;
			remoteHost = "gitlab.example.test";
			const beforeUntrusted = prReads;
			const untrustedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(untrustedResponse.status).toBe(204);
			expect(prReads).toBe(beforeUntrusted);

			// A no-origin repository remains entirely local: status still works but no
			// `git fetch` is attempted by the coordinator.
			localOnly = true;
			const beforeLocalRead = gitFetches;
			const localResponse = await apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`);
			expect(localResponse.status).toBe(200);
			expect(gitFetches).toBe(beforeLocalRead);
		} finally {
			runner.execFile = originalExecFile;
			console.debug = originalDebug;
			ws?.close();
			sandboxWs?.close();
			if (sandboxProjectId) gateway.sessionManager.sandboxTokenStore.removeSession(sandboxProjectId, sessionId);
			if (goalId) await deleteGoal(goalId);
			await deleteSession(sessionId);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
			}).catch(() => {});
		}
	});

	test("distinguishes definitive no-PR success from cold and failed optional probes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const fixtureBranch = `fixture/no-pr-${Date.now()}`;
		gateway.sessionManager.updateSessionMeta(sessionId, { branch: fixtureBranch });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let mode: "no-pr" | "failure" = "no-pr";
		const fixtureRemote = `https://github.com/acme/definitive-no-pr-${Date.now()}.git`;
		let markNoPrStarted!: () => void;
		const noPrStarted = new Promise<void>(resolve => { markNoPrStarted = resolve; });
		let releaseNoPr!: () => void;
		const noPrGate = new Promise<void>(resolve => { releaseNoPr = resolve; });

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: `${fixtureRemote}\n`, stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				if (mode === "no-pr") {
					markNoPrStarted();
					await noPrGate;
					return { stdout: "[]", stderr: "" };
				}
				const error = new Error("network timeout while reading fixture PR state");
				(error as any).stderr = "fixture transport unavailable";
				throw error;
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			// Hold the fixture lookup open so an optional automatic read deterministically
			// observes cold in-flight state rather than already-completed absence.
			const barePromise = apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			await noPrStarted;
			const coldResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic&optional=1`);
			expect(coldResponse.status).toBe(200);
			const coldBody = await coldResponse.json();
			expect(coldBody).toMatchObject({
				source: "pr",
				stale: true,
				observedAt: expect.any(Number),
				ageMs: 0,
			});
			expect(coldBody).not.toHaveProperty("data");
			expect(coldBody).not.toHaveProperty("refreshedAt");
			expect(coldBody).not.toHaveProperty("lastError");

			// The single coordinated probe reports the gh CLI's definitive no-PR
			// outcome, which is successful null state rather than a transport failure.
			releaseNoPr();
			const bareResponse = await barePromise;
			expect(bareResponse.status).toBe(200);
			const noPrBody = await bareResponse.json();
			expect(noPrBody).toMatchObject({
				data: null,
				source: "pr",
				stale: false,
				observedAt: expect.any(Number),
				refreshedAt: expect.any(Number),
				ageMs: expect.any(Number),
			});
			expect(noPrBody).not.toHaveProperty("lastError");
			expect(prReads).toBe(1);

			const readsAfterNoPr = prReads;
			const optionalResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic&optional=1`);
			expect(optionalResponse.status).toBe(204);
			expect(await optionalResponse.text()).toBe("");
			expect(prReads).toBe(readsAfterNoPr);

			// A failed forced refresh retains the last-good null, but lastError makes
			// it diagnostics-bearing stale state. optional=1 must not erase it as 204.
			mode = "failure";
			crossForceCoalescingWindow();
			const failedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(failedResponse.status).toBe(200);
			const failedBody = await failedResponse.json();
			expect(failedBody).toMatchObject({
				data: null,
				source: "pr",
				stale: true,
				lastError: "offline",
				refreshedAt: noPrBody.refreshedAt,
				observedAt: expect.any(Number),
				ageMs: expect.any(Number),
			});
			expect(prReads).toBe(readsAfterNoPr + 1);
		} finally {
			releaseNoPr();
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
		}
	});

	test("selects a working fallback locally before issuing one coordinated PR read", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primaryCwd = gitCwd();
		const fallbackCwd = join(primaryCwd, `.owned-pr-fallback-${Date.now()}`);
		const sessionId = await createRemoteStateSession(gateway, primaryCwd);
		const branch = `fixture/broken-worktree-${Date.now()}`;
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: fallbackCwd });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let prReadCwd: string | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (String(options?.cwd) === primaryCwd) throw new Error("broken worktree git link");
				if (String(options?.cwd) === fallbackCwd) return { stdout: ".git\n", stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/local-preflight-fallback.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				prReadCwd = String(options?.cwd);
				return {
					stdout: JSON.stringify([{
						number: 88,
						url: "https://github.com/acme/local-preflight-fallback/pull/88",
						title: "fallback result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "local-preflight-fallback"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			if (commandName(file) === "git" && args[0] === "check-ref-format" && args[1] === "--branch") {
				return { stdout: `${String(args[2])}\n`, stderr: "" };
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ data: { number: 88, title: "fallback result" }, stale: false });
			expect(prReads).toBe(1);
			expect(prReadCwd).toBe(fallbackCwd);
		} finally {
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
		}
	});

	test("rejects caller-injected and ambient repositories for numeric goal, session, and sandbox PR routes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const ownedCwd = mkdtempSync(join(tmpdir(), "bobbit-numeric-pr-owner-"));
		const outsideRepo = join(dirname(ownedCwd), `outside-pr-injection-${Date.now()}`);
		const project = await registerProject({
			name: `Numeric PR containment ${Date.now()}`,
			rootPath: ownedCwd,
			components: [{ name: "owner", repo: "." }],
			seedWorkflows: false,
		});
		const goal = await createGoal({
			projectId: project.id,
			title: `PR containment goal ${Date.now()}`,
			cwd: ownedCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		goalStore.update(goalId, {
			cwd: ownedCwd,
			repoPath: ownedCwd,
			worktreePath: join(ownedCwd, ".missing-goal-worktree"),
			branch: "17",
			setupStatus: "ready",
		});

		// repoPath is structural lifecycle metadata. A normal goal update may change
		// the display branch, but cannot manufacture a fallback repository binding.
		const poisonedPut = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ branch: "17", repoPath: outsideRepo }),
		});
		expect(poisonedPut.status).toBe(400);
		expect(await poisonedPut.text()).toContain("repoPath");
		const persistedGoal = await (await apiFetch(`/api/goals/${goalId}`)).json();
		expect(persistedGoal.repoPath).toBe(ownedCwd);
		expect(persistedGoal.repoPath).not.toBe(outsideRepo);

		const normalSessionId = await createRemoteStateSession(gateway, ownedCwd, project.id);
		gateway.sessionManager.updateSessionMeta(normalSessionId, {
			branch: "18",
			repoPath: outsideRepo,
			worktreePath: join(ownedCwd, ".missing-session-worktree"),
		});
		const sandboxSessionId = await createRemoteStateSession(gateway, ownedCwd, project.id);
		gateway.sessionManager.updateSessionMeta(sandboxSessionId, {
			branch: "19",
			repoPath: outsideRepo,
			worktreePath: join(ownedCwd, ".missing-sandbox-worktree"),
		});
		const sandboxSession = gateway.sessionManager.getSession(sandboxSessionId) as any;
		sandboxSession.sandboxed = true;
		sandboxSession.containerId = "fixture-numeric-pr-containment";
		sandboxSession.cwd = "/workspace/unavailable-owner";

		const sandboxProjectId = String(sandboxSession.projectId);
		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(sandboxProjectId);
		gateway.sessionManager.sandboxTokenStore.addSession(sandboxProjectId, sandboxSessionId);
		const [observerWs, sandboxWs] = await Promise.all([
			connectWs(normalSessionId),
			connectWs(sandboxSessionId, sandboxToken),
		]);
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const probedCwds: string[] = [];
		let ghCalls = 0;
		const privateSentinel = "PRIVATE OUTSIDE PR SENTINEL";

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			if (cwd) probedCwds.push(cwd);
			if (command === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: "19\n", stderr: "" };
			}
			if (command === "git" && (args.join(" ") === "rev-parse --git-dir" || args.join(" ") === "rev-parse --show-toplevel")) {
				if (cwd === outsideRepo || cwd === process.cwd()) return { stdout: cwd, stderr: "" };
				throw new Error("owned PR repositories are unavailable");
			}
			if (command === "gh") {
				ghCalls += 1;
				return {
					stdout: JSON.stringify({
						number: 17,
						url: "https://github.com/private/outside/pull/17",
						title: privateSentinel,
						state: "OPEN",
						headRefName: "private-head",
						baseRefName: "private-base",
					}),
					stderr: "",
				};
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const observerCursor = observerWs.messageCount();
			const sandboxCursor = sandboxWs.messageCount();
			const routeCases = [
				{ kind: "goal", id: goalId, branch: "17" },
				{ kind: "session", id: normalSessionId, branch: "18" },
				{ kind: "session", id: sandboxSessionId, branch: "19" },
			];
			const publicBodies: string[] = [];
			for (const routeCase of routeCases) {
				const base = `/api/${routeCase.kind === "goal" ? "goals" : "sessions"}/${routeCase.id}`;
				const status = await apiFetch(`${base}/pr-status?intent=explicit&optional=1`);
				expect(status.status, `${routeCase.kind} numeric status must fail closed`).toBe(204);
				publicBodies.push(await status.text());
				const merge = await apiFetch(`${base}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch: routeCase.branch }),
				});
				expect(merge.status, `${routeCase.kind} numeric merge must fail closed`).toBe(409);
				publicBodies.push(await merge.text());
			}

			expect(ghCalls).toBe(0);
			expect(probedCwds).not.toContain(outsideRepo);
			expect(probedCwds).not.toContain(process.cwd());
			await new Promise<void>(resolve => setImmediate(resolve));
			const publicOutput = JSON.stringify({
				publicBodies,
				observerFrames: observerWs.messages.slice(observerCursor),
				sandboxFrames: sandboxWs.messages.slice(sandboxCursor),
			});
			expect(publicOutput).not.toContain(privateSentinel);
			expect(publicOutput).not.toContain("private-head");
			expect(observerWs.messages.slice(observerCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
			expect(sandboxWs.messages.slice(sandboxCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
		} finally {
			runner.execFile = originalExecFile;
			observerWs.close();
			sandboxWs.close();
			gateway.sessionManager.sandboxTokenStore.removeSession(sandboxProjectId, sandboxSessionId);
			await Promise.all([
				deleteSession(normalSessionId),
				deleteSession(sandboxSessionId),
				deleteGoal(goalId),
			]);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(ownedCwd, { maxAttempts: 5, backoffMs: 50 });
		}
	});


	test("rejects selector abuse and binds numeric and slash heads to the owned repository", async ({ gateway }) => {
		test.setTimeout(30_000);
		const ownedCwd = gitCwd();
		const goal = await createGoal({
			title: `PR selector binding ${Date.now()}`,
			cwd: ownedCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		if (typeof goal.projectId !== "string") throw new Error("fixture goal project unavailable");
		const goalStore = gateway.sessionManager.getGoalStoreForProject(goal.projectId);
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const ghCalls: string[][] = [];
		const outsideSentinel = "PRIVATE REPOSITORY SENTINEL";
		const credentialSentinel = "PRIVATE-PR-CREDENTIAL";
		let returnOutsideResult = false;
		let unsafeUrl: string | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/owned-selector.git\n", stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push([...args]);
				if (args[0] === "pr" && args[1] === "view") {
					return { stdout: JSON.stringify({ title: outsideSentinel }), stderr: "" };
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				const head = args[args.indexOf("--head") + 1];
				const wrongRepo = args[args.indexOf("--repo") + 1] !== "acme/owned-selector";
				const current = {
					number: head === "17" ? 117 : 118,
					url: unsafeUrl ?? `https://github.com/acme/owned-selector/pull/${head === "17" ? 117 : 118}`,
					title: `owned ${head}`,
					state: "OPEN",
					updatedAt: "2026-02-01T00:00:00.000Z",
					mergeable: "MERGEABLE",
					headRefName: head,
					baseRefName: "main",
					headRepository: { name: "owned-selector" },
					headRepositoryOwner: { login: "acme" },
					isCrossRepository: false,
				};
				const results = wrongRepo || returnOutsideResult ? [{
					number: 999,
					url: "https://github.com/private/outside/pull/999",
					title: outsideSentinel,
					headRefName: head,
				}] : head === "17" ? [{
					number: 17,
					url: "https://github.com/acme/owned-selector/pull/17",
					title: "historical owned 17",
					state: "MERGED",
					updatedAt: "2026-01-01T00:00:00.000Z",
					headRefName: head,
					headRepository: { name: "owned-selector" },
					headRepositoryOwner: { login: "acme" },
					isCrossRepository: false,
				}, current] : [current];
				return { stdout: JSON.stringify(results), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, ownedCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			for (const attacker of [
				"https://github.com/private/outside/pull/123",
				"--repo=private/outside",
				"-R",
				"bad\nhead",
			]) {
				goalStore.update(goalId, { cwd: ownedCwd, repoPath: ownedCwd, worktreePath: ownedCwd, branch: attacker, setupStatus: "ready" });
				const before = ghCalls.length;
				const status = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit&optional=1`);
				expect(status.status, attacker).toBe(204);
				const merge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch: attacker }),
				});
				expect(merge.status, attacker).toBe(409);
				expect(ghCalls).toHaveLength(before);
			}

			goalStore.update(goalId, { cwd: ownedCwd, repoPath: ownedCwd, worktreePath: ownedCwd, branch: "17", setupStatus: "ready" });
			const numericStatus = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(numericStatus.status).toBe(200);
			expect(await numericStatus.json()).toMatchObject({ data: { number: 117, title: "owned 17" } });
			const numericLookup = ghCalls.find(args => args[0] === "pr" && args[1] === "list");
			expect(numericLookup?.slice(0, 6)).toEqual(["pr", "list", "--repo", "acme/owned-selector", "--head", "17"]);
			expect(ghCalls.some(args => args[0] === "pr" && args[1] === "view")).toBe(false);

			returnOutsideResult = true;
			crossForceCoalescingWindow();
			const escaped = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(escaped.status).toBe(200);
			const escapedBody = await escaped.json();
			expect(escapedBody).toMatchObject({ stale: true, lastError: "unavailable", data: { number: 117, title: "owned 17" } });
			expect(JSON.stringify(escapedBody)).not.toContain(outsideSentinel);
			returnOutsideResult = false;
			crossForceCoalescingWindow();
			const recovered = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(recovered.status).toBe(200);
			expect(await recovered.json()).toMatchObject({ stale: false, data: { number: 117 } });

			unsafeUrl = `https://${credentialSentinel}:secret@github.com/acme/owned-selector/pull/117`;
			crossForceCoalescingWindow();
			const rejectedCredentialUrl = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			const rejectedCredentialBody = await rejectedCredentialUrl.json();
			expect(rejectedCredentialBody).toMatchObject({ stale: true, lastError: "unavailable", data: { number: 117 } });
			expect(JSON.stringify(rejectedCredentialBody)).not.toContain(credentialSentinel);
			unsafeUrl = undefined;
			crossForceCoalescingWindow();
			expect(await (await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`)).json()).toMatchObject({ stale: false, data: { number: 117 } });

			const callsBeforeInjectedMerge = ghCalls.length;
			const injectedMerge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch: "https://github.com/private/outside/pull/123" }),
			});
			expect(injectedMerge.status).toBe(409);
			expect(ghCalls.slice(callsBeforeInjectedMerge).some(args => args[0] === "pr" && args[1] === "merge")).toBe(false);

			const merge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch: "17" }),
			});
			expect(merge.status).toBe(200);
			expect([...ghCalls].reverse().find(args => args[0] === "pr" && args[1] === "merge")?.slice(0, 5)).toEqual([
				"pr", "merge", "117", "--repo", "acme/owned-selector",
			]);

			goalStore.update(goalId, { branch: "feature/slash.ok" });
			const slash = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(slash.status).toBe(200);
			expect(await slash.json()).toMatchObject({ data: { number: 118, title: "owned feature/slash.ok" } });
			const publicOutput = JSON.stringify({ numericLookup, ghCalls });
			expect(publicOutput).not.toContain(outsideSentinel);
		} finally {
			runner.execFile = originalExecFile;
			await deleteGoal(goalId);
		}
	});

	test("uses the owned project repository for broken sandbox status and merge", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const branch = "23";
		const ownedRepo = join(gitCwd(), `.owned-project-repo-${Date.now()}`);
		const missingWorktree = join(nonGitCwd(), `missing-sandbox-worktree-${Date.now()}`);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, worktreePath: missingWorktree, repoPath: ownedRepo });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.sandboxed = true;
		session.containerId = "fixture-owned-pr-fallback";
		session.cwd = "/workspace/broken-worktree";

		const projectId = String(session.projectId);
		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, sessionId);
		const sandboxWs = await connectWs(sessionId, sandboxToken);
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const ambientCwd = process.cwd();
		const ghCwds: string[] = [];
		let prReads = 0;
		let prMerges = 0;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const cwd = String(options?.cwd ?? "");
			if (commandName(file) === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (cwd === ownedRepo || cwd === ambientCwd) return { stdout: ".git\n", stderr: "" };
				throw new Error("broken host worktree");
			}
			if (commandName(file) === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: cwd === ownedRepo
					? "https://github.com/acme/owned.git\n"
					: "https://github.com/private/ambient.git\n", stderr: "" };
			}
			if (commandName(file) === "gh") {
				ghCwds.push(cwd);
				if (args[0] === "pr" && args[1] === "merge") {
					prMerges += 1;
					return { stdout: "merged", stderr: "" };
				}
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 23,
						url: "https://github.com/acme/owned/pull/23",
						title: "owned fallback",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "owned"),
					}]),
					stderr: "",
				};
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const cursor = sandboxWs.messageCount();
			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({ data: { number: 23, title: "owned fallback" } });
			const frame = await sandboxWs.waitForFrom(
				cursor,
				message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "pr",
			);
			expect(frame.snapshot).toMatchObject({ data: { number: 23, title: "owned fallback" } });

			const merge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(merge.status).toBe(200);
			expect(prReads).toBe(1);
			expect(prMerges).toBe(1);
			expect(ghCwds.every(cwd => cwd === ownedRepo)).toBe(true);
			expect(ghCwds).not.toContain(ambientCwd);
		} finally {
			runner.execFile = originalExecFile;
			sandboxWs.close();
			await deleteSession(sessionId);
		}
	});

	test("binds goal, session, and sandbox PR operations to the requested multi-repository component", async ({ gateway }) => {
		test.setTimeout(30_000);
		const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-component-containment-"));
		const apiRepo = join(fixtureRoot, "api");
		const webRepo = join(fixtureRoot, "web");
		const worktreeRoot = join(fixtureRoot, "worktrees");
		const apiWorktree = join(worktreeRoot, "branch", "api");
		const aliasedWebWorktree = join(worktreeRoot, "branch", "web");
		for (const directory of [apiRepo, webRepo, apiWorktree]) mkdirSync(directory, { recursive: true });
		// A lexical web coordinate canonicalizes to the healthy API sibling. Junction
		// mode also exercises Windows without requiring developer-mode symlink rights.
		symlinkSync(apiWorktree, aliasedWebWorktree, process.platform === "win32" ? "junction" : "dir");
		const canonicalApiWorktree = realpathSync(aliasedWebWorktree);
		const branch = "41"; // Numeric branch names remain heads, never PR-number selectors.

		const project = await registerProject({
			name: `PR component containment ${Date.now()}`,
			rootPath: fixtureRoot,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web", relative_path: "src" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goal = await createGoal({
			projectId: project.id,
			title: `Web component PR ${Date.now()}`,
			cwd: webRepo,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		const productionRepoWorktrees = { api: apiWorktree, web: aliasedWebWorktree };
		gateway.sessionManager.getGoalStoreForProject(project.id).update(goalId, {
			cwd: join(aliasedWebWorktree, "src"),
			worktreePath: worktreeRoot,
			repoPath: fixtureRoot,
			repoWorktrees: productionRepoWorktrees,
			branch,
			setupStatus: "ready",
		});

		const normalSessionId = await createRemoteStateSession(gateway, webRepo, project.id);
		gateway.sessionManager.updateSessionMeta(normalSessionId, {
			branch,
			repoPath: fixtureRoot,
			worktreePath: worktreeRoot,
			repoWorktrees: productionRepoWorktrees,
		});
		const normalSession = gateway.sessionManager.getSession(normalSessionId) as any;
		normalSession.cwd = join(aliasedWebWorktree, "src");
		normalSession.repoPath = fixtureRoot;
		normalSession.worktreePath = worktreeRoot;
		normalSession.repoWorktrees = productionRepoWorktrees;

		const sandboxSessionId = await createRemoteStateSession(gateway, webRepo, project.id);
		gateway.sessionManager.updateSessionMeta(sandboxSessionId, {
			branch,
			repoPath: fixtureRoot,
			worktreePath: worktreeRoot,
			repoWorktrees: productionRepoWorktrees,
		});
		const sandboxSession = gateway.sessionManager.getSession(sandboxSessionId) as any;
		sandboxSession.sandboxed = true;
		sandboxSession.containerId = "fixture-web-component";
		sandboxSession.cwd = "/workspace-wt/branch/web/src";
		sandboxSession.repoPath = fixtureRoot;
		sandboxSession.worktreePath = worktreeRoot;
		sandboxSession.repoWorktrees = productionRepoWorktrees;

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const gitProbeCwds: string[] = [];
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const apiSentinel = "WRONG API COMPONENT SENTINEL";
		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			if (command === "docker" && args.includes("rev-parse") && args.includes("--abbrev-ref")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo) return { stdout: `${join(webRepo, ".git")}\n`, stderr: "" };
				if (cwd === apiRepo || cwd === canonicalApiWorktree || cwd === join(canonicalApiWorktree, "src")) {
					return { stdout: `${join(apiRepo, ".git")}\n`, stderr: "" };
				}
				throw new Error("unknown repository identity");
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo || cwd === apiRepo) return { stdout: `${cwd}\n`, stderr: "" };
				throw new Error("unknown configured component source");
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo || cwd === canonicalApiWorktree || cwd === apiRepo) return { stdout: ".git\n", stderr: "" };
				throw new Error("broken requested component worktree");
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: cwd === webRepo
					? "https://github.com/acme/owned-web.git\n"
					: "https://github.com/private/wrong-api.git\n", stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				const repoIndex = args.indexOf("--repo");
				const headIndex = args.indexOf("--head");
				const correctRepo = args[repoIndex + 1] === "acme/owned-web";
				return {
					stdout: JSON.stringify([correctRepo ? {
						number: 41,
						url: "https://github.com/acme/owned-web/pull/41",
						title: "owned web component",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[headIndex + 1],
						baseRefName: "main",
						...ownedHeadEvidence("acme", "owned-web"),
					} : {
						number: 666,
						url: "https://github.com/private/wrong-api/pull/666",
						title: apiSentinel,
						headRefName: branch,
					}]),
					stderr: "",
				};
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const routeCases = [
				{ base: `/api/goals/${goalId}`, kind: "goal" },
				{ base: `/api/sessions/${normalSessionId}`, kind: "session" },
				{ base: `/api/sessions/${sandboxSessionId}`, kind: "sandbox" },
			];
			for (const routeCase of routeCases) {
				const status = await apiFetch(`${routeCase.base}/pr-status?intent=explicit`);
				expect(status.status, `${routeCase.kind} status`).toBe(200);
				expect(await status.json()).toMatchObject({ data: { number: 41, title: "owned web component" } });
				const merge = await apiFetch(`${routeCase.base}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "rebase", branch }),
				});
				expect(merge.status, `${routeCase.kind} merge`).toBe(200);
			}
			// Every configured source is validated locally as an exact Git top-level;
			// the aliased worktree is then rejected by identity. GitHub reads and
			// destructive actions still use only the authoritative web source fallback.
			expect(gitProbeCwds).toContain(apiRepo);
			expect(gitProbeCwds).toContain(join(canonicalApiWorktree, "src"));
			expect(JSON.stringify(ghCalls)).not.toContain(apiSentinel);
			for (const call of ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "list")) {
				expect(call.cwd).toBe(webRepo);
				expect(call.args.slice(0, 6)).toEqual(["pr", "list", "--repo", "acme/owned-web", "--head", branch]);
			}
			for (const call of ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "merge")) {
				expect(call.cwd).toBe(webRepo);
				expect(call.args.slice(0, 5)).toEqual(["pr", "merge", "41", "--repo", "acme/owned-web"]);
			}
		} finally {
			runner.execFile = originalExecFile;
			await Promise.all([deleteSession(normalSessionId), deleteSession(sandboxSessionId), deleteGoal(goalId)]);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(fixtureRoot, { maxAttempts: 5, backoffMs: 50 });
		}
	});

	test("keeps genuine root and nested repositories bound to their exact PR targets", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-root-nested-"));
		const nestedSource = join(projectRoot, "packages", "nested");
		const worktreeRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-root-nested-wt-"));
		const branchContainer = join(worktreeRoot, "branch");
		const rootWorktree = branchContainer;
		const nestedWorktree = join(branchContainer, "packages", "nested");
		mkdirSync(nestedSource, { recursive: true });
		mkdirSync(nestedWorktree, { recursive: true });
		const branch = "feature/root-and-nested";

		const project = await registerProject({
			name: `Root nested PR binding ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "root", repo: "." },
				{ name: "nested", repo: "packages/nested" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goals = await Promise.all([
			createGoal({ projectId: project.id, title: `Root PR ${Date.now()}`, cwd: projectRoot, worktree: false, autoStartTeam: false }),
			createGoal({ projectId: project.id, title: `Nested PR ${Date.now()}`, cwd: nestedSource, worktree: false, autoStartTeam: false }),
		]);
		const [rootGoalId, nestedGoalId] = goals.map(goal => String(goal.id));
		const repoWorktrees = { ".": rootWorktree, "packages/nested": nestedWorktree };
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		goalStore.update(rootGoalId, {
			cwd: rootWorktree,
			worktreePath: branchContainer,
			repoPath: projectRoot,
			repoWorktrees,
			branch,
			setupStatus: "ready",
		});
		goalStore.update(nestedGoalId, {
			cwd: nestedWorktree,
			worktreePath: branchContainer,
			repoPath: projectRoot,
			repoWorktrees,
			branch,
			setupStatus: "ready",
		});

		const repositoryByCwd = new Map([
			[projectRoot, { topLevel: projectRoot, commonDir: join(projectRoot, ".git"), slug: "acme/root-repository", number: 101, title: "root repository PR" }],
			[rootWorktree, { topLevel: rootWorktree, commonDir: join(projectRoot, ".git"), slug: "acme/root-repository", number: 101, title: "root repository PR" }],
			[nestedSource, { topLevel: nestedSource, commonDir: join(nestedSource, ".git"), slug: "acme/nested-repository", number: 202, title: "nested repository PR" }],
			[nestedWorktree, { topLevel: nestedWorktree, commonDir: join(nestedSource, ".git"), slug: "acme/nested-repository", number: 202, title: "nested repository PR" }],
		]);
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			const repository = repositoryByCwd.get(cwd);
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				if (!repository || (cwd !== projectRoot && cwd !== nestedSource)) throw new Error("not a configured source");
				return { stdout: `${repository.topLevel}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `${repository.commonDir}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: ".git\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `https://github.com/${repository.slug}.git\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (args[0] === "pr" && args[1] === "list") {
					if (!repository) throw new Error("GitHub read escaped configured repository");
					const repoIndex = args.indexOf("--repo");
					if (args[repoIndex + 1] !== repository.slug) throw new Error("GitHub repository selector mismatch");
					return {
						stdout: JSON.stringify([{
							number: repository.number,
							url: `https://github.com/${repository.slug}/pull/${repository.number}`,
							title: repository.title,
							state: "OPEN",
							mergeable: "MERGEABLE",
							headRefName: branch,
							baseRefName: "main",
							...ownedHeadEvidenceForSlug(repository.slug),
						}]),
						stderr: "",
					};
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const routeCases = [
				{ goalId: rootGoalId, repository: repositoryByCwd.get(rootWorktree)! },
				{ goalId: nestedGoalId, repository: repositoryByCwd.get(nestedWorktree)! },
			];
			for (const routeCase of routeCases) {
				const status = await apiFetch(`/api/goals/${routeCase.goalId}/pr-status?intent=explicit`);
				expect(status.status).toBe(200);
				expect(await status.json()).toMatchObject({
					stale: false,
					data: { number: routeCase.repository.number, title: routeCase.repository.title },
				});
				const merge = await apiFetch(`/api/goals/${routeCase.goalId}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "rebase", branch }),
				});
				expect(merge.status).toBe(200);
			}

			const listCalls = ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "list");
			expect(listCalls.some(call => call.cwd === rootWorktree && call.args.includes("acme/root-repository"))).toBe(true);
			expect(listCalls.some(call => call.cwd === nestedWorktree && call.args.includes("acme/nested-repository"))).toBe(true);
			const mergeCalls = ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "merge");
			expect(mergeCalls).toEqual(expect.arrayContaining([
				expect.objectContaining({ cwd: rootWorktree, args: expect.arrayContaining(["101", "acme/root-repository"]) }),
				expect.objectContaining({ cwd: nestedWorktree, args: expect.arrayContaining(["202", "acme/nested-repository"]) }),
			]));
		} finally {
			runner.execFile = originalExecFile;
			await Promise.all(goals.map(goal => deleteGoal(String(goal.id))));
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await Promise.all([
				awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 }),
				awaitableRm(worktreeRoot, { maxAttempts: 5, backoffMs: 50 }),
			]);
		}
	});


	test("allows a selected trusted PR repository beside local-only and GitLab components", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-mixed-"));
		const nestedSource = join(projectRoot, "packages", "nested");
		const worktreeRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-mixed-wt-"));
		const rootWorktree = join(worktreeRoot, "branch");
		const nestedWorktree = join(rootWorktree, "packages", "nested");
		mkdirSync(nestedSource, { recursive: true });
		mkdirSync(nestedWorktree, { recursive: true });
		const branch = "feature/mixed-polyrepo";
		const project = await registerProject({
			name: `Mixed PR routes ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "root", repo: "." },
				{ name: "nested", repo: "packages/nested" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goals = await Promise.all([
			createGoal({ projectId: project.id, title: `Mixed root ${Date.now()}`, cwd: projectRoot, worktree: false, autoStartTeam: false }),
			createGoal({ projectId: project.id, title: `Mixed nested ${Date.now()}`, cwd: nestedSource, worktree: false, autoStartTeam: false }),
		]);
		const [rootGoalId, nestedGoalId] = goals.map(goal => String(goal.id));
		const repoWorktrees = { ".": rootWorktree, "packages/nested": nestedWorktree };
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		for (const [goalId, cwd] of [[rootGoalId, rootWorktree], [nestedGoalId, nestedWorktree]] as const) {
			goalStore.update(goalId, {
				cwd,
				worktreePath: rootWorktree,
				repoPath: projectRoot,
				repoWorktrees,
				branch,
				setupStatus: "ready",
			});
		}

		type RepositoryFixture = { kind: "root" | "nested"; source: string; commonDir: string; slug: string; number: number; title: string };
		const rootRepository: RepositoryFixture = {
			kind: "root", source: projectRoot, commonDir: join(projectRoot, ".git"),
			slug: "acme/mixed-root", number: 301, title: "trusted root PR",
		};
		const nestedRepository: RepositoryFixture = {
			kind: "nested", source: nestedSource, commonDir: join(nestedSource, ".git"),
			slug: "acme/mixed-nested", number: 302, title: "trusted nested PR",
		};
		const repositoryByCwd = new Map<string, RepositoryFixture>([
			[projectRoot, rootRepository], [rootWorktree, rootRepository],
			[nestedSource, nestedRepository], [nestedWorktree, nestedRepository],
		]);
		let rootOrigin: string | undefined = `https://github.com/${rootRepository.slug}.git`;
		let nestedOrigin: string | undefined = "https://gitlab.example.test/acme/mixed-nested.git";
		const originFor = (repository: RepositoryFixture): string | undefined => repository.kind === "root" ? rootOrigin : nestedOrigin;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			const repository = repositoryByCwd.get(cwd);
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				if (!repository || cwd !== repository.source) throw new Error("not a configured source");
				return { stdout: `${repository.source}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `${repository.commonDir}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: ".git\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				const origin = repository && originFor(repository);
				if (!origin) throw new Error("no origin configured");
				return { stdout: `${origin}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) return { stdout: `${branch}\n`, stderr: "" };
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (!repository || !originFor(repository)?.includes("github.com")) throw new Error("gh reached an untrusted component");
				if (args[0] === "pr" && args[1] === "list") {
					return { stdout: JSON.stringify([{
						number: repository.number,
						url: `https://github.com/${repository.slug}/pull/${repository.number}`,
						title: repository.title,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidenceForSlug(repository.slug),
					}]), stderr: "" };
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return unexpectedRunnerCommand(file, args, options);
		};

		const exerciseOrientation = async (trusted: { goalId: string; cwd: string; repository: RepositoryFixture }, untrustedGoalId: string) => {
			const trustedStatus = await apiFetch(`/api/goals/${trusted.goalId}/pr-status?intent=explicit`);
			expect(trustedStatus.status).toBe(200);
			expect(await trustedStatus.json()).toMatchObject({ data: { number: trusted.repository.number, title: trusted.repository.title } });
			const trustedMerge = await apiFetch(`/api/goals/${trusted.goalId}/pr-merge`, {
				method: "POST", body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(trustedMerge.status).toBe(200);
			const callsBeforeUntrusted = ghCalls.length;
			expect((await apiFetch(`/api/goals/${untrustedGoalId}/pr-status?intent=explicit&optional=1`)).status).toBe(204);
			expect((await apiFetch(`/api/goals/${untrustedGoalId}/pr-merge`, {
				method: "POST", body: JSON.stringify({ method: "rebase", branch }),
			})).status).toBe(409);
			expect(ghCalls.length).toBe(callsBeforeUntrusted);
		};

		try {
			await exerciseOrientation({ goalId: rootGoalId, cwd: rootWorktree, repository: rootRepository }, nestedGoalId);
			rootOrigin = undefined;
			nestedOrigin = `https://github.com/${nestedRepository.slug}.git`;
			await exerciseOrientation({ goalId: nestedGoalId, cwd: nestedWorktree, repository: nestedRepository }, rootGoalId);
			for (const { cwd, repository } of [
				{ cwd: rootWorktree, repository: rootRepository },
				{ cwd: nestedWorktree, repository: nestedRepository },
			]) {
				const mergeCall = ghCalls.find(call => call.cwd === cwd && call.args[0] === "pr" && call.args[1] === "merge");
				expect(mergeCall?.args.slice(0, 5)).toEqual(["pr", "merge", String(repository.number), "--repo", repository.slug]);
			}
		} finally {
			runner.execFile = originalExecFile;
			await Promise.all(goals.map(goal => deleteGoal(String(goal.id))));
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await Promise.all([
				awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 }),
				awaitableRm(worktreeRoot, { maxAttempts: 5, backoffMs: 50 }),
			]);
		}
	});


	test("successful goal and sandbox session merges invalidate their shared canonical PR snapshot", async ({ gateway }) => {
		test.setTimeout(30_000);
		const hostCwd = gitCwd();
		const branch = `fixture/merge-invalidation-${Date.now()}`;
		const sessionId = await createRemoteStateSession(gateway, hostCwd);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, worktreePath: hostCwd });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.sandboxed = true;
		session.containerId = "fixture-pr-merge-container";
		session.worktreePath = hostCwd;
		session.cwd = "/workspace/fixture-pr-merge";

		const goal = await createGoal({
			title: `remote state merge ${Date.now()}`,
			cwd: hostCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		if (typeof goal.projectId !== "string") throw new Error("merge fixture goal did not resolve a project");
		gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
			cwd: hostCwd,
			repoPath: hostCwd,
			worktreePath: hostCwd,
			branch,
			setupStatus: "ready",
		});

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let version = 1;
		let rejectMerge = false;
		const waitForReads = async (expected: number) => {
			for (let attempt = 0; attempt < 40 && prReads < expected; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(expected);
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/merge-invalidation.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 99,
						url: "https://github.com/acme/merge-invalidation/pull/99",
						title: `merge version ${version}`,
						state: version === 1 ? "OPEN" : "MERGED",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "merge-invalidation"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "merge") {
				if (rejectMerge) throw new Error("fixture merge rejected");
				version += 1;
				return { stdout: "merged", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, hostCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			const seeded = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
			]);
			for (const response of seeded) expect(await response.json()).toMatchObject({ data: { state: "OPEN", title: "merge version 1" } });
			expect(prReads).toBe(1);

			const goalMerge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch }),
			});
			expect(goalMerge.status).toBe(200);
			const afterGoalMerge = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`),
			]);
			const afterGoalBodies = await Promise.all(afterGoalMerge.map(response => response.json()));
			// The first SWR observer retains OPEN while a later concurrent observer may
			// already see the synchronously completed fixture refresh.
			expect(afterGoalBodies).toContainEqual(expect.objectContaining({ stale: true, data: expect.objectContaining({ state: "OPEN" }) }));
			await waitForReads(2);
			const [goalFresh, sessionFreshAfterGoal] = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`),
			]);
			for (const response of [goalFresh, sessionFreshAfterGoal]) {
				expect(await response.json()).toMatchObject({ stale: false, data: { state: "MERGED", title: "merge version 2" } });
			}

			crossForceCoalescingWindow();
			const sessionMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(sessionMerge.status).toBe(200);
			const staleAfterSessionMerge = await apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`);
			expect(await staleAfterSessionMerge.json()).toMatchObject({ stale: true, data: { title: "merge version 2" } });
			await waitForReads(4);
			const sessionFresh = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await sessionFresh.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });

			rejectMerge = true;
			crossForceCoalescingWindow();
			const readsBeforeRejectedMerge = prReads;
			const rejectedMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "merge", branch }),
			});
			expect(rejectedMerge.status).toBe(500);
			const retained = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await retained.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });
			expect(prReads).toBe(readsBeforeRejectedMerge + 1);
		} finally {
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("retains PR last-good state through categorized failures, backoff, and concurrent forced recovery", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let version = 1;
		let failure: string | undefined;
		let recoveryGate: Promise<void> | undefined;
		let recoveryStarted: (() => void) | undefined;
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://token:secret@github.com/acme/route-failure.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				if (failure) {
					const error = new Error(`${failure} token:secret https://secret@example.test/private`);
					(error as any).stderr = "private stderr and review body";
					throw error;
				}
				if (recoveryGate) {
					recoveryStarted?.();
					await recoveryGate;
				}
				return {
					stdout: JSON.stringify([{
						number: 77,
						url: "https://github.com/acme/route-failure/pull/77",
						title: `safe version ${version}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[args.indexOf("--head") + 1],
						baseRefName: "master",
						...ownedHeadEvidence("acme", "route-failure"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			ws = await connectWs(sessionId);
			const seededResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(seededResponse.status).toBe(200);
			let retained = await seededResponse.json();
			expect(retained).toMatchObject({ stale: false, data: { title: "safe version 1" } });

			for (const scenario of [
				{ message: "network timeout", kind: "offline" },
				{ message: "HTTP 401 bad credentials", kind: "auth" },
				{ message: "HTTP 429 secondary rate limit", kind: "rate_limited" },
			]) {
				gateway.clock.advance(20_000);
				failure = scenario.message;
				const beforeFailure = prReads;
				const cursor = ws.messageCount();
				const staleResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
				expect(staleResponse.status).toBe(200);
				const failureFrame = await ws.waitForFrom(
					cursor,
					message => message.type === "remote_state_snapshot" && message.resource === "pr" && message.snapshot?.lastError === scenario.kind,
				);
				expect(prReads).toBeGreaterThan(beforeFailure);
				const afterFailure = prReads;
				expect(failureFrame.snapshot).toMatchObject({
					stale: true,
					lastError: scenario.kind,
					refreshedAt: retained.refreshedAt,
					data: retained.data,
				});
				expect(JSON.stringify(failureFrame)).not.toContain("token:secret");
				expect(JSON.stringify(failureFrame)).not.toContain("private stderr");

				const duringBackoff = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
				expect(await duringBackoff.json()).toMatchObject({
					stale: true,
					lastError: scenario.kind,
					refreshedAt: retained.refreshedAt,
					data: retained.data,
				});
				expect(prReads).toBe(afterFailure);

				failure = undefined;
				version += 1;
				gateway.clock.advance(1);
				// Keep this recovery distinct from the previous explicit cycle while the
				// two requests below retain one burst timestamp and join one flight.
				crossForceCoalescingWindow();
				let releaseRecovery!: () => void;
				let markRecoveryStarted!: () => void;
				const recoveryStartedPromise = new Promise<void>(resolve => { markRecoveryStarted = resolve; });
				recoveryStarted = markRecoveryStarted;
				recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
				const beforeRecovery = prReads;
				const recovering = Promise.all([
					apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
					apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
				]);
				await recoveryStartedPromise;
				await new Promise<void>(resolve => setImmediate(resolve));
				releaseRecovery();
				const recoveryResponses = await recovering;
				recoveryGate = undefined;
				recoveryStarted = undefined;
				expect(prReads).toBe(beforeRecovery + 1);
				const recoveryBodies = await Promise.all(recoveryResponses.map(response => response.json()));
				for (const body of recoveryBodies) {
					expect(body).toMatchObject({ stale: false, data: { title: `safe version ${version}` } });
					expect(body.lastError).toBeUndefined();
				}
				retained = recoveryBodies[0];
			}
		} finally {
			recoveryGate = undefined;
			runner.execFile = originalExecFile;
			ws?.close();
			await deleteSession(sessionId);
		}
	});

	test("resolves missing PR branch metadata per sibling head without cross-record leakage", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primary = gitCwd();
		const sibling = join(primary, `.remote-pr-head-sibling-${Date.now()}`);
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		// Head isolation is entirely runner-projected; only the final dirty-state
		// scenario below needs a native sibling worktree.
		mkdirSync(sibling, { recursive: true });
		const primarySession = await createRemoteStateSession(gateway, primary);
		const siblingSession = await createRemoteStateSession(gateway, sibling);
		gateway.sessionManager.updateSessionMeta(primarySession, { branch: "" });
		gateway.sessionManager.updateSessionMeta(siblingSession, { branch: "" });
		const privatePrimaryHead = "private-primary-selector";
		const privateSiblingHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let headUnavailable = false;
		let prReads = 0;
		let primaryWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let siblingWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		const telemetry: Array<Record<string, unknown>> = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (!line.startsWith("[remote-state] ")) return;
			try { telemetry.push(JSON.parse(line.slice("[remote-state] ".length))); } catch { /* assertions below cover safety */ }
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/private-head-isolation.git\n", stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD") {
				if (headUnavailable || String(options?.cwd) === sibling) throw new Error("detached or unavailable HEAD");
				return { stdout: `${privatePrimaryHead}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
				if (headUnavailable) throw new Error("unborn HEAD");
				if (String(options?.cwd) === sibling) return { stdout: `${privateSiblingHead}\n`, stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 101,
						url: "https://github.com/acme/private-head-isolation/pull/101",
						title: "primary result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: privatePrimaryHead,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "private-head-isolation"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api" && args.some(arg => arg.includes("/commits/"))) {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 202,
						html_url: "https://github.com/acme/private-head-isolation/pull/202",
						title: "sibling result",
						state: "open",
						head: { ref: "public-sibling" },
						base: { ref: "main" },
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, primary);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		try {
			[primaryWs, siblingWs] = await Promise.all([connectWs(primarySession), connectWs(siblingSession)]);
			const primaryCursor = primaryWs.messageCount();
			const siblingCursor = siblingWs.messageCount();
			const [primaryResponse, siblingResponse] = await Promise.all([
				apiFetch(`/api/sessions/${primarySession}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${siblingSession}/pr-status?intent=explicit`),
			]);
			expect(primaryResponse.status).toBe(200);
			expect(siblingResponse.status).toBe(200);
			const [primaryBody, siblingBody] = await Promise.all([primaryResponse.json(), siblingResponse.json()]);
			expect(primaryBody).toMatchObject({ data: { number: 101, title: "primary result" } });
			expect(siblingBody).toMatchObject({ data: { number: 202, title: "sibling result" } });
			expect(prReads).toBe(2);

			const [primaryFrame, siblingFrame] = await Promise.all([
				primaryWs.waitForFrom(primaryCursor, message => message.type === "remote_state_snapshot" && message.resource === "pr"),
				siblingWs.waitForFrom(siblingCursor, message => message.type === "remote_state_snapshot" && message.resource === "pr"),
			]);
			expect(primaryFrame.snapshot.data).toMatchObject({ number: 101 });
			expect(siblingFrame.snapshot.data).toMatchObject({ number: 202 });

			headUnavailable = true;
			const beforeUnsupported = prReads;
			const unsupported = await apiFetch(`/api/sessions/${primarySession}/pr-status?intent=explicit&optional=1`);
			expect(unsupported.status).toBe(204);
			expect(prReads).toBe(beforeUnsupported);

			const publicOutput = JSON.stringify({ primaryBody, siblingBody, primaryFrame, siblingFrame, telemetry });
			expect(publicOutput).not.toContain(privatePrimaryHead);
			expect(publicOutput).not.toContain(privateSiblingHead);
			expect(publicOutput).not.toContain("#head:");
		} finally {
			runner.execFile = originalExecFile;
			console.debug = originalDebug;
			primaryWs?.close();
			siblingWs?.close();
			await Promise.all([deleteSession(primarySession), deleteSession(siblingSession)]);
			const cleanup = await awaitableRm(sibling, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `head-isolation fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});


});
