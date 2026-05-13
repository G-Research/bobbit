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
