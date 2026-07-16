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
type Method = (this: unknown, ...args: any[]) => any;
export type MethodInterceptor<TMethod extends Method = Method> = (
	args: Parameters<TMethod>,
	next: (...args: Parameters<TMethod>) => ReturnType<TMethod>,
) => ReturnType<TMethod>;
type MethodRegistration = { owner: symbol; interceptor: MethodInterceptor };
type MethodInstallation = {
	base: Method;
	facade: Method;
	registrations: MethodRegistration[];
};
type DispatcherGlobalState = {
	installations: WeakMap<CommandRunner, DispatcherInstallation>;
	methodInstallations: WeakMap<object, Map<PropertyKey, MethodInstallation>>;
};

const GLOBAL_STATE_KEY = Symbol.for("bobbit.tests2.command-runner-dispatcher.state");

function globalState(): DispatcherGlobalState {
	const scope = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: Partial<DispatcherGlobalState> };
	const state = scope[GLOBAL_STATE_KEY] ??= {};
	state.installations ??= new WeakMap();
	state.methodInstallations ??= new WeakMap();
	return state as DispatcherGlobalState;
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

/**
 * Lease one method through the same process-global, owner-scoped dispatch model.
 * Test seams use this instead of assigning and later restoring shared gateway
 * methods, which can otherwise restore over a neighboring file's active seam.
 */
export function installMethodInterceptor<
	TTarget extends object,
	TKey extends keyof TTarget,
	TMethod extends Extract<TTarget[TKey], Method>,
>(target: TTarget, key: TKey, label: string, interceptor: MethodInterceptor<TMethod>): () => void {
	const state = globalState();
	let targetInstallations = state.methodInstallations.get(target);
	if (!targetInstallations) {
		targetInstallations = new Map();
		state.methodInstallations.set(target, targetInstallations);
	}

	let installation = targetInstallations.get(key);
	if (!installation) {
		const base = target[key];
		if (typeof base !== "function") throw new Error(`[command-runner-dispatcher] ${String(key)} is not a method`);
		installation = {
			base: base as Method,
			facade: undefined as unknown as Method,
			registrations: [],
		};
		installation.facade = function (this: unknown, ...args: unknown[]) {
			const registrations = installation!.registrations.slice().reverse();
			const dispatch = (index: number, callArgs: unknown[]): unknown => {
				const registration = registrations[index];
				if (registration) {
					return registration.interceptor(callArgs, (...nextArgs: unknown[]) => dispatch(index + 1, nextArgs.length > 0 ? nextArgs : callArgs));
				}
				return Reflect.apply(installation!.base, this, callArgs);
			};
			return dispatch(0, args);
		};
		targetInstallations.set(key, installation);
	}

	if (target[key] !== installation.facade) {
		installation.base = target[key] as Method;
		(target as Record<PropertyKey, unknown>)[key] = installation.facade;
	}
	const owner = Symbol(label);
	installation.registrations.push({ owner, interceptor: interceptor as MethodInterceptor });

	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		const index = installation!.registrations.findIndex(registration => registration.owner === owner);
		if (index >= 0) installation!.registrations.splice(index, 1);
		if (installation!.registrations.length > 0) return;
		if (target[key] === installation!.facade) (target as Record<PropertyKey, unknown>)[key] = installation!.base;
		targetInstallations!.delete(key);
		if (targetInstallations!.size === 0) state.methodInstallations.delete(target);
	};
}
