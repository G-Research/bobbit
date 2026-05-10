/**
 * Per-session git endpoints — file-content, git-status, git-diff, commits,
 * pr-status, git-pull, git-push, git-squash-push, git-merge-primary, pr-merge.
 * Extracted from server.ts (commit: split server.ts).
 */
import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import { execGit, execGitSafe } from "../git/git-exec.js";
import { batchGitStatus, invalidateGitStatusCache } from "../git/git-status.js";
import { getGitDiff } from "../git/git-diff.js";
import { getCachedPrStatus, clearPrStatusCache } from "../git/pr-status.js";
import { shouldSkipRemotePush } from "../skills/git.js";
import { getGoalAcrossProjects } from "./cross-project.js";
import type { Route } from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

export const sessionsGitRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/file-content$/,
		handler: ({ deps, params, url, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }

			const filePath = url.searchParams.get("path");
			if (!filePath) { json({ error: "Missing path parameter" }, 400); return; }

			const snapshotId = url.searchParams.get("snapshotId");
			const snapshotDir = path.join(bobbitStateDir(), "html-snapshots");
			const snapshotFile = snapshotId ? path.join(snapshotDir, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`) : null;

			if (snapshotFile && fs.existsSync(snapshotFile)) {
				try {
					const content = fs.readFileSync(snapshotFile, "utf-8");
					json({ content });
				} catch {
					json({ error: "Snapshot read failed" }, 500);
				}
				return;
			}

			const resolved = path.isAbsolute(filePath)
				? path.resolve(filePath)
				: path.resolve(session.cwd, filePath);

			try {
				const stat = fs.statSync(resolved);
				if (stat.isDirectory() || stat.size > 512 * 1024) {
					json({ error: "File too large or is a directory" }, 400);
					return;
				}
				const content = fs.readFileSync(resolved, "utf-8");

				if (snapshotFile) {
					try {
						fs.mkdirSync(snapshotDir, { recursive: true });
						fs.writeFileSync(snapshotFile, content, "utf-8");
					} catch { /* best-effort */ }
				}

				json({ content });
			} catch {
				json({ error: "File not found" }, 404);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/git-status$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;

			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }

			const sessUntracked = url.searchParams.get('untracked') === '1';
			if (url.searchParams.get('fetch') === 'true') {
				try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
				invalidateGitStatusCache(cwd, cid);
			}

			let result: Awaited<ReturnType<typeof batchGitStatus>> | undefined;
			try {
				result = await batchGitStatus(cwd, cid, { untracked: sessUntracked });
			} catch (err: any) {
				console.error("[git-status handler] error for session", id, "cwd=", cwd, "code=", err?.code, "signal=", err?.signal, "killed=", err?.killed, "stderr=", err?.stderr, "message=", err?.message);
				jsonError(500, err, { error: err?.stderr?.trim() || err?.message || "git status failed" });
				return;
			}
			if (!result) { json({ error: "Not a git repository" }, 400); return; }

			json(result);

			if (!shouldSkipRemotePush()) {
				if (!result.isOnPrimary && result.ahead > 0 && result.hasUpstream) {
					execAsync('git push', { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
				} else if (!result.isOnPrimary && !result.hasUpstream && result.branch && /^session\//.test(result.branch)) {
					execAsync(`git push -u origin ${result.branch}`, { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
				}
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/git-diff$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			const file = url.searchParams.get("file") || undefined;
			try {
				const diff = await getGitDiff(cwd, file, cid);
				json({ diff });
			} catch (err: any) {
				if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
				if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/commits$/,
		handler: async ({ deps, params, url, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: 'Session not found' }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ commits: [] }); return; }
			try {
				let branch = '';
				try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd, 5000, cid); }
				catch { json({ commits: [] }); return; }

				let hasUpstream = false;
				try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd, 5000, cid); hasUpstream = true; } catch {}

				const limit = 50;
				const direction = url.searchParams.get('direction');
				const vs = url.searchParams.get('vs');
				let rangeSpec: string;
				if (vs === 'primary') {
					let primaryBranch = 'master';
					try {
						const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd, 5000, cid);
						primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
					} catch {
						try { await execGit('git rev-parse --verify refs/heads/master', cwd, 5000, cid); primaryBranch = 'master'; }
						catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd, 5000, cid); primaryBranch = 'main'; } catch {} }
					}
					let primaryRef = primaryBranch;
					try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch {}
					rangeSpec = direction === 'behind' ? `HEAD..${primaryRef}` : `${primaryRef}..HEAD`;
				} else {
					rangeSpec = direction === 'behind' && hasUpstream
						? 'HEAD..@{u}'
						: hasUpstream ? '@{u}..HEAD' : `-${limit} HEAD`;
				}

				const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" --shortstat ${rangeSpec}`, cwd, 10000, cid);
				const lines = out.split('\n');
				const commits: Array<{sha: string; shortSha: string; message: string; author: string; timestamp: string; filesChanged: number; insertions: number; deletions: number}> = [];

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (!line.includes('|')) continue;
					const parts = line.split('|');
					if (parts.length < 5) continue;
					const [sha, shortSha, message, author, timestamp] = parts;
					let filesChanged = 0, insertions = 0, deletions = 0;
					for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
						const statLine = lines[j].trim();
						if (statLine.includes('file') && statLine.includes('changed')) {
							const fm = statLine.match(/(\d+) file/);
							const im = statLine.match(/(\d+) insertion/);
							const dm = statLine.match(/(\d+) deletion/);
							if (fm) filesChanged = parseInt(fm[1], 10);
							if (im) insertions = parseInt(im[1], 10);
							if (dm) deletions = parseInt(dm[1], 10);
							break;
						}
					}
					commits.push({ sha, shortSha, message, author, timestamp, filesChanged, insertions, deletions });
				}

				json({ commits });
			} catch (e: any) {
				json({ error: 'Failed to read git log', detail: e.message }, 500);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/pr-status$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			const goalBranch = session.goalId ? getGoalAcrossProjects(deps, session.goalId)?.branch : undefined;
			let sessionBranch = goalBranch || deps.sessionManager.getPersistedSession(id)?.branch;
			if (cid && cwd) {
				try {
					const actualBranch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
					if (actualBranch && actualBranch !== "HEAD") sessionBranch = actualBranch;
				} catch { /* fall back to persisted branch */ }
			}
			const prCwd = cid ? (session.worktreePath || process.cwd()) : cwd;
			const pr = await getCachedPrStatus(prCwd, sessionBranch, process.cwd());
			if (pr) {
				const goalId = session.goalId;
				if (goalId) deps.prStatusStore.set(goalId, pr);
				json(pr);
			} else { json({ error: "No PR found" }, 404); }
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/git-pull$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			try {
				const output = await execGit('git pull', cwd, 30000, cid);
				invalidateGitStatusCache(cwd, cid);
				json({ ok: true, output });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				json({ error: msg }, 500);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/git-push$/,
		handler: async ({ deps, params, json }) => {
			if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			try {
				const output = await execGit('git push', cwd, 30000, cid);
				invalidateGitStatusCache(cwd, cid);
				json({ ok: true, output });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				json({ error: msg }, 500);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/git-squash-push$/,
		handler: async ({ deps, params, json }) => {
			if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			try {
				let primaryBranch = "master";
				try {
					const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
					primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
				} catch {
					try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
					catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
				}

				await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
				const primaryRef = `origin/${primaryBranch}`;

				const aheadCount = parseInt(await execGit(`git rev-list --count ${primaryRef}..HEAD`, cwd, 5000, cid), 10) || 0;
				if (aheadCount === 0) { json({ error: "No commits ahead of master" }, 400); return; }

				const logOutput = await execGit(`git log --format="%s" ${primaryRef}..HEAD`, cwd, 5000, cid);
				const commitMessages = logOutput.trim().split("\n").filter(Boolean);
				const branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
				const summary = commitMessages.length === 1
					? commitMessages[0]
					: `Squash ${branch} (${commitMessages.length} commits)`;
				const body = commitMessages.length > 1
					? commitMessages.map(m => `- ${m}`).join("\n")
					: "";
				const fullMessage = body ? `${summary}\n\n${body}` : summary;

				const mergeTree = await execGit(`git merge-tree --write-tree ${primaryRef} HEAD`, cwd, 5000, cid);
				const msgFile = cid ? `/tmp/SQUASH_MSG_${Date.now()}` : path.join(cwd, ".git", "SQUASH_MSG");
				if (cid) {
					await execFileAsync("docker", [
						"exec", "-w", cwd, cid, "/bin/sh", "-c", `cat > ${msgFile} << 'BOBBIT_EOF'\n${fullMessage}\nBOBBIT_EOF`,
					], { encoding: "utf-8", timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
				} else {
					fs.writeFileSync(msgFile, fullMessage, "utf-8");
				}
				const squashCommit = await execGit(`git commit-tree ${mergeTree} -p ${primaryRef} -F "${msgFile}"`, cwd, 5000, cid);
				if (cid) {
					await execGit(`rm -f ${msgFile}`, cwd, 5000, cid).catch(() => {});
				} else {
					fs.unlinkSync(msgFile);
				}
				await execGit(`git push origin ${squashCommit}:refs/heads/${primaryBranch}`, cwd, 30000, cid);
				invalidateGitStatusCache(cwd, cid);

				json({ ok: true, output: `Squash pushed ${aheadCount} commit${aheadCount > 1 ? "s" : ""} to ${primaryBranch}` });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("CONFLICT") || msg.includes("merge-tree")) {
					json({ error: "Merge conflicts with master. Use 'Merge master' first to resolve." }, 409);
				} else {
					json({ error: msg }, 500);
				}
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/git-merge-primary$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			try {
				let primaryBranch = "master";
				try {
					const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
					primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
				} catch {
					try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
					catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
				}
				await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
				const output = await execGit(`git rebase origin/${primaryBranch}`, cwd, 30000, cid);

				const aheadAfter = parseInt(await execGitSafe(`git rev-list --count origin/${primaryBranch}..HEAD`, cwd, "0", cid), 10) || 0;
				if (aheadAfter > 0) {
					const diff = await execGitSafe(`git diff origin/${primaryBranch}..HEAD`, cwd, "", cid);
					if (diff.trim() === "") {
						await execGit(`git reset --hard origin/${primaryBranch}`, cwd, 10000, cid);
						invalidateGitStatusCache(cwd, cid);
						json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
						return;
					}
				}
				invalidateGitStatusCache(cwd, cid);

				json({ ok: true, output });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				json({ error: msg }, 500);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/pr-merge$/,
		handler: async ({ deps, params, readBody, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const cwd = session.cwd;
			const cid = session.sandboxed ? session.containerId : undefined;
			if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
			const body = await readBody();
			const method = body?.method ?? "squash";
			if (!["merge", "squash", "rebase"].includes(method)) {
				json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
				return;
			}
			const sessAdminFlag = body?.admin ? " --admin" : "";
			const clientBranch = typeof body?.branch === "string" ? body.branch : undefined;
			const goalBranch = session.goalId ? getGoalAcrossProjects(deps, session.goalId)?.branch : undefined;
			const sessMergeBranch = clientBranch || goalBranch || deps.sessionManager.getPersistedSession(id)?.branch;
			const sessMergeBranchArg = sessMergeBranch ? ` ${sessMergeBranch}` : "";
			try {
				const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
				await execAsync(`gh pr merge${sessMergeBranchArg} --${method}${sessAdminFlag}`, { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
				clearPrStatusCache(cwd, sessMergeBranch);
				json({ ok: true });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				json({ error: msg }, 500);
			}
		},
	},
];
