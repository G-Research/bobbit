/**
 * Base class for all Bobbit web components.
 *
 * Owns a single `AbortController` per component lifecycle. The signal is
 * exposed to subclasses so every `addEventListener` / timer can be tied to
 * it: when the element is removed from the DOM, all bindings tear down
 * automatically. The controller is recreated on re-attach so reusable
 * elements that move around the DOM keep working transparently.
 *
 * Subclasses that override `connectedCallback` / `disconnectedCallback`
 * MUST call `super` — `connectedCallback` first, `disconnectedCallback`
 * last — to keep Lit's reactive update queue and the lifecycle controller
 * in sync.
 *
 * See `docs/design/listener-cleanup-standardisation.md` §2.1.
 */
import { LitElement } from "lit";

export abstract class BobbitElement extends LitElement {
	// Recreated on every (re)connection. Aborted on disconnect.
	#lifecycle: AbortController = new AbortController();

	/** Aborted when the element is disconnected from the DOM. */
	protected get signal(): AbortSignal {
		return this.#lifecycle.signal;
	}

	/** Subclasses override and call `super.connectedCallback()` FIRST. */
	override connectedCallback(): void {
		if (this.#lifecycle.signal.aborted) {
			// Re-attach: replace the spent controller.
			this.#lifecycle = new AbortController();
		}
		super.connectedCallback();
	}

	/** Subclasses override and call `super.disconnectedCallback()` LAST. */
	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.#lifecycle.abort();
	}

	/**
	 * Escape hatch: abort the current lifecycle without waiting for
	 * `disconnectedCallback`. Useful for elements that have an explicit
	 * `close()` API. Safe to call multiple times.
	 */
	protected abortLifecycle(): void {
		this.#lifecycle.abort();
	}
}
