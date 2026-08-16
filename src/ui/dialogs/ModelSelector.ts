import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import type { Model } from "@earendil-works/pi-ai";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Image as ImageIcon, KeyRound } from "lucide";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { gatewayRoute } from "../../shared/base-path.js";
import { modelRecencyRank } from "../../shared/model-ranks.js";
import { Input } from "../components/Input.js";
import { formatModelCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";

function modelsAreEqual(a: Model<any> | null | undefined, b: Model<any> | null | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

@customElement("agent-model-selector")
export class ModelSelector extends DialogBase {
	@state() currentModel: Model<any> | null = null;
	@state() searchQuery = "";
	@state() filterThinking = false;
	@state() filterVision = false;
	@state() selectedIndex = 0;
	@state() private navigationMode: "mouse" | "keyboard" = "mouse";
	@state() private serverModels: any[] = [];
	@state() private loading = false;

	private onSelectCallback?: (model: Model<any>) => void;
	private scrollContainerRef = createRef<HTMLDivElement>();
	private searchInputRef = createRef<HTMLInputElement>();
	private lastMousePosition = { x: 0, y: 0 };

	protected override modalWidth = "min(400px, 90vw)";

	static async open(currentModel: Model<any> | null, onSelect: (model: Model<any>) => void) {
		const selector = new ModelSelector();
		selector.currentModel = currentModel;
		selector.onSelectCallback = onSelect;
		selector.open();
		selector.loadModels();
	}

	private async loadModels() {
		this.loading = true;
		try {
			const res = await gatewayFetch(gatewayRoute("/api/models"));
			if (res.ok) {
				this.serverModels = await res.json();
			}
		} catch (err) {
			console.error("Failed to load models:", err);
		} finally {
			this.loading = false;
		}
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		// Wait for dialog to be fully rendered
		await this.updateComplete;
		// Focus the search input when dialog opens. Skip on mobile (<640px) so opening
		// the model selector doesn't summon the on-screen keyboard, which is jarring
		// and obscures most of the model list.
		const isMobile = typeof window !== "undefined" && typeof window.matchMedia === "function"
			&& !window.matchMedia("(min-width: 640px)").matches;
		if (!isMobile) this.searchInputRef.value?.focus();

		// Track actual mouse movement
		this.addEventListener("mousemove", (e: MouseEvent) => {
			// Check if mouse actually moved
			if (e.clientX !== this.lastMousePosition.x || e.clientY !== this.lastMousePosition.y) {
				this.lastMousePosition = { x: e.clientX, y: e.clientY };
				// Only switch to mouse mode on actual mouse movement
				if (this.navigationMode === "keyboard") {
					this.navigationMode = "mouse";
					// Update selection to the item under the mouse
					const target = e.target as HTMLElement;
					const modelItem = target.closest("[data-model-item]");
					if (modelItem) {
						const allItems = this.scrollContainerRef.value?.querySelectorAll("[data-model-item]");
						if (allItems) {
							const index = Array.from(allItems).indexOf(modelItem);
							if (index !== -1) {
								this.selectedIndex = index;
							}
						}
					}
				}
			}
		});

		// Add global keyboard handler for the dialog
		this.addEventListener("keydown", (e: KeyboardEvent) => {
			// Get filtered models to know the bounds
			const filteredModels = this.getFilteredModels();

			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.min(this.selectedIndex + 1, filteredModels.length - 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				this.scrollToSelected();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (filteredModels[this.selectedIndex]) {
					this.handleSelect(filteredModels[this.selectedIndex].model);
				}
			}
		});
	}

	private formatTokens(tokens: number): string {
		if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
		if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}`;
		return String(tokens);
	}

	/**
	 * A model the agent runtime cannot bind to a session (authenticated but
	 * unrunnable, e.g. google-gemini-cli Code Assist). The server marks these with
	 * `sessionSelectable === false`; the selector renders them disabled and never
	 * selects them. Undefined/true means selectable.
	 */
	private isSessionUnavailable(model: any): boolean {
		return model?.sessionSelectable === false;
	}

	/** Runtime is supplied by the model registry; it is display-only, never a selector. */
	private renderRuntimeBadge(runtime: unknown) {
		const isClaudeAgentSdk = runtime === "claude-agent-sdk";
		const label = isClaudeAgentSdk ? "Claude Agent SDK" : "Pi";
		return html`<span
			data-runtime-badge=${isClaudeAgentSdk ? "claude-agent-sdk" : "pi"}
			class="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1.5 py-px text-[10px] font-semibold leading-4 text-muted-foreground ${isClaudeAgentSdk ? "border-primary/30 bg-primary/5 text-foreground" : ""}"
			title=${`Session runtime: ${label}`}
			aria-label=${`Session runtime: ${label}`}
		>
			${isClaudeAgentSdk
				? html`<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>`
				: html`<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10M9 7v10M15 7v10M6 17h4M14 17h4"/></svg>`}
			<span class="max-w-[110px] truncate">${label}</span>
		</span>`;
	}

	private handleSelect(model: Model<any>) {
		if (!model) return;
		// Refuse to bind a session-unavailable model (guards both click and Enter).
		if (this.isSessionUnavailable(model)) return;
		this.onSelectCallback?.(model);
		this.close();
	}

	private getFilteredModels(): Array<{ provider: string; id: string; model: any }> {
		const allModels: Array<{ provider: string; id: string; model: any }> = [];

		for (const model of this.serverModels) {
			allModels.push({ provider: model.provider, id: model.id, model });
		}

		// Filter models based on search and capability filters
		let filteredModels = allModels;

		// Apply search filter
		if (this.searchQuery) {
			filteredModels = filteredModels.filter(({ provider, id, model }) => {
				const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter((t) => t);
				const searchText = `${provider} ${model.upstreamProvider ?? ""} ${id} ${model.name}`.toLowerCase();
				return searchTokens.every((token) => searchText.includes(token));
			});
		}

		// Apply capability filters
		if (this.filterThinking) {
			filteredModels = filteredModels.filter(({ model }) => model.reasoning);
		}
		if (this.filterVision) {
			filteredModels = filteredModels.filter(({ model }) => model.input.includes("image"));
		}

		// Sort: current model first, then authenticated, then by recency rank
		filteredModels.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;

			// Push session-unavailable (authenticated-but-unrunnable) models to the bottom.
			const aUnavail = this.isSessionUnavailable(a.model);
			const bUnavail = this.isSessionUnavailable(b.model);
			if (aUnavail && !bUnavail) return 1;
			if (!aUnavail && bUnavail) return -1;

			// Use authenticated field from server response
			const aHasKey = a.model.authenticated ?? false;
			const bHasKey = b.model.authenticated ?? false;
			if (aHasKey && !bHasKey) return -1;
			if (!aHasKey && bHasKey) return 1;

			// Sort by model recency/tier (higher = newer/better)
			const aRank = modelRecencyRank(a.id);
			const bRank = modelRecencyRank(b.id);
			if (aRank !== bRank) return bRank - aRank;

			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});

		return filteredModels;
	}

	private scrollToSelected() {
		requestAnimationFrame(() => {
			const scrollContainer = this.scrollContainerRef.value;
			const selectedElement = scrollContainer?.querySelectorAll("[data-model-item]")[
				this.selectedIndex
			] as HTMLElement;
			if (selectedElement) {
				selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		});
	}

	protected override renderContent(): TemplateResult {
		const filteredModels = this.getFilteredModels();

		return html`
			<!-- Header and Search -->
			<div class="p-6 pb-4 flex flex-col gap-4 border-b border-border flex-shrink-0">
				${DialogHeader({ title: i18n("Select Model") })}
				${Input({
					placeholder: i18n("Search models..."),
					value: this.searchQuery,
					inputRef: this.searchInputRef,
					onInput: (e: Event) => {
						this.searchQuery = (e.target as HTMLInputElement).value;
						this.selectedIndex = 0;
						// Reset scroll position when search changes
						if (this.scrollContainerRef.value) {
							this.scrollContainerRef.value.scrollTop = 0;
						}
					},
				})}
				<div class="flex gap-2">
					${Button({
						variant: this.filterThinking ? "default" : "secondary",
						size: "sm",
						onClick: () => {
							this.filterThinking = !this.filterThinking;
							this.selectedIndex = 0;
							if (this.scrollContainerRef.value) {
								this.scrollContainerRef.value.scrollTop = 0;
							}
						},
						className: "rounded-full",
						children: html`<span class="inline-flex items-center gap-1">${icon(Brain, "sm")} ${i18n("Thinking")}</span>`,
					})}
					${Button({
						variant: this.filterVision ? "default" : "secondary",
						size: "sm",
						onClick: () => {
							this.filterVision = !this.filterVision;
							this.selectedIndex = 0;
							if (this.scrollContainerRef.value) {
								this.scrollContainerRef.value.scrollTop = 0;
							}
						},
						className: "rounded-full",
						children: html`<span class="inline-flex items-center gap-1">${icon(ImageIcon, "sm")} ${i18n("Vision")}</span>`,
					})}
				</div>
			</div>

			<!-- Scrollable model list -->
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${this.loading && this.serverModels.length === 0
					? html`<div class="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading models...</div>`
					: filteredModels.map(({ provider, id, model }, index) => {
						const isCurrent = modelsAreEqual(this.currentModel, model);
						const isSelected = index === this.selectedIndex;
						const hasKey = model.authenticated ?? false;
						const isClaudeAgentSdk = provider === "claude-agent-sdk";
						const providerBadge = provider === "aigw" && model.upstreamProvider ? model.upstreamProvider : provider;
						const providerTitle = provider === "aigw" && model.upstreamProvider ? `AIGW provider: ${model.upstreamProvider}` : provider;
						const sessionUnavailable = this.isSessionUnavailable(model);
						const dimmed = sessionUnavailable || !hasKey;
						const rowTitle = sessionUnavailable
							? (model.sessionUnavailableReason
								?? "This model can't be used in agent sessions yet.")
							: (hasKey
								? ""
								: isClaudeAgentSdk
									? "Anthropic subscription OAuth required — connect Anthropic OAuth in Settings → Account."
									: "API key or account login required — set up in Settings → Account, or add a key under Settings → Models.");
						return html`
							<div
								data-model-item
								data-model-id=${id}
								data-session-unavailable=${sessionUnavailable ? "true" : "false"}
								class="px-4 py-3 ${
									this.navigationMode === "mouse" && !sessionUnavailable ? "hover:bg-muted" : ""
								} ${sessionUnavailable ? "cursor-not-allowed" : "cursor-pointer"} border-b border-border ${isSelected ? "bg-accent" : ""} ${dimmed ? "opacity-45" : ""}"
								@click=${() => this.handleSelect(model)}
								@mouseenter=${() => {
									// Only update selection in mouse mode
									if (this.navigationMode === "mouse") {
										this.selectedIndex = index;
									}
								}}
								title=${rowTitle}
							>
								<div class="flex items-center justify-between gap-2 mb-1">
									<div class="flex items-center gap-2 flex-1 min-w-0">
										<span class="text-sm font-medium text-foreground truncate">${isClaudeAgentSdk ? model.name : id}</span>
										${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
									</div>
									<div class="flex items-center gap-1.5">
										${sessionUnavailable ? Badge("Account only", "secondary") : ""}
										${!hasKey && !sessionUnavailable ? html`<span class="text-muted-foreground" title=${isClaudeAgentSdk ? "Anthropic subscription OAuth required" : "Authentication required"}>${icon(KeyRound, "sm")}</span>` : ""}
										${this.renderRuntimeBadge(model.runtime)}
										<span title=${providerTitle}>${Badge(providerBadge, "outline")}</span>
									</div>
								</div>
								<div class="flex items-center justify-between text-xs text-muted-foreground">
									<div class="flex items-center gap-2">
										<span class="${model.reasoning ? "" : "opacity-30"}">${icon(Brain, "sm")}</span>
										<span class="${model.input.includes("image") ? "" : "opacity-30"}">${icon(ImageIcon, "sm")}</span>
										<span>${this.formatTokens(model.contextWindow)}K/${this.formatTokens(model.maxTokens)}K</span>
									</div>
									<span>${formatModelCost(model.cost)}</span>
								</div>
							</div>
						`;
					})}
			</div>
		`;
	}
}
