import type {
	CommandRunner,
	ExecFileOptions,
	ExecFileResult,
	ExecFileSyncOptions,
	SpawnOptions,
} from "../../../src/server/gateway-deps.js";

type ExecFileNext = () => Promise<ExecFileResult>;
type ExecFileSyncNext = () => Buffer | string;
type Spawn = NonNullable<CommandRunner["spawn"]>;
type SpawnNext = () => ReturnType<Spawn>;

export type CommandRunnerInterceptor = {
	label: string;
	execFile?: (file: string, args: readonly string[], options: ExecFileOptions | undefined, next: ExecFileNext) => Promise<ExecFileResult>;
	execFileSync?: (file: string, args: readonly string[], options: ExecFileSyncOptions | undefined, next: ExecFileSyncNext) => Buffer | string;
	spawn?: (file: string, args: readonly string[], options: SpawnOptions | undefined, next: SpawnNext) => ReturnType<Spawn>;
};

type Registration = { owner: symbol; interceptor: CommandRunnerInterceptor };
type DispatcherInstallation = {
	baseExecFile: CommandRunner["execFile"];
	baseExecFileSync: CommandRunner["execFileSync"];
	baseSpawn: CommandRunner["spawn"];
	execFile: CommandRunner["execFile"];
	execFileSync: NonNullable<CommandRunner["execFileSync"]>;
	spawn: Spawn;
	registrations: Registration[];
};
type DispatcherGlobalState = {
	installations: WeakMap<CommandRunner, DispatcherInstallation>;
};

const GLOBAL_STATE_KEY = Symbol.for("bobbit.tests2.command-runner-dispatcher.state");

function globalState(): DispatcherGlobalState {
	const scope = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: DispatcherGlobalState };
	return scope[GLOBAL_STATE_KEY] ??= { installations: new WeakMap() };
}

function missingMethod(method: "execFileSync" | "spawn", file: string, args: readonly string[]): never {
	throw new Error(`[command-runner-dispatcher] ${method} is unavailable for ${file} ${args.join(" ")}`);
}

function createInstallation(runner: CommandRunner): DispatcherInstallation {
	const installation: DispatcherInstallation = {
		baseExecFile: runner.execFile,
		baseExecFileSync: runner.execFileSync,
		baseSpawn: runner.spawn,
		execFile: undefined as unknown as CommandRunner["execFile"],
		execFileSync: undefined as unknown as NonNullable<CommandRunner["execFileSync"]>,
		spawn: undefined as unknown as Spawn,
		registrations: [],
	};

	installation.execFile = async (file, args, options) => {
		const registrations = installation.registrations.slice().reverse();
		const dispatch = (index: number): Promise<ExecFileResult> => {
			const interceptor = registrations[index]?.interceptor.execFile;
			if (interceptor) return interceptor(file, args, options, () => dispatch(index + 1));
			if (index < registrations.length) return dispatch(index + 1);
			return installation.baseExecFile.call(runner, file, args, options);
		};
		return dispatch(0);
	};
	installation.execFileSync = (file, args, options) => {
		const registrations = installation.registrations.slice().reverse();
		const dispatch = (index: number): Buffer | string => {
			const interceptor = registrations[index]?.interceptor.execFileSync;
			if (interceptor) return interceptor(file, args, options, () => dispatch(index + 1));
			if (index < registrations.length) return dispatch(index + 1);
			if (!installation.baseExecFileSync) return missingMethod("execFileSync", file, args);
			return installation.baseExecFileSync.call(runner, file, args, options);
		};
		return dispatch(0);
	};
	installation.spawn = (file, args, options) => {
		const registrations = installation.registrations.slice().reverse();
		const dispatch = (index: number): ReturnType<Spawn> => {
			const interceptor = registrations[index]?.interceptor.spawn;
			if (interceptor) return interceptor(file, args, options, () => dispatch(index + 1));
			if (index < registrations.length) return dispatch(index + 1);
			if (!installation.baseSpawn) return missingMethod("spawn", file, args);
			return installation.baseSpawn.call(runner, file, args, options);
		};
		return dispatch(0);
	};
	return installation;
}

function installFacade(runner: CommandRunner, installation: DispatcherInstallation): void {
	// A legacy suite may have installed a temporary facade before this owner. Keep
	// that facade as the fallback rather than capturing an obsolete runner method.
	if (runner.execFile !== installation.execFile) installation.baseExecFile = runner.execFile;
	if (runner.execFileSync !== installation.execFileSync) installation.baseExecFileSync = runner.execFileSync;
	if (runner.spawn !== installation.spawn) installation.baseSpawn = runner.spawn;
	runner.execFile = installation.execFile;
	runner.execFileSync = installation.execFileSync;
	runner.spawn = installation.spawn;
}

/**
 * Add one owner-scoped interceptor to the exact CommandRunner retained by the
 * in-process gateway. The process-global facade is installed once per runner;
 * releasing one lease removes only that owner and cannot restore over another.
 */
export function installCommandRunnerInterceptor(runner: CommandRunner, interceptor: CommandRunnerInterceptor): () => void {
	const state = globalState();
	let installation = state.installations.get(runner);
	if (!installation) {
		installation = createInstallation(runner);
		state.installations.set(runner, installation);
	}
	installFacade(runner, installation);

	const owner = Symbol(interceptor.label);
	installation.registrations.push({ owner, interceptor });
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		const index = installation!.registrations.findIndex(registration => registration.owner === owner);
		if (index >= 0) installation!.registrations.splice(index, 1);
		if (installation!.registrations.length > 0) return;

		// Restore only methods still owned by this facade. A neighboring suite may
		// have intentionally layered its own temporary implementation on top.
		if (runner.execFile === installation!.execFile) runner.execFile = installation!.baseExecFile;
		if (runner.execFileSync === installation!.execFileSync) runner.execFileSync = installation!.baseExecFileSync;
		if (runner.spawn === installation!.spawn) runner.spawn = installation!.baseSpawn;
		if (state.installations.get(runner) === installation) state.installations.delete(runner);
	};
}
