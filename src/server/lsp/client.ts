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
	/**
	 * Supervisor-supplied close callback (finding #3).
	 * `graceful=true` means the supervisor asked the child to stop —
	 * adapters should pass `true` from their own `shutdown()` flow, and
	 * `false` from an unexpected exit handler so the supervisor counts it
	 * as a crash.
	 */
	onClose?: (graceful: boolean) => void;
	/** When true, the adapter must fail closed if no sandbox container is
	 *  available for `worktreePath`. Set by the supervisor for worktrees
	 *  marked sandboxed via `LspSupervisor.markSandboxed()`. Host-only flows
	 *  leave this unset. See `LspProcessOpts.requireSandbox`. */
	requireSandbox?: boolean;
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
	/** Return a stable bridge scoped to one worktree path, avoiding shared
	 *  mutable state in multi-project bridges.
	 *  - Return a non-null `SandboxLspBridge` when the worktree belongs to a
	 *    sandbox-configured project (fail-closed when no container running).
	 *  - Return `null` to indicate the worktree is NOT inside any
	 *    sandbox-configured project; callers must then treat it as a host
	 *    worktree and skip the sandbox path entirely. Pinned by
	 *    `tests/lsp/sandbox-bridge-resolve.spec.ts` and the API E2E
	 *    `tests/e2e/lsp.spec.ts`.
	 *  - When unimplemented, callers fall back to `this` (legacy contract). */
	resolveForWorktree?(worktreePath: string): SandboxLspBridge | null;
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
