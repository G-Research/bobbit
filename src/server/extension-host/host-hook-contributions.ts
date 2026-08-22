import type {
	HookCapability,
	HookFailurePolicy,
	HookNotificationSelector,
	InterceptorHookContribution,
	NotificationHookContribution,
	ProviderContribution,
} from "../agent/pack-contributions.js";
import type { LifecycleHook } from "../agent/lifecycle-hub.js";
import type { PackContributionRegistry } from "./pack-contribution-registry.js";
import type { HostInterceptorName } from "../../shared/extension-host/host-hooks.js";

const LEGACY_INTERCEPTORS: ReadonlySet<string> = new Set([
	"sessionSetup",
	"beforePrompt",
	"beforeCompact",
	"sessionShutdown",
]);

interface NormalizedContributionBase {
	readonly packId: string;
	readonly contributionId: string;
	readonly listName: string;
	readonly module: string;
	readonly sourceFile: string;
	readonly packRoot: string;
	readonly config: Readonly<Record<string, unknown>>;
	readonly budget: Readonly<{ maxTokens: number; timeoutMs: number; declaredTimeoutMs?: number }>;
	readonly capabilities: readonly HookCapability[];
	readonly activationEpoch: number;
	readonly order: number;
}

export interface NormalizedInterceptorContribution extends NormalizedContributionBase {
	readonly kind: "interceptor";
	readonly name: HostInterceptorName;
	readonly failurePolicy?: HookFailurePolicy;
	readonly declaration: InterceptorHookContribution;
}

export interface NormalizedNotificationContribution extends NormalizedContributionBase {
	readonly kind: "notification";
	readonly selector: HookNotificationSelector;
	readonly declaration: NotificationHookContribution;
}

export interface NormalizedLegacyProviderContribution extends NormalizedContributionBase {
	readonly kind: "legacy-provider";
	readonly name: Extract<LifecycleHook, "sessionSetup" | "beforePrompt" | "beforeCompact" | "sessionShutdown">;
	readonly providerId: string;
	readonly declaration: ProviderContribution;
}

export type RuntimeHookContribution =
	| NormalizedInterceptorContribution
	| NormalizedNotificationContribution
	| NormalizedLegacyProviderContribution;

type HookRegistryView = Pick<PackContributionRegistry, "list" | "listHooks" | "listProviders"> & {
	getActivationEpoch?: () => number;
};

/**
 * Normalize active declarations without importing pack code. Ordering is the
 * registry's winning-pack low-to-high order, then providers before explicit hook
 * files within each pack, then each declaration's own name order.
 */
export function normalizeHookContributions(
	registry: HookRegistryView,
	projectId: string | undefined,
): readonly RuntimeHookContribution[] {
	const epoch = registry.getActivationEpoch?.() ?? 0;
	const rows: RuntimeHookContribution[] = [];
	let order = 0;
	for (const pack of registry.list(projectId)) {
		for (const provider of pack.providers) {
			for (const candidate of provider.hooks) {
				if (!LEGACY_INTERCEPTORS.has(candidate)) continue;
				rows.push({
					kind: "legacy-provider",
					name: candidate as NormalizedLegacyProviderContribution["name"],
					packId: pack.packId,
					contributionId: provider.id,
					providerId: provider.id,
					listName: provider.listName,
					module: provider.module,
					sourceFile: provider.sourceFile,
					packRoot: provider.packRoot,
					config: provider.config ?? {},
					budget: provider.budget,
					capabilities: ["store"],
					activationEpoch: epoch,
					order: order++,
					declaration: provider,
				});
			}
		}
		for (const declaration of pack.hooks) {
			if (declaration.kind === "interceptor") {
				for (const name of declaration.interceptors) {
					rows.push({
						kind: "interceptor",
						name,
						packId: pack.packId,
						contributionId: declaration.id,
						listName: declaration.listName,
						module: declaration.module,
						sourceFile: declaration.sourceFile,
						packRoot: declaration.packRoot,
						config: declaration.config ?? {},
						budget: declaration.budget,
						capabilities: declaration.capabilities,
						activationEpoch: epoch,
						order: order++,
						failurePolicy: declaration.failurePolicy,
						declaration,
					});
				}
			} else if (declaration.kind === "notification") {
				for (const selector of declaration.notifications) {
					rows.push({
						kind: "notification",
						selector,
						packId: pack.packId,
						contributionId: declaration.id,
						listName: declaration.listName,
						module: declaration.module,
						sourceFile: declaration.sourceFile,
						packRoot: declaration.packRoot,
						config: declaration.config ?? {},
						budget: declaration.budget,
						capabilities: declaration.capabilities,
						activationEpoch: epoch,
						order: order++,
						declaration,
					});
				}
			}
			// No `kind` means compatibility metadata: intentionally inert.
		}
	}
	return Object.freeze(rows);
}
