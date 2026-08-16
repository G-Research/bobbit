import path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionCapabilityGrantResolver } from "./extension-grant-policy.js";
import type { ExtensionCapability } from "./project-config-store.js";
import type { ExtensionSettingValue, ExtensionSettingsStore } from "./extension-settings-store.js";
import type { ProviderContribution } from "./pack-contributions.js";
import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";
import {
	localModelDiagnostic,
	materializeHindsightRuntimeSettings,
	parseOciReference,
	resolveHindsightRuntimeSettings,
	validateHindsightRuntimeSettings,
	type RedactedModelDiagnostic,
	type RuntimeSecrets,
} from "../../shared/hindsight/runtime-settings.js";
import {
	createHindsightMigrationPlan,
	executeHindsightMigration,
	type HindsightMigrationPlan,
	type LogicalMigrationRunner,
	type MigrationStorage,
} from "../../shared/hindsight/migration.js";
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

/** A migration is deliberately blocked rather than guessed when the generic
 * runtime cannot identify a source endpoint. The bridge never mounts pg0 or
 * invents a fresh bank to make a mode switch appear successful. */
export type HindsightMigrationRouteResult =
	| { ok: true; plan: HindsightMigrationPlan }
	| { ok: true; planId: string; fingerprint: string }
	| { ok: false; code: string; rolledBack?: boolean };

export interface HindsightRuntimeControlResult {
	runtime: ServiceRuntimeStatus;
	/** The EP-7 revision from the exact snapshot the supervisor applied. */
	settingsRevision: number;
}

export interface HindsightRuntimeBridgeOptions {
	contributions: Pick<PackContributionResolver, "getPack">;
	/** Unfiltered descriptor lookup for status/settings operations. Lifecycle
	 * activation deliberately filters providers by live grants, but an authorized
	 * runtime control/status path must still see the declared provider settings. */
	providerForProject?(projectId: string): ProviderContribution | undefined;
	contextForProject(projectId: string): {
		stateDir: string;
		extensionSettingsStore: ExtensionSettingsStore;
	} | undefined;
	grants: ExtensionCapabilityGrantResolver;
	supervisorForProject(projectId: string, settings: HindsightRuntimeSettingsResolver): ServiceRuntimeSupervisor;
}

interface RuntimeValues {
	values: Record<string, ExtensionSettingValue>;
	revision: string;
}

function secretValues(values: Record<string, ExtensionSettingValue>): RuntimeSecrets {
	return {
		...(typeof values.apiKey === "string" ? { apiKey: values.apiKey } : {}),
		...(typeof values.localLlmApiKey === "string" ? { localLlmApiKey: values.localLlmApiKey } : {}),
		...(typeof values.registryCredentials === "string" ? { registryCredentials: values.registryCredentials } : {}),
		...(typeof values.externalDatabaseUrl === "string" ? { externalDatabaseUrl: values.externalDatabaseUrl } : {}),
	};
}

function publicRuntimeValues(values: Record<string, ExtensionSettingValue>): Record<string, unknown> {
	const { apiKey: _apiKey, localLlmApiKey: _localLlmApiKey, registryCredentials: _registryCredentials, externalDatabaseUrl: _externalDatabaseUrl, ...publicValues } = values;
	return publicValues;
}

function safeStatusDiagnostic(status: ServiceRuntimeStatus, model?: RedactedModelDiagnostic, warning?: string): ServiceRuntimeStatus {
	if (!model && !warning) return status;
	// This is an in-memory status projection only. Persisted generic runtime
	// diagnostics remain code-only, while this capability-safe metadata exposes
	// the selected resident load without endpoint credentials or query strings.
	return {
		...status,
		diagnostic: {
			code: status.diagnostic?.code ?? (status.state === "ready" ? "SERVICE_READY" : "SERVICE_MODEL_CONFIGURED"),
			...(status.diagnostic?.retryAt ? { retryAt: status.diagnostic.retryAt } : {}),
			...(model ? { model } : {}),
			...(warning ? { warning } : {}),
		} as ServiceRuntimeStatus["diagnostic"],
	};
}

/** Runtime-only EP-7 adapter. It is intentionally unable to publish settings. */
export class HindsightRuntimeSettingsResolver {
	constructor(
		private readonly projectId: string,
		private readonly context: { stateDir: string; extensionSettingsStore: ExtensionSettingsStore },
		private readonly contributions: Pick<PackContributionResolver, "getPack">,
		private readonly providerForProject?: (projectId: string) => ProviderContribution | undefined,
	) {}

	resolve(input: ServiceRuntimeControlRequest & { contribution: { id: string } }): ServiceRuntimeSettings {
		void input; // Settings ownership, rather than a caller, selects the target.
		const provider = this.provider();
		const runtime = this.getRuntimeValues(provider, true);
		const resolved = resolveHindsightRuntimeSettings(publicRuntimeValues(runtime.values));
		const materialized = materializeHindsightRuntimeSettings(publicRuntimeValues(runtime.values), runtime.revision, secretValues(runtime.values));
		if (!materialized.ok) throw new ServiceRuntimeError(materialized.code);
		if (materialized.mode === "external") throw new ServiceRuntimeError("SERVICE_MODE_CONFLICT");
		const continuity = hindsightStorageContinuity(materialized.mode, resolved.databaseMode, materialized.secrets.externalDatabaseUrl);
		const values = Object.freeze({ ...materialized.values });
		const resolvedSecrets = Object.freeze({ ...materialized.secrets });
		return {
			mode: materialized.mode,
			revision: materialized.revision,
			values,
			// The descriptor declares no host bind. In particular, `dataDir` is a
			// legacy setting and is not evidence that Hindsight 0.8.6 consumes it.
			// Keep public values, secret bytes, revision, and continuity from this
			// one EP-7 resolution together through materialization.
			resolvedSecrets,
			imageOverride: values.HINDSIGHT_OCI_IMAGE,
			storageIdentity: continuity.identity,
			storageContinuity: continuity.continuity,
		};
	}

	resolveSecret(setting: string): string | undefined {
		const values = this.getRuntimeValues(this.provider(), true).values;
		const aliases: Record<string, keyof RuntimeSecrets> = {
			localLlmApiKey: "localLlmApiKey",
			localModelApiKey: "localLlmApiKey",
			llmApiKey: "apiKey",
			externalDatabaseUrl: "externalDatabaseUrl",
			registryCredentials: "registryCredentials",
		};
		const direct = values[setting];
		if (typeof direct === "string" && direct.length > 0) return direct;
		const secret = aliases[setting] ? secretValues(values)[aliases[setting]] : undefined;
		return typeof secret === "string" && secret.length > 0 ? secret : undefined;
	}

	/** Runtime-only values; callers must never serialize this result. */
	getRuntimeValues(provider: ProviderContribution, includeSecrets = false): RuntimeValues {
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

	modelDiagnostic(): RedactedModelDiagnostic | undefined {
		const runtime = this.getRuntimeValues(this.provider());
		const settings = resolveHindsightRuntimeSettings(publicRuntimeValues(runtime.values));
		// A stable process/load identity is derived only from non-secret settings and
		// the current EP-7 revision. Data-plane paths only observe it; they never
		// create, probe, or fall back to another model.
		const observedLoadId = settings.runtimeMode === "local" && settings.localLlmResidency === "resident"
			? `resident-${createHash("sha256").update(`${this.projectId}\0${runtime.revision}\0${settings.localLlmProvider}\0${settings.localLlmModelId ?? ""}\0${settings.localLlmBaseUrl ?? ""}`).digest("hex").slice(0, 20)}`
			: undefined;
		const diagnostic = localModelDiagnostic(settings, observedLoadId);
		return diagnostic;
	}

	ociWarning(): string | undefined {
		const runtime = this.getRuntimeValues(this.provider());
		const parsed = parseOciReference(resolveHindsightRuntimeSettings(publicRuntimeValues(runtime.values)).ociImage);
		return parsed.ok ? parsed.value.warning : undefined;
	}

	private provider(): ProviderContribution {
		const provider = this.providerForProject
			? this.providerForProject(this.projectId)
			: this.contributions.getPack(this.projectId, HINDSIGHT_PACK_ID)?.providers.find(item => item.id === HINDSIGHT_PROVIDER_ID);
		if (!provider || provider.runtime !== HINDSIGHT_RUNTIME_ID) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		return provider;
	}

}

/**
 * The server-owned composition point for Hindsight. It has no Hindsight
 * lifecycle/settings/secret owner: durable state belongs solely to EP-7 and
 * the generic runtime supervisor/store.
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
			const effective = settings.getRuntimeValues(this.provider(input.projectId));
			if (resolveHindsightRuntimeSettings(publicRuntimeValues(effective.values)).runtimeMode === "external") {
				const endpoint = safeExternalEndpoint(effective.values.externalUrl);
				return endpoint ? { state: "ready", endpoint } : { state: "blocked", diagnostic: { code: "SERVICE_SETTING_UNAVAILABLE" } };
			}
			return await this.supervisor(input.projectId).context({ packId: input.packId, runtimeId: input.runtimeId }, input.projectId);
		} catch {
			return { state: "unavailable", diagnostic: { code: "SERVICE_UNAVAILABLE" } };
		}
	}

	settingsRevision(projectId: string): number {
		return Number(this.settings(projectId).getRuntimeValues(this.provider(projectId)).revision);
	}

	/** Inert EP-7 PATCH validation. The caller supplies schema defaults from the
	 * server-resolved catalogue, rather than resolving the active runtime
	 * provider: a disabled/dormant target must remain repairable. This only reads
	 * EP-7's redacted public values (and its commit pairing), and never probes,
	 * pulls, starts, or contacts a model, registry, or database. */
	validateSettingsSave(
		projectId: string,
		defaults: Readonly<Record<string, ExtensionSettingValue>>,
		changes: Readonly<Record<string, ExtensionSettingValue | undefined>>,
	): { ok: true; warnings: string[] } | { ok: false; code: string } {
		const context = this.options.contextForProject(projectId);
		if (!context) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		const current = context.extensionSettingsStore.getEffective(
			{ packId: HINDSIGHT_PACK_ID, kind: "provider", id: HINDSIGHT_PROVIDER_ID },
			defaults,
		).values;
		const merged: Record<string, ExtensionSettingValue> = { ...current };
		for (const [key, value] of Object.entries(changes)) {
			if (value === undefined) delete merged[key];
			else merged[key] = value;
		}
		const result = validateHindsightRuntimeSettings(publicRuntimeValues(merged));
		return result.ok ? { ok: true, warnings: result.warnings } : result;
	}

	/** Startup-only recovery path. Gateway composition invokes this once after its
	 * project dependencies are ready; status, context, and provider reads never do. */
	async reconcile(projectId: string): Promise<ServiceRuntimeStatus[]> {
		return this.supervisor(projectId).reconcile(projectId);
	}

	async status(projectId: string): Promise<ServiceRuntimeStatus> {
		const settings = this.settings(projectId);
		const effective = settings.getRuntimeValues(this.provider(projectId));
		const identity = { packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID };
		const mode = resolveHindsightRuntimeSettings(publicRuntimeValues(effective.values)).runtimeMode;
		if (mode === "external") {
			const endpoint = safeExternalEndpoint(effective.values.externalUrl);
			return endpoint
				? { identity, desired: "running", mode: "external", state: "ready", endpoint }
				: { identity, desired: "stopped", mode: "external", state: "blocked", diagnostic: { code: "SERVICE_SETTING_UNAVAILABLE" } };
		}
		return safeStatusDiagnostic(await this.supervisor(projectId).status(identity, projectId), settings.modelDiagnostic(), settings.ociWarning());
	}

	async control(projectId: string, action: "start" | "stop" | "restart"): Promise<HindsightRuntimeControlResult> {
		this.require(projectId, "service.manage");
		const request = { packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID, projectId };
		if (action === "stop") {
			const mode = resolveHindsightRuntimeSettings(publicRuntimeValues(this.settings(projectId).getRuntimeValues(this.provider(projectId)).values)).runtimeMode;
			if (mode === "external") throw new ServiceRuntimeError("SERVICE_MODE_CONFLICT");
			return {
				runtime: await this.supervisor(projectId).stop(request),
				settingsRevision: this.settingsRevision(projectId),
			};
		}
		// The supervisor resolves one immutable EP-7 snapshot before continuity
		// preflight. Never read this mutable settings owner again for the response.
		const applied = action === "restart"
			? await this.supervisor(projectId).restartWithResult(request)
			: await this.supervisor(projectId).startWithResult(request);
		return {
			// Do not re-resolve EP-7 merely to decorate an explicit control response:
			// that could observe a concurrent save after the applied snapshot.
			runtime: safeStatusDiagnostic(applied.status),
			settingsRevision: Number(applied.settingsRevision),
		};
	}

	async logs(projectId: string): Promise<string | undefined> {
		return this.supervisor(projectId).diagnostics({ packId: HINDSIGHT_PACK_ID, runtimeId: HINDSIGHT_RUNTIME_ID });
	}

	/**
	 * Marketplace lifecycle adapter. The generic supervisor owns the actual
	 * stop/remove transaction and live `service.manage` checks; this bridge only
	 * supplies the project-scoped Hindsight identity while its descriptor is
	 * still resolvable. It never purges runtime storage or secret artifacts.
	 */
	async removeOwnedRuntimeForContributionChange(projectId: string): Promise<ServiceRuntimeStatus> {
		return this.supervisor(projectId).removeOwnedResource({
			packId: HINDSIGHT_PACK_ID,
			runtimeId: HINDSIGHT_RUNTIME_ID,
			projectId,
		});
	}

	/** Route adapter for migration-plan. It only emits a plan when the configured
	 * source and target are safely identifiable. No command, start, pull, or
	 * storage mutation happens here. */
	migrationPlan(projectId: string, body: unknown): HindsightMigrationRouteResult {
		this.require(projectId, "service.manage");
		const source = this.migrationStorage(projectId);
		const target = this.requestedMigrationTarget(projectId, body);
		if (!source || !target) return { ok: false, code: "HINDSIGHT_MIGRATION_SOURCE_UNAVAILABLE" };
		const plan = createHindsightMigrationPlan({
			source,
			target,
			backupDirectory: path.join(this.projectContext(projectId).stateDir, "hindsight-migrations"),
			// A source whose location has not been positively verified is never
			// migrated; the caller must configure an external database or use the
			// documented logical migration route rather than receive an empty bank.
			compatibility: { bankExists: true, markerPresent: true, sourcePostgresMajor: 16, targetPostgresMajor: 16, sourceSchemaVersion: "hindsight-0.8", targetSchemaVersion: "hindsight-0.8", freeBytes: 1, requiredBytes: 1 },
		});
		return plan.ok ? { ok: true, plan: plan.plan } : { ok: false, code: plan.code };
	}

	/** Server-owned execution refuses unsupported storage paths before writing.
	 * This fail-closed adapter intentionally has no bind mount or raw connection
	 * string in its public route surface. */
	async migrationExecute(projectId: string, body: unknown): Promise<HindsightMigrationRouteResult> {
		this.require(projectId, "service.manage");
		if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "HINDSIGHT_MIGRATION_CONFIRMATION_REQUIRED" };
		const input = body as { plan?: HindsightMigrationPlan; confirmation?: unknown };
		if (!input.plan || typeof input.confirmation !== "string") return { ok: false, code: "HINDSIGHT_MIGRATION_CONFIRMATION_REQUIRED" };
		const source = this.migrationStorage(projectId);
		if (!source || !sameStorage(source, input.plan.source)) return { ok: false, code: "HINDSIGHT_MIGRATION_PLAN_STALE" };
		// Generic runtime intentionally does not expose a PostgreSQL connector. Do
		// not substitute a new blank volume. The route exists and is bounded/fail
		// closed until an operator supplies the external logical migration adapter.
		const runner: LogicalMigrationRunner = unavailableMigrationRunner();
		const result = await executeHindsightMigration(input.plan, input.confirmation, runner, AbortSignal.timeout(30_000));
		return result;
	}

	require(projectId: string, capability: HindsightCapability): void {
		const decision = this.options.grants(projectId, { kind: "pack", packId: HINDSIGHT_PACK_ID }, capability);
		if (!decision.allowed) throw new HindsightCapabilityError(capability);
	}

	private migrationStorage(projectId: string): MigrationStorage | undefined {
		const runtime = this.settings(projectId).getRuntimeValues(this.provider(projectId), true);
		const settings = resolveHindsightRuntimeSettings(publicRuntimeValues(runtime.values));
		if (settings.databaseMode === "managed-volume") return { kind: "managed-volume", volume: `hindsight-${safeProjectToken(projectId)}` };
		const secret = secretValues(runtime.values).externalDatabaseUrl;
		return secret ? { kind: "external", target: `external-${createHash("sha256").update(secret).digest("hex").slice(0, 24)}` } : undefined;
	}

	private requestedMigrationTarget(projectId: string, body: unknown): MigrationStorage | undefined {
		if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
		const kind = (body as { target?: unknown }).target;
		if (kind === "managed-volume") return { kind: "managed-volume", volume: `hindsight-${safeProjectToken(projectId)}-migrated` };
		if (kind === "external") {
			const current = this.migrationStorage(projectId);
			return current?.kind === "external" ? { kind: "external", target: `${current.target}-migrated` } : undefined;
		}
		return undefined;
	}

	private projectContext(projectId: string): { stateDir: string; extensionSettingsStore: ExtensionSettingsStore } {
		const context = this.options.contextForProject(projectId);
		if (!context) throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
		return context;
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
			resolver = new HindsightRuntimeSettingsResolver(projectId, this.projectContext(projectId), this.options.contributions, this.options.providerForProject);
			this.resolvers.set(projectId, resolver);
		}
		return resolver;
	}

	private provider(projectId: string): ProviderContribution {
		const provider = this.options.providerForProject
			? this.options.providerForProject(projectId)
			: this.options.contributions.getPack(projectId, HINDSIGHT_PACK_ID)?.providers.find(item => item.id === HINDSIGHT_PROVIDER_ID);
		if (!provider) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		return provider;
	}
}

function safeProjectToken(projectId: string): string {
	return createHash("sha256").update(projectId).digest("hex").slice(0, 24);
}

/**
 * Continuity identities name the storage Hindsight actually uses, never an
 * unused host `dataDir`. Compose's `hindsight-postgres` is an owned named
 * volume; external PostgreSQL is identified by a canonical target. The local
 * and Docker managed modes have no verified Hindsight 0.8.6 durable-storage
 * contract, so any replacement is fenced before it can discard a bank.
 */
export function hindsightStorageContinuity(
	runtimeMode: "local" | "docker" | "compose",
	databaseMode: "managed-volume" | "external",
	externalDatabaseUrl?: string,
): { identity: string; continuity: "verified" | "unsupported" } {
	if (databaseMode === "external") {
		return { identity: hindsightStorageIdentity(runtimeMode, databaseMode, externalDatabaseUrl), continuity: "verified" };
	}
	if (runtimeMode === "compose") {
		return { identity: hindsightStorageIdentity(runtimeMode, databaseMode), continuity: "verified" };
	}
	return { identity: hindsightStorageIdentity(runtimeMode, databaseMode), continuity: "unsupported" };
}

/**
 * Query values from credential-bearing connection components must not affect
 * continuity: rotating an auth value does not select another database. This is
 * intentionally broader than `password`; provider-specific aliases commonly
 * use `token`, `credential`, or `auth_*` names.
 */
function isCredentialQueryComponent(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return /(?:pass(?:word|phrase)?|pwd|token|credential|secret|auth(?:entication|orization)?|apikey|sslkey|sslcert|privatekey)/.test(normalized);
}

/** Opaque durable key only: no target path or credential can surface from it. */
export function hindsightStorageIdentity(
	runtimeMode: "local" | "docker" | "compose",
	databaseMode: "managed-volume" | "external",
	externalDatabaseUrl?: string,
): string {
	if (databaseMode === "managed-volume") {
		if (runtimeMode === "compose") {
			// This is the exact descriptor-declared named volume key. Compose owns
			// its server-scoped physical name and preserves it on ordinary `down`.
			return `hindsight-compose-volume:${createHash("sha256").update("hindsight-postgres").digest("hex")}`;
		}
		return `hindsight-unverified-managed:${runtimeMode}`;
	}
	if (!externalDatabaseUrl) throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
	try {
		const url = new URL(externalDatabaseUrl);
		const protocol = url.protocol.toLowerCase() === "postgres:" ? "postgresql:" : url.protocol.toLowerCase();
		if (protocol !== "postgresql:" || !url.hostname || !url.pathname || url.pathname === "/") throw new Error("invalid external database target");
		const username = url.username;
		const options = [...url.searchParams.entries()]
			// User-info and credential-bearing query parameters are not backing
			// identity. Safe libpq/provider behavior options remain canonicalized.
			.filter(([name]) => !isCredentialQueryComponent(name))
			.sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
			.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
			.join("&");
		const target = `${protocol}//${username}@${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}${options ? `?${options}` : ""}`;
		return `hindsight-external:${createHash("sha256").update(target).digest("hex")}`;
	} catch {
		throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
	}
}

function sameStorage(a: MigrationStorage, b: MigrationStorage): boolean {
	return a.kind === b.kind && (a.kind === "managed-volume" && b.kind === "managed-volume" ? a.volume === b.volume : a.kind === "external" && b.kind === "external" && a.target === b.target);
}

function unavailableMigrationRunner(): LogicalMigrationRunner {
	const unavailable = async (): Promise<never> => { throw new ServiceRuntimeError("HINDSIGHT_MIGRATION_CONNECTOR_UNAVAILABLE"); };
	return {
		stopWriters: unavailable, dumpCustom: unavailable, validateDump: unavailable,
		createTarget: unavailable, restoreCustom: unavailable, verify: unavailable,
		switchActive: unavailable, restoreSourceRouting: unavailable,
	};
}

function safeExternalEndpoint(value: ExtensionSettingValue | undefined): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}
