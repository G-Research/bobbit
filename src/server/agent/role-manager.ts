import { RoleStore, type Role } from "./role-store.js";
import { generateRoleNames } from "./name-generator.js";

/** Valid role name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export class RoleManager {
	constructor(private store: RoleStore) {
	}

	createRole(opts: {
		name: string;
		label: string;
		promptTemplate: string;
		toolPolicies?: Record<string, import("./role-store.js").GrantPolicy>;
		accessory?: string;
	}): Role {
		const { name, label, promptTemplate, toolPolicies, accessory = "none" } = opts;

		if (!name || typeof name !== "string") {
			throw new Error("Missing role name");
		}
		if (!NAME_PATTERN.test(name)) {
			throw new Error("Role name must be lowercase alphanumeric + hyphens (e.g. 'my-role')");
		}
		if (this.store.get(name)) {
			throw new Error(`Role \"${name}\" already exists`);
		}

		if (!label || typeof label !== "string") {
			throw new Error("Missing role label");
		}

		const now = Date.now();
		const role: Role = {
			name,
			label,
			promptTemplate: promptTemplate || "",
			accessory,
			toolPolicies,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(role);

		// Fire-and-forget: generate role-themed names via LLM
		generateRoleNames(name, label).catch((err) => {
			console.error(`[role-manager] Failed to generate names for role "${name}":`, err);
		});

		return role;
	}

	getRole(name: string): Role | undefined {
		return this.store.get(name);
	}

	listRoles(): Role[] {
		return this.store.getAll();
	}

	updateRole(name: string, updates: {
		label?: string;
		promptTemplate?: string;
		accessory?: string;
		toolPolicies?: Record<string, import("./role-store.js").GrantPolicy>;
	}): boolean {
		return this.store.update(name, updates);
	}

	deleteRole(name: string): boolean {
		const role = this.store.get(name);
		if (!role) return false;
		this.store.remove(name);
		return true;
	}


}
