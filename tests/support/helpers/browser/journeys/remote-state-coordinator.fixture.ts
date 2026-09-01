import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	waitForSessionStatus,
} from "./journey-fixture.js";

interface RemoteFixture {
	root: string;
	repo: string;
	peer: string;
	projectId: string;
}

export type SnapshotState = {
	stale?: boolean;
	observedAt?: number;
	refreshedAt?: number;
	ageMs?: number;
	lastError?: string;
	source?: string;
};

type WidgetState = {
	branch?: string;
	behind?: number;
	loading?: boolean;
	prState?: string;
	prNumber?: number;
	prTitle?: string;
	stale: boolean;
	observedAt?: number;
	refreshedAt?: number;
	ageMs?: number;
	lastError?: string;
	source?: string;
	gitSnapshot?: SnapshotState;
	prSnapshot?: SnapshotState;
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createRemoteFixture(label: string): Promise<RemoteFixture> {
	const root = mkdtempSync(join(tmpdir(), `bobbit-remote-state-${label}-`));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const peer = join(root, "peer");
	git(root, "init", "--bare", "--initial-branch=master", origin);
	git(root, "clone", origin, repo);
	git(repo, "config", "user.name", "Remote State Browser Test");
	git(repo, "config", "user.email", "remote-state-browser@example.test");
	writeFileSync(join(repo, "README.md"), "initial\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial remote-state fixture");
	git(repo, "push", "-u", "origin", "master");
	git(root, "clone", origin, peer);
	git(peer, "config", "user.name", "Remote State Peer");
	git(peer, "config", "user.email", "remote-state-peer@example.test");
	const project = await registerProject({
		name: `remote-state-${label}-${Date.now()}`,
		rootPath: repo,
	});
	return { root, repo, peer, projectId: project.id };
}

async function removeFixture(fixture: RemoteFixture | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	try {
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// Windows can retain a short-lived Git handle after the injected fetch is
		// released. The browser coordinator owns and removes this entire temp root.
	}
}

export function advanceRemote(peer: string): void {
	writeFileSync(join(peer, "REMOTE_CHANGE.md"), `remote update ${Date.now()}\n`);
	git(peer, "add", "REMOTE_CHANGE.md");
	git(peer, "commit", "-m", "remote-only change");
	git(peer, "push", "origin", "master");
}

export function widgetState(widget: Locator): Promise<WidgetState> {
	return widget.evaluate((node: any) => {
		// Preserve the journey's historical PR-oriented summary while also exposing
		// both independent records for resource-specific failure assertions.
		const selected = node.remotePrSnapshot ?? node.remoteGitSnapshot ?? {};
		return {
			branch: node.branch,
			behind: node.behind,
			loading: node.loading,
			prState: node.prState,
			prNumber: node.prNumber,
			prTitle: node.prTitle,
			stale: selected.stale ?? node.remoteStale,
			observedAt: selected.observedAt ?? node.remoteObservedAt,
			refreshedAt: selected.refreshedAt ?? node.remoteRefreshedAt,
			ageMs: selected.ageMs ?? node.remoteAgeMs,
			lastError: selected.lastError ?? node.remoteLastError,
			source: selected.source ?? node.remoteSource,
			gitSnapshot: node.remoteGitSnapshot,
			prSnapshot: node.remotePrSnapshot,
		};
	});
}

export async function clientJson(page: Page, path: string): Promise<{ status: number; body: any }> {
	return page.evaluate(async (url) => {
		const response = await fetch(url);
		return { status: response.status, body: response.status === 204 ? null : await response.json() };
	}, path);
}

export async function setVisible(page: Page): Promise<void> {
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

export interface RemoteStateScenario {
	page: Page;
	sessionPage: Page;
	fixture: RemoteFixture;
	goalId: string;
	sessionId: string;
	dashboardWidget: Locator;
	sessionWidget: Locator;
	dashboardGoalRow: Locator;
	sessionGoalRow: Locator;
	gitStatusRequests: string[];
	prStatusRequests: string[];
	coldSessionGitReads(): number;
	gitFetches(): number;
	prReads(): number;
	now(): number;
	advanceNow(milliseconds: number): void;
	setFailGitFetches(value: boolean): void;
	setFailPrReads(value: boolean): void;
	setPrTitle(value: string): void;
	setReviewDecision(value: string): void;
	holdNextGitFetch(): void;
	releaseHeldGitFetch(): void;
	holdNextPrRead(): void;
	releaseHeldPrRead(): void;
	cleanup(): Promise<void>;
}

/**
 * The Git fixture uses a real local bare remote. Only the identity probe is
 * projected as GitHub, allowing the credential-free fake `gh` fixture to drive
 * the PR coordinator while every Git fetch remains local and observable.
 */
export async function startRemoteStateScenario(options: {
	page: Page;
	context: BrowserContext;
	gateway: any;
	label: string;
}): Promise<RemoteStateScenario> {
	const { page, context, gateway, label } = options;
	let fixture: RemoteFixture | undefined;
	let goalId = "";
	let sessionId = "";
	let sessionPage: Page | undefined;
	const runner = gateway.sessionManager.commandRunner as any;
	const clock = gateway.sessionManager.clock as any;
	const originalExecFile = runner.execFile;
	const originalNow = clock.now;
	let now = originalNow.call(clock);
	let gitFetches = 0;
	let prReads = 0;
	let failGitFetches = false;
	let failPrReads = false;
	let prTitle = "Coordinator fixture PR";
	let reviewDecision = "REVIEW_REQUIRED";
	let releaseGitFetch: (() => void) | undefined;
	let heldGitFetch: Promise<void> | undefined;
	let releasePrRead: (() => void) | undefined;
	let heldPrRead: Promise<void> | undefined;
	let coldSessionGitReads = 0;
	const gitStatusRequests: string[] = [];
	const prStatusRequests: string[] = [];
	context.on("request", (request) => {
		const url = request.url();
		if (url.includes("/git-status")) gitStatusRequests.push(url);
		if (url.includes("/pr-status")) prStatusRequests.push(url);
	});

	const holdNextGitFetch = () => {
		heldGitFetch = new Promise<void>((resolve) => { releaseGitFetch = resolve; });
	};
	const releaseHeldGitFetch = () => {
		heldGitFetch = undefined;
		releaseGitFetch?.();
	};
	const holdNextPrRead = () => {
		heldPrRead = new Promise<void>((resolve) => { releasePrRead = resolve; });
	};
	const releaseHeldPrRead = () => {
		heldPrRead = undefined;
		releasePrRead?.();
	};
	const cleanup = async () => {
		releaseHeldGitFetch();
		releaseHeldPrRead();
		clock.now = originalNow;
		runner.execFile = originalExecFile;
		await page.goto("about:blank").catch(() => {});
		if (sessionPage) await sessionPage.close().catch(() => {});
		if (sessionId) await deleteSession(sessionId);
		if (goalId) await deleteGoal(goalId, true);
		await removeFixture(fixture);
	};

	try {
		await page.clock.install();
	fixture = await createRemoteFixture(label);
	goalId = (await createGoal({
		title: `remote-state ${label} ${Date.now()}`,
		cwd: fixture.repo,
		projectId: fixture.projectId,
		worktree: false,
		team: false,
	})).id;
	gateway.sessionManager.getGoalStoreForProject(fixture.projectId).update(goalId, {
		branch: "master",
		cwd: fixture.repo,
		repoPath: fixture.repo,
		worktreePath: fixture.repo,
		setupStatus: "ready",
		team: false,
		autoStartTeam: false,
		workflowId: null,
		workflow: null,
	});
	sessionId = await createSession({ cwd: fixture.repo, goalId, projectId: fixture.projectId });
	await waitForSessionStatus(sessionId, "idle");

	clock.now = () => now;
	holdNextGitFetch();
	holdNextPrRead();
	runner.execFile = async (file: string, args: readonly string[], execOptions?: { cwd?: string }) => {
		const command = basename(file).replace(/\.exe$/i, "").toLowerCase();
		const argv = args.join(" ");
		if (command === "git" && argv === "remote get-url origin" && execOptions?.cwd === fixture!.repo) {
			return { stdout: `https://github.com/bobbit-fixtures/remote-state-${label}.git\n`, stderr: "" };
		}
		if (command === "git" && argv === "fetch --quiet" && execOptions?.cwd === fixture!.repo) {
			gitFetches++;
			if (heldGitFetch) await heldGitFetch;
			if (failGitFetches) {
				throw Object.assign(new Error("fixture-git-offline-private-detail"), {
					code: "ENETUNREACH",
					stderr: "url=https://secret@example.test/private-ref",
				});
			}
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "list" && execOptions?.cwd === fixture!.repo) {
			prReads++;
			if (heldPrRead) await heldPrRead;
			if (failPrReads) {
				throw Object.assign(new Error("fixture-offline-private-detail"), {
					code: "ENETUNREACH",
					stderr: "url=https://secret@example.test/private-ref",
				});
			}
			return {
				stdout: JSON.stringify([{
					number: 42,
					url: `https://github.com/bobbit-fixtures/remote-state-${label}/pull/42`,
					title: prTitle,
					state: "OPEN",
					mergeable: "MERGEABLE",
					headRefName: args[args.indexOf("--head") + 1],
					baseRefName: "master",
					headRepository: { name: `remote-state-${label}` },
					headRepositoryOwner: { login: "bobbit-fixtures" },
					isCrossRepository: false,
					reviewDecision,
				}]),
				stderr: "",
			};
		}
		if (command === "gh" && args[0] === "api") {
			return {
				stdout: JSON.stringify({
					data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } },
				}),
				stderr: "",
			};
		}
		return originalExecFile.call(runner, file, args, execOptions);
	};

	await openApp(page);
	await navigateToHash(page, `#/goal/${goalId}`);
	const dashboardWidget = page.locator(".dashboard-git-row git-status-widget").first();
	await expect(dashboardWidget).toBeAttached({ timeout: 15_000 });

	sessionPage = await context.newPage();
	await sessionPage.clock.install();
	await sessionPage.route(`**/api/sessions/${sessionId}/git-status*`, async (route) => {
		if (coldSessionGitReads++ > 0) {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ observedAt: now, stale: true, source: "repository", ageMs: 0 }),
		});
	});
	await openApp(sessionPage);
	await navigateToHash(sessionPage, `#/session/${sessionId}`);
	const sessionWidget = sessionPage.locator("pi-chat-panel git-status-widget").first();
	await expect(sessionWidget).toBeAttached({ timeout: 15_000 });
	const dashboardGoalRow = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	const sessionGoalRow = sessionPage.locator(`[data-nav-id="goal:${goalId}"]`).first();

	return {
		page,
		sessionPage,
		fixture,
		goalId,
		sessionId,
		dashboardWidget,
		sessionWidget,
		dashboardGoalRow,
		sessionGoalRow,
		gitStatusRequests,
		prStatusRequests,
		coldSessionGitReads: () => coldSessionGitReads,
		gitFetches: () => gitFetches,
		prReads: () => prReads,
		now: () => now,
		advanceNow: (milliseconds) => { now += milliseconds; },
		setFailGitFetches: (value) => { failGitFetches = value; },
		setFailPrReads: (value) => { failPrReads = value; },
		setPrTitle: (value) => { prTitle = value; },
		setReviewDecision: (value) => { reviewDecision = value; },
		holdNextGitFetch,
		releaseHeldGitFetch,
		holdNextPrRead,
		releaseHeldPrRead,
		cleanup,
	};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
