import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const requireForScript = createRequire(import.meta.url);
const AGENT_PREFIX = "/home/node/.bobbit/agent/sessions";
const STATE_PREFIX = "/bobbit-state/sessions";

export interface SandboxExecCall {
	args: string[];
	mappedArgs: string[];
}

export interface SandboxSessionFilesystemOptions {
	root: string;
	hostAgentSessionsDir: string;
	removeWorktree?: (name: string) => void | Promise<void>;
	beforeExec?: (args: string[], filesystem: SandboxSessionFilesystem) => void | Promise<void>;
}

/**
 * Deterministic no-Docker model of the two container session mounts. The one
 * trusted flat publication stage is mapped back to the real host sessions root;
 * every other container path resolves beneath an isolated fake container root.
 */
export class SandboxSessionFilesystem {
	readonly calls: SandboxExecCall[] = [];
	readonly root: string;
	readonly hostAgentSessionsDir: string;
	beforeExec?: SandboxSessionFilesystemOptions["beforeExec"];
	private readonly removeWorktreeHook?: SandboxSessionFilesystemOptions["removeWorktree"];

	constructor(options: SandboxSessionFilesystemOptions) {
		this.root = options.root;
		this.hostAgentSessionsDir = options.hostAgentSessionsDir;
		this.beforeExec = options.beforeExec;
		this.removeWorktreeHook = options.removeWorktree;
		fs.mkdirSync(this.root, { recursive: true });
	}

	hostPath(containerPath: string): string {
		const mapping = containerPath === AGENT_PREFIX || containerPath.startsWith(`${AGENT_PREFIX}/`)
			? { prefix: AGENT_PREFIX, root: path.join(this.root, "agent-sessions") }
			: containerPath === STATE_PREFIX || containerPath.startsWith(`${STATE_PREFIX}/`)
				? { prefix: STATE_PREFIX, root: path.join(this.root, "state-sessions") }
				: undefined;
		if (!mapping) throw new Error(`unexpected container path: ${containerPath}`);
		const relative = containerPath.slice(mapping.prefix.length).replace(/^\/+/, "");
		if (!relative || relative.split("/").some(part => !part || part === "." || part === "..")) {
			if (!relative) return mapping.root;
			throw new Error(`non-canonical container path: ${containerPath}`);
		}
		if (mapping.prefix === AGENT_PREFIX && !relative.includes("/") && /^\.bobbit-stage-[^/]+\.tmp$/.test(relative)) {
			return path.join(this.hostAgentSessionsDir, relative);
		}
		return path.join(mapping.root, ...relative.split("/"));
	}

	private mapArgument(value: string): string {
		if (value === AGENT_PREFIX || value.startsWith(`${AGENT_PREFIX}/`)
			|| value === STATE_PREFIX || value.startsWith(`${STATE_PREFIX}/`)) {
			return this.hostPath(value);
		}
		return value;
	}

	async exec(args: string[]): Promise<string> {
		await this.beforeExec?.(args, this);
		const mappedArgs = args.map(value => this.mapArgument(value));
		this.calls.push({ args: [...args], mappedArgs });

		if (args[0] === "node" && args[1] === "-e" && typeof args[2] === "string") {
			const scriptArgs = mappedArgs.slice(4);
			vm.runInNewContext(args[2], {
				require: requireForScript,
				process: { argv: [process.execPath, ...scriptArgs] },
			}, { timeout: 5_000 });
			return "";
		}
		if (args[0] === "cat" && mappedArgs[1]) return fs.readFileSync(mappedArgs[1], "utf8");
		if (args[0] === "test" && args[1] === "-f" && mappedArgs[2]) {
			if (!fs.existsSync(mappedArgs[2]) || !fs.statSync(mappedArgs[2]).isFile()) throw new Error("test -f failed");
			return "";
		}
		if (args[0] === "echo") return `${args.slice(1).join(" ")}\n`;
		if (args[0] === "mkdir" && args[1] === "-p" && mappedArgs[2]) {
			fs.mkdirSync(mappedArgs[2], { recursive: true });
			return "";
		}
		if (args[0] === "cp" && mappedArgs[1] && mappedArgs[2]) {
			fs.copyFileSync(mappedArgs[1], mappedArgs[2]);
			return "";
		}
		throw new Error(`unexpected sandbox exec: ${JSON.stringify(args)}`);
	}

	async removeWorktree(name: string): Promise<void> {
		await this.removeWorktreeHook?.(name);
	}

	manager(projectId?: string): { get: (candidate: string) => SandboxSessionFilesystem | undefined } {
		return { get: candidate => !projectId || candidate === projectId ? this : undefined };
	}
}
