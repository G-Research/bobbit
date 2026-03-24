import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export interface StoredKeyBinding {
	key: string;
	ctrlOrMeta: boolean;
	shift: boolean;
	alt: boolean;
}

/**
 * Store for persisting custom keyboard shortcut bindings.
 * Stores all bindings under a single "bindings" key as a flat map.
 */
export class ShortcutBindingsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "shortcut-bindings",
		};
	}

	async getBindings(): Promise<Record<string, StoredKeyBinding[]> | null> {
		return this.getBackend().get("shortcut-bindings", "bindings");
	}

	async saveBindings(bindings: Record<string, StoredKeyBinding[]>): Promise<void> {
		await this.getBackend().set("shortcut-bindings", "bindings", bindings);
	}

	async clearBindings(): Promise<void> {
		await this.getBackend().delete("shortcut-bindings", "bindings");
	}
}
