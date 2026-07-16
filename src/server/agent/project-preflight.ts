/**
 * Project preflight — structured pass/warn/fail validation of a candidate
 * `rootPath` for the add-project flow. See docs/design/robust-add-project.md.
 *
 * Pure-ish: only `stat` / `readdir` / `mkdir`-probe on disk; never mutates
 * registry state. Safe to call from both the REST endpoint (for client UX)
 * and from `projectRegistry.register()` (defense in depth).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RegisteredProject } from "./project-registry.js";

/** Local copy of detectSymlinkRoot — duplicated to avoid a runtime import
 *  cycle with project-registry.ts which calls runPreflight() from inside
 *  register(). */
function detectSymlinkRoot(rootPath: string, fileSystem: PreflightFileSystem): { symlink: false } | { symlink: true; canonical: string } {
	try {
		const real = fileSystem.realpathSync(rootPath);
		const a = path.resolve(rootPath);
		const b = path.resolve(real);
		if (a !== b) return { symlink: true, canonical: b };
	} catch { /* best-effort */ }
	return { symlink: false };
}

export type PreflightLevel = "pass" | "warn" | "fail";

export interface PreflightCheckRemediation {
	kind: "archive-bobbit" | "use-canonical" | "shorter-path" | "free-space" | "external";
	label: string;
	payload?: Record<string, unknown>;
}

export interface PreflightCheck {
	id: string;
	level: PreflightLevel;
	title: string;
	detail: string;
	remediation?: PreflightCheckRemediation;
}

export interface PreflightReport {
	rootPath: string;
	canonical: string;
	checks: PreflightCheck[];
	hasFail: boolean;
}

export type PreflightFileSystem = Pick<
	typeof fs,
	| "accessSync"
	| "constants"
	| "existsSync"
	| "mkdirSync"
	| "readFileSync"
	| "readdirSync"
	| "realpathSync"
	| "rmdirSync"
	| "statSync"
	| "statfsSync"
>;

export interface PreflightContext {
	/** Snapshot of currently registered projects (excluding hidden). */
	registeredProjects: ReadonlyArray<Pick<RegisteredProject, "id" | "name" | "rootPath" | "hidden">>;
	/** Gateway's `getProjectRoot()` — used to detect `bobbit.gateway-owned`. */
	gatewayProjectRoot: string;
	/** Project worktree root lookup (defaults to `<rootPath>-wt`). */
	worktreeRootFor?: (project: { id: string; rootPath: string }) => string | undefined;
	/** Test seam for deterministic filesystem checks; production uses node:fs. */
	fileSystem?: PreflightFileSystem;
}

const FREE_SPACE_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB

function tryRealpath(p: string, fileSystem: PreflightFileSystem): string {
	try { return fileSystem.realpathSync(p); } catch { return p; }
}

function isSamePath(a: string, b: string, fileSystem: PreflightFileSystem): boolean {
	const normalize = (p: string) => path.resolve(tryRealpath(p, fileSystem)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return normalize(a) === normalize(b);
}

function isAncestorOf(parent: string, child: string): boolean {
	const a = path.resolve(parent).replace(/\\/g, "/").toLowerCase();
	const b = path.resolve(child).replace(/\\/g, "/").toLowerCase();
	if (a === b) return false;
	return b.startsWith(a.endsWith("/") ? a : a + "/");
}

function isSameOrInside(parent: string, child: string): boolean {
	const a = path.resolve(parent).replace(/\\/g, "/").toLowerCase();
	const b = path.resolve(child).replace(/\\/g, "/").toLowerCase();
	return a === b || b.startsWith(a.endsWith("/") ? a : a + "/");
}

/**
 * Run the full preflight check set against `rootPath`.
 * Always returns a report — failures are the response, not exceptions.
 */
export function runPreflight(rootPath: string, ctx: PreflightContext): PreflightReport {
	const fileSystem = ctx.fileSystem ?? fs;
	const checks: PreflightCheck[] = [];
	const canonical = (() => {
		try { return path.resolve(fileSystem.realpathSync(rootPath)); } catch { return path.resolve(rootPath); }
	})();

	// 1. path.absolute
	const isAbs = path.isAbsolute(rootPath);
	checks.push({
		id: "path.absolute",
		level: isAbs ? "pass" : "fail",
		title: "Absolute path",
		detail: isAbs ? "Path is absolute." : `Path must be absolute. Got: ${rootPath}`,
	});

	// 2. path.exists
	let exists = false;
	let isDir = false;
	let statErr: string | null = null;
	try {
		const st = fileSystem.statSync(rootPath);
		exists = true;
		isDir = st.isDirectory();
	} catch (err: any) {
		statErr = err?.message ?? String(err);
	}
	checks.push({
		id: "path.exists",
		level: exists && isDir ? "pass" : "fail",
		title: "Directory exists",
		detail: !exists
			? `Directory does not exist${statErr ? ` (${statErr})` : ""}.`
			: !isDir ? "Path exists but is not a directory." : "Directory exists.",
	});

	// Short-circuit downstream filesystem checks if the dir is unusable.
	const reachable = exists && isDir;
	const sameAsGatewayProjectRoot = reachable && isSamePath(rootPath, ctx.gatewayProjectRoot, fileSystem);

	// 3. path.symlink
	if (reachable) {
		const sym = detectSymlinkRoot(rootPath, fileSystem);
		if (sym.symlink) {
			checks.push({
				id: "path.symlink",
				level: "warn",
				title: "Symlink path",
				detail: `Path resolves through a symlink to ${sym.canonical}. The project will be registered at the canonical path.`,
				remediation: {
					kind: "use-canonical",
					label: "Use canonical path",
					payload: { canonical: sym.canonical },
				},
			});
		} else {
			checks.push({ id: "path.symlink", level: "pass", title: "Not a symlink", detail: "Path is not a symlink." });
		}
	} else {
		checks.push({ id: "path.symlink", level: "warn", title: "Not a symlink", detail: "Not checked: directory does not exist." });
	}

	// 4. path.readable
	if (reachable) {
		let readable = false;
		let readErr: string | null = null;
		try {
			fileSystem.accessSync(rootPath, fileSystem.constants.R_OK);
			fileSystem.readdirSync(rootPath);
			readable = true;
		} catch (err: any) {
			readErr = err?.message ?? String(err);
		}
		checks.push({
			id: "path.readable",
			level: readable ? "pass" : "fail",
			title: "Readable",
			detail: readable ? "Directory is readable." : `Cannot read directory: ${readErr}`,
		});
	} else {
		checks.push({ id: "path.readable", level: "warn", title: "Readable", detail: "Not checked: directory does not exist." });
	}

	// 5. path.writable
	if (reachable) {
		let writable = false;
		let writeErr: string | null = null;
		try {
			fileSystem.accessSync(rootPath, fileSystem.constants.W_OK);
			const probe = path.join(rootPath, `.bobbit-probe-${randomBytes(6).toString("hex")}`);
			fileSystem.mkdirSync(probe);
			fileSystem.rmdirSync(probe);
			writable = true;
		} catch (err: any) {
			writeErr = err?.message ?? String(err);
		}
		checks.push({
			id: "path.writable",
			level: writable ? "pass" : "fail",
			title: "Writable",
			detail: writable ? "Directory is writable (mkdir probe passed)." : `Cannot write to directory: ${writeErr}`,
		});
	} else {
		checks.push({ id: "path.writable", level: "warn", title: "Writable", detail: "Not checked: directory does not exist." });
	}

	// 6. path.long (Windows only)
	{
		const isWin = process.platform === "win32";
		const len = rootPath.length;
		if (isWin && len > 200) {
			checks.push({
				id: "path.long",
				level: "warn",
				title: "Long path",
				detail: `Path is ${len} characters. Worktree paths add ~80 chars and may exceed Windows' 260-char limit. Consider enabling long-path support or choosing a shorter root.`,
				remediation: { kind: "shorter-path", label: "Choose shorter path" },
			});
		} else {
			checks.push({
				id: "path.long",
				level: "pass",
				title: "Path length OK",
				detail: `Path is ${len} characters.`,
			});
		}
	}

	// 7. path.unc-or-network
	{
		const unc = /^\\\\/.test(rootPath) || /^\/\//.test(rootPath);
		if (unc) {
			checks.push({
				id: "path.unc-or-network",
				level: "warn",
				title: "Network path",
				detail: "Path appears to be a UNC / network share. Git worktrees on network filesystems are flaky.",
			});
		} else {
			checks.push({
				id: "path.unc-or-network",
				level: "pass",
				title: "Local path",
				detail: "Path is on a local filesystem (best-effort detection).",
			});
		}
	}

	// 8. path.nested-in-project
	{
		const gatewayRootResolved = (() => {
			try { return path.resolve(tryRealpath(ctx.gatewayProjectRoot, fileSystem)); }
			catch { return path.resolve(ctx.gatewayProjectRoot); }
		})();
		const offenders: Array<{ name: string; rootPath: string; via: "rootPath" | "worktree"; gatewayOwned: boolean }> = [];
		const me = tryRealpath(rootPath, fileSystem);
		for (const proj of ctx.registeredProjects) {
			if (proj.hidden) continue;
			const projRoot = tryRealpath(proj.rootPath, fileSystem);
			const gatewayOwned = path.resolve(projRoot) === gatewayRootResolved;
			if (isSameOrInside(projRoot, me) && path.resolve(projRoot) !== path.resolve(me)) {
				offenders.push({ name: proj.name, rootPath: proj.rootPath, via: "rootPath", gatewayOwned });
				continue;
			}
			const wtRoot = ctx.worktreeRootFor?.({ id: proj.id, rootPath: proj.rootPath }) ?? `${proj.rootPath}-wt`;
			const wtReal = tryRealpath(wtRoot, fileSystem);
			if (fileSystem.existsSync(wtReal) && isSameOrInside(wtReal, me)) {
				offenders.push({ name: proj.name, rootPath: wtRoot, via: "worktree", gatewayOwned });
			}
		}
		if (offenders.length > 0) {
			// Downgrade to warn when the only container(s) are the gateway-owned
			// project root. The gateway has to register its own working directory
			// as a project, and any sibling project the user adds inside the same
			// repo (e.g. a worktree dev workflow) would otherwise hard-fail here.
			const allGatewayOwned = offenders.every(o => o.gatewayOwned);
			checks.push({
				id: "path.nested-in-project",
				level: allGatewayOwned ? "warn" : "fail",
				title: allGatewayOwned
					? "Nested inside the gateway project"
					: "Nested inside another project",
				detail: offenders.map(o =>
					`Inside ${o.via === "worktree" ? "worktree root" : "project"} "${o.name}" at ${o.rootPath}${o.gatewayOwned ? " (gateway-owned)" : ""}.`,
				).join(" "),
			});
		} else {
			checks.push({
				id: "path.nested-in-project",
				level: "pass",
				title: "Not nested in another project",
				detail: "Path is not inside any other registered project or worktree root.",
			});
		}
	}

	// 9. path.contains-project
	{
		const containers: string[] = [];
		const me = tryRealpath(rootPath, fileSystem);
		for (const proj of ctx.registeredProjects) {
			if (proj.hidden) continue;
			const projRoot = tryRealpath(proj.rootPath, fileSystem);
			if (isAncestorOf(me, projRoot)) {
				containers.push(`"${proj.name}" at ${proj.rootPath}`);
			}
		}
		if (containers.length > 0) {
			checks.push({
				id: "path.contains-project",
				level: "warn",
				title: "Contains existing projects",
				detail: `This path is an ancestor of: ${containers.join(", ")}.`,
			});
		} else {
			checks.push({
				id: "path.contains-project",
				level: "pass",
				title: "Does not contain other projects",
				detail: "No registered projects live under this path.",
			});
		}
	}

	// 10. path.is-worktree
	if (reachable) {
		const gitPath = path.join(rootPath, ".git");
		let isSecondaryWorktree = false;
		let detail = "Path is not a secondary git worktree.";
		try {
			const st = fileSystem.statSync(gitPath);
			if (st.isFile()) {
				const content = fileSystem.readFileSync(gitPath, "utf-8");
				const m = content.match(/^gitdir:\s*(.+)$/m);
				if (m) {
					const target = m[1].trim();
					if (/[\\/]worktrees[\\/][^\\/]+\/?$/.test(target)) {
						isSecondaryWorktree = true;
						detail = `\`${gitPath}\` is a secondary worktree pointing at ${target}. Register the primary checkout instead.`;
					}
				}
			}
		} catch { /* no .git — fine */ }
		checks.push({
			id: "path.is-worktree",
			level: isSecondaryWorktree ? "fail" : "pass",
			title: "Not a secondary worktree",
			detail,
		});
	} else {
		checks.push({ id: "path.is-worktree", level: "warn", title: "Not a secondary worktree", detail: "Not checked: directory does not exist." });
	}

	// 11. bobbit.existing
	if (reachable) {
		const bobbitConfig = path.join(rootPath, ".bobbit", "config");
		const bobbitState = path.join(rootPath, ".bobbit", "state");
		const stats = summarizeBobbitDir(rootPath, fileSystem);
		if (stats.totalEntries > 0) {
			if (sameAsGatewayProjectRoot) {
				const headquartersPath = path.join(rootPath, ".bobbit", "headquarters");
				const normalStatePath = path.join(rootPath, ".bobbit", "state");
				const normalConfigPath = path.join(rootPath, ".bobbit", "config");
				checks.push({
					id: "bobbit.existing",
					level: "warn",
					title: "Server run directory .bobbit/ found",
					detail:
						`Found existing .bobbit/ contents: ${stats.summary}. ` +
						`This is the server run directory; Headquarters server state may live under ${headquartersPath}. ` +
						`Adding this path creates a separate normal project using ${normalStatePath} and ${normalConfigPath}. ` +
						"Archive/delete remediation is not offered here so Headquarters state is preserved.",
				});
			} else {
				checks.push({
					id: "bobbit.existing",
					level: "warn",
					title: "Existing .bobbit/ found",
					detail:
						`Found existing .bobbit/ contents: ${stats.summary}. ` +
						`You can archive this aside into .bobbit-archive-NNN/ before registering.`,
					remediation: {
						kind: "archive-bobbit",
						label: "Archive existing .bobbit/",
						payload: { rootPath, summary: stats.summary },
					},
				});
			}
		} else {
			checks.push({
				id: "bobbit.existing",
				level: "pass",
				title: "No prior .bobbit/ state",
				detail: fileSystem.existsSync(bobbitConfig) || fileSystem.existsSync(bobbitState)
					? ".bobbit/ exists but is empty."
					: "No .bobbit/ directory yet.",
			});
		}
	} else {
		checks.push({ id: "bobbit.existing", level: "warn", title: "Existing .bobbit/", detail: "Not checked: directory does not exist." });
	}

	// 12. bobbit.gateway-owned
	{
		const sameAsGateway = sameAsGatewayProjectRoot;
		const hasGwUrl = exists && fileSystem.existsSync(path.join(rootPath, ".bobbit", "state", "gateway-url"));
		const hasWatchdog = exists && fileSystem.existsSync(path.join(rootPath, ".bobbit", "state", "watchdog.json"));
		const gatewayOwned = sameAsGateway || hasGwUrl || hasWatchdog;
		if (gatewayOwned) {
			const reasons: string[] = [];
			if (sameAsGateway) reasons.push("matches the running gateway's project root");
			if (hasGwUrl) reasons.push("contains state/gateway-url");
			if (hasWatchdog) reasons.push("contains state/watchdog.json");
			checks.push({
				id: "bobbit.gateway-owned",
				level: "warn",
				title: sameAsGateway ? "Server run directory" : "Gateway-owned directory",
				detail: sameAsGateway
					? "This path is the running gateway's server run directory. Headquarters/server state must be preserved; Add Project will not offer archive/delete remediation here."
					: `This path is the running gateway's own working directory (${reasons.join("; ")}). Archive operations will preserve gateway-owned files.`,
			});
		} else {
			checks.push({
				id: "bobbit.gateway-owned",
				level: "pass",
				title: "Not gateway-owned",
				detail: "This path is not the running gateway's own working directory.",
			});
		}
	}

	// 13. git.repo
	if (reachable) {
		const gitPath = path.join(rootPath, ".git");
		if (fileSystem.existsSync(gitPath)) {
			let kind = "git repository";
			try {
				const st = fileSystem.statSync(gitPath);
				if (st.isFile()) kind = "worktree (.git is a file)";
				else if (st.isDirectory()) kind = "git repository (.git directory)";
			} catch { /* ignore */ }
			checks.push({
				id: "git.repo",
				level: "pass",
				title: "Git repository",
				detail: `Detected ${kind}.`,
			});
		} else {
			checks.push({
				id: "git.repo",
				level: "pass",
				title: "Not a git repository",
				detail: "No .git found. Bobbit can still manage this path; worktree pooling will be disabled.",
			});
		}
	} else {
		checks.push({ id: "git.repo", level: "pass", title: "Git repository", detail: "Not checked: directory does not exist." });
	}

	// 14. disk.space
	if (reachable) {
		try {
			const free = fileSystem.statfsSync
				? ((): number => {
					const s = fileSystem.statfsSync(rootPath);
					return Number(s.bavail) * Number(s.bsize);
				})()
				: NaN;
			if (Number.isFinite(free)) {
				const mb = Math.round(free / (1024 * 1024));
				if (free < FREE_SPACE_THRESHOLD_BYTES) {
					checks.push({
						id: "disk.space",
						level: "warn",
						title: "Low free disk space",
						detail: `Only ${mb} MB free on the volume containing this path. Worktree pools and session logs will fill this fast.`,
						remediation: { kind: "free-space", label: "Free up disk space" },
					});
				} else {
					checks.push({
						id: "disk.space",
						level: "pass",
						title: "Free disk space OK",
						detail: `${mb} MB free.`,
					});
				}
			} else {
				checks.push({
					id: "disk.space",
					level: "pass",
					title: "Free disk space",
					detail: "statfs not supported on this platform; not checked.",
				});
			}
		} catch (err: any) {
			checks.push({
				id: "disk.space",
				level: "pass",
				title: "Free disk space",
				detail: `Could not query free space (${err?.message ?? String(err)}).`,
			});
		}
	} else {
		checks.push({ id: "disk.space", level: "pass", title: "Free disk space", detail: "Not checked: directory does not exist." });
	}

	const hasFail = checks.some(c => c.level === "fail");
	return { rootPath, canonical, checks, hasFail };
}

interface BobbitSummary { totalEntries: number; summary: string; }

function summarizeBobbitDir(rootPath: string, fileSystem: PreflightFileSystem): BobbitSummary {
	const bobbitDir = path.join(rootPath, ".bobbit");
	if (!fileSystem.existsSync(bobbitDir)) return { totalEntries: 0, summary: "(none)" };
	let configFiles = 0;
	let sessions = 0;
	let goals = 0;
	let other = 0;
	let total = 0;
	const walk = (dir: string, depth: number, base: string): void => {
		let entries: fs.Dirent[] = [];
		try { entries = fileSystem.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]; }
		catch { return; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			const rel = path.posix.join(base, e.name.replace(/\\/g, "/"));
			if (e.isDirectory()) {
				if (depth < 3) walk(full, depth + 1, rel);
				continue;
			}
			total++;
			if (rel.startsWith("config/")) configFiles++;
			else if (rel === "state/sessions.json") sessions = countJsonArrayEntries(full, fileSystem);
			else if (rel === "state/goals.json" || rel.endsWith("/goals.json")) goals += countJsonArrayEntries(full, fileSystem);
			else other++;
		}
	};
	walk(bobbitDir, 0, "");
	const parts: string[] = [];
	if (sessions > 0) parts.push(`${sessions} session${sessions === 1 ? "" : "s"}`);
	if (goals > 0) parts.push(`${goals} goal${goals === 1 ? "" : "s"}`);
	if (configFiles > 0) parts.push(`${configFiles} config file${configFiles === 1 ? "" : "s"}`);
	if (other > 0) parts.push(`${other} other file${other === 1 ? "" : "s"}`);
	return {
		totalEntries: total,
		summary: parts.length > 0 ? parts.join(", ") : `${total} file${total === 1 ? "" : "s"}`,
	};
}

function countJsonArrayEntries(file: string, fileSystem: PreflightFileSystem): number {
	try {
		const raw = fileSystem.readFileSync(file, "utf-8");
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.length : 0;
	} catch { return 0; }
}
