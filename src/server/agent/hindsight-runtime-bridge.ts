import path from "node:path";
import type { ExtensionCapabilityGrantResolver } from "./extension-grant-policy.js";
import type { ExtensionCapability } from "./project-config-store.js";
import type { ExtensionSettingValue, ExtensionSettingsStore } from "./extension-settings-store.js";
import type { ProviderContribution } from "./pack-contributions.js";
import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";
import {
	ServiceRuntimeError,
	type ServiceRuntimeContext,
	type ServiceRuntimeControlRequest,
	type ServiceRuntimeSettings,
	type ServiceRuntimeStatus,
	type ServiceRuntimeSupervisor,
} from "../service-runtime/index.js";

export const HINDSIGHT_PACK_ID = "hindsight";
export const HINDSIGHT_RUNTIME_ID = "hindsight";
export const HINDSIGHT_PROVIDER_ID = "memory";

export type HindsightCapability = Extract<ExtensionCapability,
	"service.manage" | "memory.read" | "memory.write" | "memory.reflect" | "memory.invalidate" | "memory.read.all">;
const HINDSIGHT_CAPABILITIES: ReadonlySet<string> = new Set([
	"service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all",
]);
export function isHindsightCapability(value: string): value is HindsightCapability {
	return HINDSIGHT_CAPABILITIES.has(value);
}

export class HindsightCapabilityError extends Error {
	readonly code = "HINDSIGHT_CAPABILITY_DENIED";
	constructor(readonly capability: HindsightCapability) {
		super(`Hindsight capability is required: ${capability}`);
	}
}

export interface HindsightRuntimeBridgeOptions {
	contributions: Pick<PackContributionResolver, "getPack">;
	contextForProject(projectId: string): {
		stateDir: string;
		extensionSettingsStore: ExtensionSettingsStore;
	} | undefined;
	grants: ExtensionCapabilityGrantResolver;
	supervisorForProject(projectId: string, settings: HindsightRuntimeSettingsResolver): ServiceRuntimeSupervisor;
}

/** Runtime-only EP-7 adapter. It is intentionally unable to publish settings. */
export class HindsightRuntimeSettingsResolver {
	constructor(
		private readonly projectId: string,
		private readonly context: { stateDir: string; extensionSettingsStore: ExtensionSettingsStore },
		private readonly contributions: Pick<PackContributionResolver, "getPack">,
	) {}

	resolve(input: ServiceRuntimeControlRequest & { contribution: { id: string } }): ServiceRuntimeSettings {
		void input; // Settings ownership, rather than a caller, selects the target.
		const provider = this.provider();
		const { values, revision } = this.getRuntimeValues(provider);
		const mode = values.runtimeMode;
		if (mode !== "local" && mode !== "docker" && mode !== "compose") {
			throw new ServiceRuntimeError("SERVICE_MODE_CONFLICT");
		}
		const dataDir = this.ownedDataDir(values.dataDir);
		const stringValues: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(values)) if (typeof value === "string") stringValues[key] = value;
		const imageOverride = typeof values.ociImage === "string" ? values.ociImage
			: typeof values.image === "string" ? values.image : undefined;
		return {
			mode,
			revision,
			values: stringValues,
			storage: { dataPath: dataDir, ownedRoot: path.join(this.context.stateDir, "service-data") },
			...(imageOverride ? { imageOverride } : {}),
		};
	}

	resolveSecret(setting: string): string | undefined {
		const provider = this.provider();
		const { values } = this.getRuntimeValues(provider, true);
		const direct = values[setting];
		if (typeof direct === "string" && direct.length > 0) return direct;
		// The reviewed runtime descriptor predates EP-7's public field names. This
		// is a compatibility mapping, not a second secret owner.
		const alias = setting === "llmApiKey" ? "apiKey" : setting === "localModelApiKey" ? "localModelKey" : undefined;
		return alias && typeof values[alias] === "string" && values[alias].length > 0 ? values[alias] : undefined;
	}

	/** Runtime-only values; callers must never serialize this result. */
	getRuntimeValues(provider: ProviderContribution, includeSecrets = false): { values: Record<string, ExtensionSettingValue>; revision: string } {
		const fields = provider.configSchema ?? {};
		const defaults = provider.config ?? {};
		const secretFields = Object.entries(fields)
			.filter(([, field]) => !!field && typeof field === "object" && (field as { type?: unknown }).type === "secret")
			.map(([key]) => key);
		const ref = { packId: HINDSIGHT_PACK_ID, kind: "provider" as const, id: provider.id };
		const values = includeSecrets
			? this.context.extensionSettingsStore.getForRuntime(ref, defaults as Record<string, ExtensionSettingValue>, { secretFields })
			: this.context.extensionSettingsStore.getEffective(ref, defaults as Record<string, ExtensionSettingValue>, { secretFields }).values;
		return { values, revision: String(this.context.extensionSettingsStore.getPublicState().revision) };
	}

	private provider(): ProviderContribution {
		const provider = this.contributions.getPack(this.projectId, HINDSIGHT_PACK_ID)?.providers.find(item => item.id === HINDSIGHT_PROVIDER_ID);
		if (!provider || provider.runtime !== HINDSIGHT_RUNTIME_ID) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		return provider;
	}

	private ownedDataDir(raw: ExtensionSettingValue | undefined): string {
		const root = path.resolve(this.context.stateDir, "service-data");
		const text = typeof raw === "string" && raw.length > 0 ? raw : path.join(root, HINDSIGHT_RUNTIME_ID);
		const expanded = text.replaceAll("${stateDir}", this.context.stateDir);
		const resolved = path.resolve(expanded);
		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
		return resolved;
	}
}

/**
 * The server-owned composition point for Hindsight. It has no lifecycle state:
 * durable state belongs to EP-7 plus the generic runtime supervisor/store.
 */
export class HindsightRuntimeBridge {
	private readonly resolvers = new Map<string, HindsightRuntimeSettingsResolver>();
	private readonly supervisors = new Map<string, ServiceRuntimeSupervisor>();

	constructor(private readonly options: HindsightRuntimeBridgeOptions) {}

	async context(input: { projectId?: string; packId: string; runtimeId: string; providerId: string }): Promise<ServiceRuntimeContext> {
		if (!input.projectId || input.packId !== HINDSIGHT_PACK_ID || input.runtimeId !== HINDSIGHT_RUNTIME_ID || input.providerId !== HINDSIGHT_PROVIDER_ID) {
			return { state: "unavailable", diagnostic: { code: "SERVICE_UNAVAILABLE" } };
		}
		try {
			const settings = this.settings(input.projectId);
			const provider = this.provider(input.projectId);
			const effective = settings.getRuntimeValues(provider);
			if (effective.values.runtimeMode === "external") {
				const endpoint = safeExternalEndpoint(effective.values.externalUrl);
				return endpoint
					? { state: "ready", endpoint }
					: { state: "blocked", diagnostic: { code: "SERVICE_SETTING_UNAVAILABLE" } };
			}
			return await this.supervisor(input.projectId).context({ packId: input.packId, runtimeId: input.runtimeId }, input.projectId);
		} catch {
			return { state: "unavailable", diagnostic: { code: "SERVICE_UNAVAILABLE" } };
		}
	}

	settingsRevision(projectId: string): number {
		const revision = this.settings(projectId).getRuntimeValues(this.provider(projectId)).revision;
		return Number(revision);
	}

	async status(projectId: string): Promise<ServiceRuntimeStatus> {
		const settings = this.settings(projectId);
		const provider = this.provider(projectId);
		const effective = settings.getRuntimeValues(provider);
		const identity = { packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID };
		if (effective.values.runtimeMode === "external") {
			const endpoint = safeExternalEndpoint(effective.values.externalUrl);
			return endpoint
				? { identity, desired: "running", mode: "external", state: "ready", endpoint }
				: { identity, desired: "stopped", mode: "external", state: "blocked", diagnostic: { code: "SERVICE_SETTING_UNAVAILABLE" } };
		}
		return this.supervisor(projectId).status(identity, projectId);
	}

	async control(projectId: string, action: "start" | "stop" | "restart"): Promise<ServiceRuntimeStatus> {
		this.require(projectId, "service.manage");
		const mode = this.settings(projectId).getRuntimeValues(this.provider(projectId)).values.runtimeMode;
		if (mode === "external") throw new ServiceRuntimeError("SERVICE_MODE_CONFLICT");
		const request = { packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID, projectId };
		if (action === "stop") return this.supervisor(projectId).stop(request);
		if (action === "restart") {
			await this.supervisor(projectId).stop(request);
		}
		return this.supervisor(projectId).start(request);
	}

	async logs(projectId: string): Promise<string | undefined> {
		// Logs are read-only, bounded by the generic artifact owner, and never
		// resolve settings/secrets or inspect/start an external service.
		return this.supervisor(projectId).diagnostics({ packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID });
	}

	require(projectId: string, capability: HindsightCapability): void {
		const decision = this.options.grants(projectId, { kind: "pack", packId: HINDSIGHT_PACK_ID }, capability);
		if (!decision.allowed) throw new HindsightCapabilityError(capability);
	}

	private supervisor(projectId: string): ServiceRuntimeSupervisor {
		let supervisor = this.supervisors.get(projectId);
		if (!supervisor) {
			supervisor = this.options.supervisorForProject(projectId, this.settings(projectId));
			this.supervisors.set(projectId, supervisor);
		}
		return supervisor;
	}

	private settings(projectId: string): HindsightRuntimeSettingsResolver {
		let resolver = this.resolvers.get(projectId);
		if (!resolver) {
			const context = this.options.contextForProject(projectId);
			if (!context) throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
			resolver = new HindsightRuntimeSettingsResolver(projectId, context, this.options.contributions);
			this.resolvers.set(projectId, resolver);
		}
		return resolver;
	}

	private provider(projectId: string): ProviderContribution {
		const provider = this.options.contributions.getPack(projectId, HINDSIGHT_PACK_ID)?.providers.find(item => item.id === HINDSIGHT_PROVIDER_ID);
		if (!provider) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		return provider;
	}
}

function safeExternalEndpoint(value: ExtensionSettingValue | undefined): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}
