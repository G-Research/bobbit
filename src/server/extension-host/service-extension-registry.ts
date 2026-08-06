// src/server/extension-host/service-extension-registry.ts
//
// Read-only bridge between the active pack projection and the core-owned
// service runtime. It deliberately has no process, settings-value, or secret
// access: PackContributionRegistry already applies winner and activation rules.

import type { PackContributionResolver } from "./pack-contribution-registry.js";
import type { ServiceExtensionSpec } from "./service-extension-contract.js";

export interface ResolvedServiceExtension {
	packId: string;
	packName: string;
	listName: string;
	spec: ServiceExtensionSpec;
}

/** Resolves only active declarations. Calling this cannot start a service. */
export class ServiceExtensionRegistry {
	constructor(private readonly contributions: Pick<PackContributionResolver, "list">) {}

	list(projectId: string | undefined): ResolvedServiceExtension[] {
		return this.contributions.list(projectId).flatMap(pack =>
			pack.runtimes.map(runtime => ({
				packId: pack.packId,
				packName: pack.packName,
				listName: runtime.listName,
				spec: cloneSpec(runtime.spec),
			})),
		);
	}
}

function cloneSpec(spec: ServiceExtensionSpec): ServiceExtensionSpec {
	return {
		...spec,
		readiness: { ...spec.readiness },
		...(spec.ports ? { ports: [...spec.ports] } : {}),
	};
}
