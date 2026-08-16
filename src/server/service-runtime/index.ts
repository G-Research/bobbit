// Public generic service-runtime surface. Consumers receive only mode-free context.
export type {
	ServiceRunMode,
	ServiceRuntimeManifest,
	ServiceManifestSourceContext,
} from "./service-manifest.js";
export { parseServiceManifest, isSafeServiceImageReference } from "./service-manifest.js";

export type {
	ServiceRuntimeContext,
	ServiceRuntimeStatus,
	ServiceRuntimeStatusMode,
	ServiceRuntimeControlRequest,
	ServiceRuntimeSettings,
	ServiceRuntimeSettingsResolver,
	ServiceRuntimeAuthorizer,
	ServiceRuntimeClock,
	ServiceRuntimeProbe,
	ServiceRuntimeLogger,
	ServiceRuntimeSupervisorOptions,
} from "./service-supervisor.js";
export { ServiceRuntimeSupervisor, ServiceRuntimeError } from "./service-supervisor.js";

export type {
	ServiceRuntimeIdentity,
	ServiceRuntimeMode,
	ServiceRuntimeObservedState,
	ServiceRuntimeDiagnostic,
	PersistedServiceRuntime,
	GeneratedSecretOwner,
	UserSecretResolver,
	ServiceRuntimeStoreOptions,
	RuntimeStorageDeclaration,
	RuntimePurgeRequest,
} from "./service-runtime-store.js";
export { ServiceRuntimeStore, ServiceRuntimeStoreError } from "./service-runtime-store.js";

export type {
	ServiceRunner,
	ServiceRunnerIdentity,
	StartedService,
	ServiceRunnerStartInput,
	ServiceRunnerInspectInput,
	ServiceRunnerControlInput,
} from "./service-runners.js";
export { LocalServiceRunner, DockerServiceRunner, ComposeServiceRunner } from "./service-runners.js";
