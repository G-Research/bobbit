/**
 * Sandbox bridge — runs the LSP child inside a project's pool container.
 * Mirror of `rpc-bridge.ts::spawnDockerExec` for non-agent processes.
 *
 * Used by `LspSupervisor` when configured with `{ sandbox }`. The supervisor
 * passes host paths; this bridge translates to container paths via the same
 * `toDockerPath()` helper used by docker-args.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { SandboxLspBridge } from "./client.js";
import type { SandboxManager } from "../agent/sandbox-manager.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import { toDockerPath } from "../agent/rpc-bridge.js";

/**
 * Maps a host worktree path to its container path. The bind mount root is
 * `<project worktree-root>` → `/workspace-wt`, established at sandbox
 * creation time. We derive the container path purely lexically: replace
 * the host worktree-root prefix with `/workspace-wt`.
 */
export class DockerSandboxLspBridge implements SandboxLspBridge {
	constructor(
		private sandboxManager: SandboxManager,
		private projectId: string,
		private hostWorktreeRoot: string,
		private containerWorktreeRoot = "/workspace-wt",
	) {}

	containerIdForWorktree(_hostWorktreePath: string): string | null {
		const sb = this.sandboxManager.get(this.projectId) as any;
		// ProjectSandbox keeps containerId private; getStatus() exposes it.
		if (!sb) return null;
		try { return sb.getStatus?.().containerId ?? null; }
		catch { return null; }
	}

	toContainerPath(hostPath: string): string {
		const rel = path.relative(this.hostWorktreeRoot, hostPath);
		if (rel.startsWith("..")) {
			// Outside the worktree root — best-effort docker path
			return toDockerPath(hostPath);
		}
		return `${this.containerWorktreeRoot}/${rel.replace(/\\/g, "/")}`;
	}

	toHostPath(containerPath: string): string {
		if (containerPath.startsWith(this.containerWorktreeRoot + "/")) {
			const rel = containerPath.slice(this.containerWorktreeRoot.length + 1);
			return path.join(this.hostWorktreeRoot, rel);
		}
		return containerPath;
	}

	spawn(args: { containerId: string; cmd: string[]; cwd: string; env?: Record<string, string> }): ChildProcess {
		const execArgs: string[] = ["exec", "-i", "-w", args.cwd];
		for (const [k, v] of Object.entries(args.env ?? {})) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
			execArgs.push("-e", `${k}=${v}`);
		}
		execArgs.push(args.containerId, ...args.cmd);
		return spawn("docker", execArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}
}

/**
 * Multi-project bridge (finding #6 plumbing). Picks the right project by
 * matching the worktree path against each registered project's rootPath.
 *
 * Full container-path translation (output paths returned by the LSP child
 * mapped back to host paths) is wired through `DockerSandboxLspBridge`.
 * V1 plumbing: this construction puts the bridge in place; deeper container
 * path round-tripping for diagnostics/definitions across sandboxed sessions
 * may need refinement — see docs/design/lsp-code-intelligence.md §Sandbox.
 */
export class MultiProjectSandboxLspBridge implements SandboxLspBridge {
	/** Tracks the last-resolved per-project bridge so toHostPath can reverse-
	 *  translate container paths without a separate lookup hint. The supervisor
	 *  creates one bridge per LSP process and calls bridgeForHostPath
	 *  consistently for the same worktree, so this reliably reflects the
	 *  active project for the lifetime of that process. */
	private lastBridge: DockerSandboxLspBridge | null = null;

	constructor(
		private sandboxManager: SandboxManager,
		private projectContextManager: ProjectContextManager,
	) {}

	private bridgeForHostPath(hostPath: string): DockerSandboxLspBridge | null {
		const abs = path.resolve(hostPath);
		let best: { projectId: string; root: string; worktreeRoot: string } | null = null;
		for (const ctx of this.projectContextManager.all()) {
			// Only consider sandbox-configured projects. For projects that have
			// NOT opted into the docker sandbox (e.g. plain host projects, or the
			// E2E test harness's default project) there is no fail-closed
			// boundary to enforce — the host LSP is the correct choice. Skipping
			// these here prevents `spawnLspChild`'s fail-closed guard
			// (`server-process.ts`, security review 2026-05-15) from rejecting
			// LSP requests for non-sandboxed worktrees. Pinned by
			// `tests/lsp/sandbox-bridge-resolve.spec.ts` and `tests/e2e/lsp.spec.ts`.
			const sandboxMode = (ctx.projectConfigStore as any)?.get?.("sandbox");
			if (sandboxMode !== "docker") continue;
			const root = path.resolve(ctx.project.rootPath);
			// Respect the project's worktree_root config if set; otherwise default
			// to the conventional <rootPath>-wt sibling directory.
			const configuredRoot = (ctx.projectConfigStore as any)?.get?.("worktree_root") as string | undefined;
			const worktreeRoot = configuredRoot ? path.resolve(configuredRoot) : root + "-wt";
			const matches =
				abs === root ||
				abs.startsWith(root + path.sep) ||
				abs === worktreeRoot ||
				abs.startsWith(worktreeRoot + path.sep);
			if (matches) {
				if (!best || root.length > best.root.length) {
					best = { projectId: ctx.project.id ?? ctx.project.name, root, worktreeRoot };
				}
			}
		}
		if (!best) return null;
		// Worktree root is bind-mounted at `/workspace-wt` inside the container.
		const bridge = new DockerSandboxLspBridge(
			this.sandboxManager,
			best.projectId,
			best.worktreeRoot,
		);
		this.lastBridge = bridge;
		return bridge;
	}

	/** Return a stable per-project bridge for a specific worktree (avoids
	 *  shared mutable state for multi-project scenarios). Returns `null` when
	 *  the worktree is NOT inside any sandbox-configured project — callers
	 *  treat that as a host worktree (no sandbox path, no fail-closed). */
	resolveForWorktree(worktreePath: string): SandboxLspBridge | null {
		return this.bridgeForHostPath(worktreePath);
	}

	containerIdForWorktree(hostWorktreePath: string): string | null {
		return this.bridgeForHostPath(hostWorktreePath)?.containerIdForWorktree(hostWorktreePath) ?? null;
	}

	toContainerPath(hostPath: string): string {
		return this.bridgeForHostPath(hostPath)?.toContainerPath(hostPath) ?? toDockerPath(hostPath);
	}

	toHostPath(containerPath: string): string {
		// Best-effort: use the most-recently-resolved per-project bridge.
		// The supervisor holds one bridge instance per LSP process and calls
		// bridgeForHostPath for the same worktree, so lastBridge reliably
		// reflects the active project once any outbound call has been made.
		if (this.lastBridge) {
			const translated = this.lastBridge.toHostPath(containerPath);
			if (translated !== containerPath) return translated;
		}
		return containerPath;
	}

	spawn(args: { containerId: string; cmd: string[]; cwd: string; env?: Record<string, string> }): ChildProcess {
		const execArgs: string[] = ["exec", "-i", "-w", args.cwd];
		for (const [k, v] of Object.entries(args.env ?? {})) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
			execArgs.push("-e", `${k}=${v}`);
		}
		execArgs.push(args.containerId, ...args.cmd);
		return spawn("docker", execArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}
}
