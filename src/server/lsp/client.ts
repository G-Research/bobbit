/**
 * LspClient interface and factory contract.
 *
 * Adapters under `clients/` implement `LspClientFactory`. Supervisor owns
 * registration and lifecycle.
 */
import type {
	Diagnostic, DocumentSymbol, HoverResult, Language, Location,
	SymbolInformation, WorkspaceEdit,
} from "./types.js";

export type ClientState = "starting" | "warm" | "stopping" | "stopped";

export interface SpawnOpts {
	worktreePath: string;
	/** Optional sandbox bridge — when set, child runs via docker exec. */
	sandbox?: SandboxLspBridge;
}

export interface LspClient {
	readonly language: Language;
	readonly worktreePath: string;
	readonly state: ClientState;

	ensureDocOpen(absPath: string): Promise<void>;
	definition(absPath: string, line: number, character: number): Promise<Location | null>;
	references(absPath: string, line: number, character: number, includeDecl: boolean): Promise<Location[]>;
	hover(absPath: string, line: number, character: number): Promise<HoverResult | null>;
	diagnostics(absPath?: string): Promise<Diagnostic[]>;
	documentSymbols(absPath: string): Promise<DocumentSymbol[]>;
	workspaceSymbol(query: string): Promise<SymbolInformation[]>;
	rename(absPath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit>;

	shutdown(graceful: boolean): Promise<void>;
}

export interface LspClientFactory {
	readonly language: Language;
	isInstalled(): boolean;
	spawn(opts: SpawnOpts): Promise<LspClient>;
}

/**
 * Sandbox bridge interface — supplied by the gateway when sessions run inside
 * Docker. Mirror of `rpc-bridge.spawnDockerExec` minus the agent specifics.
 */
export interface SandboxLspBridge {
	/** Spawn a child inside the sandbox container; return its stdio handles. */
	spawn(args: {
		containerId: string;
		cmd: string[];
		cwd: string;          // container-internal path
		env?: Record<string, string>;
	}): import("node:child_process").ChildProcess;

	/** Translate host path → container path for the given worktree. */
	toContainerPath(hostPath: string): string;
	/** Reverse translation for paths returned by the LSP child. */
	toHostPath(containerPath: string): string;
	/** Container ID to exec into for the given worktree. */
	containerIdForWorktree(hostWorktreePath: string): string | null;
}
