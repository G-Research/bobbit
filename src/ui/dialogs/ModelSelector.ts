import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { getModels, getProviders, type Model, modelsAreEqual } from "@mariozechner/pi-ai";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Image as ImageIcon, KeyRound } from "lucide";
import { Input } from "../components/Input.js";
import { getAppStorage } from "../storage/app-storage.js";
import type { AutoDiscoveryProviderType } from "../storage/stores/custom-providers-store.js";
import { formatModelCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { discoverModels } from "../utils/model-discovery.js";

/**
 * Assign a recency/tier rank to a model ID so newer flagship models sort first.
 * Higher rank = shown higher in the list. Models not matching any pattern get 0.
 */
function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();

	// ── Anthropic Claude ──
	if (s.includes("claude-opus-4-6") || s.includes("claude-opus-4.6")) return 100;
	if (s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6")) return 99;
	if (s.includes("claude-opus-4-5") || s.includes("claude-opus-4.5")) return 98;
	if (s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5")) return 97;
	if (s.includes("claude-opus-4-1") || s.includes("claude-opus-4.1")) return 96;
	if (s.includes("claude-opus-4") && !s.includes("4-1") && !s.includes("4.1") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 95;
	if (s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 94;
	if (s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5")) return 90;
	if (s.includes("claude-3-7-sonnet") || s.includes("claude-3.7-sonnet")) return 80;
	if (s.includes("claude-3-5-sonnet") || s.includes("claude-3.5-sonnet")) return 70;
	if (s.includes("claude-3-5-haiku") || s.includes("claude-3.5-haiku")) return 65;
	if (s.includes("claude-3-opus")) return 60;
	if (s.includes("claude")) return 50;

	// ── OpenAI ──
	if (s.includes("gpt-5.4")) return 100;
	if (s.includes("gpt-5.3")) return 98;
	if (s.includes("gpt-5.2")) return 96;
	if (s.includes("gpt-5.1")) return 94;
	if (s.includes("gpt-5") && !s.includes("5.")) return 92;
	if (s.includes("o4-mini")) return 91;
	if (s.includes("o3-pro")) return 89;
	if (s.includes("o3") && !s.includes("o3-mini")) return 88;
	if (s.includes("o3-mini")) return 85;
	if (s.includes("o1-pro")) return 80;
	if (s.includes("o1") && !s.includes("o1-mini")) return 78;
	if (s.includes("gpt-4o") && !s.includes("mini")) return 70;
	if (s.includes("gpt-4.1")) return 68;
	if (s.includes("gpt-4o-mini") || s.includes("gpt-4.1-mini")) return 65;
	if (s.includes("gpt-4")) return 50;

	// ── Google Gemini ──
	if (s.includes("gemini-3.1-pro")) return 100;
	if (s.includes("gemini-3-pro")) return 98;
	if (s.includes("gemini-3.1-flash") || s.includes("gemini-3-flash")) return 95;
	if (s.includes("gemini-2.5-pro")) return 90;
	if (s.includes("gemini-2.5-flash") && !s.includes("lite")) return 85;
	if (s.includes("gemini-2.5-flash-lite")) return 80;
	if (s.includes("gemini-2.0")) return 60;
	if (s.includes("gemini-1.5")) return 40;
	if (s.includes("gemini")) return 30;

	// ── xAI Grok ──
	if (s.includes("grok-4")) return 100;
	if (s.includes("grok-3") && !s.includes("mini")) return 90;
	if (s.includes("grok-3-mini")) return 85;
	if (s.includes("grok-2")) return 70;
	if (s.includes("grok")) return 50;

	// ── DeepSeek ──
	if (s.includes("deepseek-v3.2")) return 95;
	if (s.includes("deepseek-v3.1")) return 90;
	if (s.includes("deepseek-r1")) return 88;
	if (s.includes("deepseek-v3")) return 85;
	if (s.includes("deepseek")) return 50;

	// ── Qwen ──
	if (s.includes("qwen3.5") || s.includes("qwen-3.5")) return 95;
	if (s.includes("qwen3-coder") || s.includes("qwen-3-coder")) return 90;
	if (s.includes("qwen3-next") || s.includes("qwen-3-next")) return 88;
	if (s.includes("qwen3") || s.includes("qwen-3")) return 85;
	if (s.includes("qwen")) return 50;

	// ── Mistral ──
	if (s.includes("devstral-medium")) return 90;
	if (s.includes("magistral")) return 88;
	if (s.includes("devstral")) return 85;
	if (s.includes("codestral")) return 80;
	if (s.includes("mistral-large")) return 75;
	if (s.includes("mistral-medium")) return 70;
	if (s.includes("mistral")) return 50;

	// ── Llama ──
	if (s.includes("llama-4") || s.includes("llama4")) return 90;
	if (s.includes("llama-3.3") || s.includes("llama3-3")) return 80;
	if (s.includes("llama-3.2") || s.includes("llama3-2")) return 70;
	if (s.includes("llama")) return 50;

	return 0;
}

/** AI Gateway model configuration — set from app layer */
export interface AigwModelConfig {
	/** When true, only gateway models are shown (built-in providers hidden) */
	active: boolean;
	/** Gateway models to display */
	models: Model<any>[];
}

@customElement("agent-model-selector")
export class ModelSelector extends DialogBase {
	/**
	 * Static aigw configuration. Set from the app layer before opening
	 * the selector. When active, built-in and custom providers are hidden
	 * and only gateway models are shown.
	 */
	static aigwConfig: AigwModelConfig = { active: false, models: [] };

	@state() currentModel: Model<any> | null = null;
	@state() searchQuery = "";
	@state() filterThinking = false;
	@state() filterVision = false;
	@state() customProvidersLoading = false;
	@state() selectedIndex = 0;
	@state() private navigationMode: "mouse" | "keyboard" = "mouse";
	@state() private customProviderModels: Model<any>[] = [];
	@state() private authenticatedProviders: Set<string> = new Set();

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
		selector.loadCustomProviders();
		selector.loadAuthenticatedProviders();
	}

	private async loadAuthenticatedProviders() {
		try {
			const storage = getAppStorage();
			const providers = await storage.providerKeys.list();
			this.authenticatedProviders = new Set(providers);
		} catch (error) {
			console.debug("Failed to load provider keys:", error);
		}
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		// Wait for dialog to be fully rendered
		await this.updateComplete;
		// Focus the search input when dialog opens
		this.searchInputRef.value?.focus();

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

	private async loadCustomProviders() {
		this.customProvidersLoading = true;
		const allCustomModels: Model<any>[] = [];

		try {
			const storage = getAppStorage();
			const customProviders = await storage.customProviders.getAll();

			// Load models from custom providers
			for (const provider of customProviders) {
				const isAutoDiscovery: boolean =
					provider.type === "ollama" ||
					provider.type === "llama.cpp" ||
					provider.type === "vllm" ||
					provider.type === "lmstudio";

				if (isAutoDiscovery) {
					try {
						const models = await discoverModels(
							provider.type as AutoDiscoveryProviderType,
							provider.baseUrl,
							provider.apiKey,
						);

						const modelsWithProvider = models.map((model) => ({
							...model,
							provider: provider.name,
						}));

						allCustomModels.push(...modelsWithProvider);
					} catch (error) {
						console.debug(`Failed to load models from ${provider.name}:`, error);
					}
				} else if (provider.models) {
					// Manual provider - models already defined
					allCustomModels.push(...provider.models);
				}
			}
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		} finally {
			this.customProviderModels = allCustomModels;
			this.customProvidersLoading = false;
			this.requestUpdate();
		}
	}

	private formatTokens(tokens: number): string {
		if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
		if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}`;
		return String(tokens);
	}

	private handleSelect(model: Model<any>) {
		if (model) {
			this.onSelectCallback?.(model);
			this.close();
		}
	}

	private getFilteredModels(): Array<{ provider: string; id: string; model: any }> {
		const allModels: Array<{ provider: string; id: string; model: any }> = [];

		// When AI Gateway is active, show ONLY gateway models
		if (ModelSelector.aigwConfig.active && ModelSelector.aigwConfig.models.length > 0) {
			for (const model of ModelSelector.aigwConfig.models) {
				allModels.push({ provider: model.provider, id: model.id, model });
			}
		} else {
			// Collect all models from known providers
			const knownProviders = getProviders();

			for (const provider of knownProviders) {
				const models = getModels(provider as any);
				for (const model of models) {
					allModels.push({ provider, id: model.id, model });
				}
			}

			// Add custom provider models
			for (const model of this.customProviderModels) {
				allModels.push({ provider: model.provider, id: model.id, model });
			}
		}

		// Filter models based on search and capability filters
		let filteredModels = allModels;

		// Apply search filter
		if (this.searchQuery) {
			filteredModels = filteredModels.filter(({ provider, id, model }) => {
				const searchTokens = this.searchQuery
					.toLowerCase()
					.split(/\s+/)
					.filter((t) => t);
				const searchText = `${provider} ${id} ${model.name}`.toLowerCase();
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

		// Sort: current model first, then authenticated providers, then by provider name
		const authed = this.authenticatedProviders;
		const aigwActive = ModelSelector.aigwConfig.active;
		filteredModels.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;

			// When aigw is active all models are "authenticated"
			if (!aigwActive) {
				const aHasKey = authed.has(a.provider);
				const bHasKey = authed.has(b.provider);
				if (aHasKey && !bHasKey) return -1;
				if (!aHasKey && bHasKey) return 1;
			}

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
		const aigwActive = ModelSelector.aigwConfig.active;

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
				${filteredModels.map(({ provider, id, model }, index) => {
					const isCurrent = modelsAreEqual(this.currentModel, model);
					const isSelected = index === this.selectedIndex;
					const hasKey = aigwActive || this.authenticatedProviders.has(provider);
					return html`
						<div
							data-model-item
							class="px-4 py-3 ${
								this.navigationMode === "mouse" ? "hover:bg-muted" : ""
							} cursor-pointer border-b border-border ${isSelected ? "bg-accent" : ""} ${hasKey ? "" : "opacity-45"}"
							@click=${() => this.handleSelect(model)}
							@mouseenter=${() => {
								// Only update selection in mouse mode
								if (this.navigationMode === "mouse") {
									this.selectedIndex = index;
								}
							}}
							title=${hasKey ? "" : i18n("API key required — set up in Settings > Providers")}
						>
							<div class="flex items-center justify-between gap-2 mb-1">
								<div class="flex items-center gap-2 flex-1 min-w-0">
									<span class="text-sm font-medium text-foreground truncate">${id}</span>
									${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
								</div>
								<div class="flex items-center gap-1.5">
									${!hasKey ? html`<span class="text-muted-foreground" title=${i18n("API key required")}>${icon(KeyRound, "sm")}</span>` : ""}
									${Badge(provider, "outline")}
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
