import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Image as ImageIcon, KeyRound } from "lucide";
import { gatewayFetch } from "../../app/api.js";
import { GPT_55_RECENCY_RANK } from "../../shared/model-ranks.js";
import { Input } from "../components/Input.js";
import { formatModelCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";

/**
 * Assign a recency/tier rank to a model ID so newer flagship models sort first.
 * Higher rank = shown higher in the list. Models not matching any pattern get 0.
 */
function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();

	// ── Anthropic Claude ──
	if (s.includes("claude-opus-4-7") || s.includes("claude-opus-4.7")) return 102;
	if (s.includes("claude-opus-4-6") || s.includes("claude-opus-4.6")) return 100;
	if (s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6")) return 99;
	if (s.includes("claude-opus-4-5") || s.includes("claude-opus-4.5")) return 98;
	if (s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5")) return 97;
	if (s.includes("claude-opus-4-1") || s.includes("claude-opus-4.1")) return 96;
	if (s.includes("claude-opus-4") && !s.includes("4-1") && !s.includes("4.1") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6") && !s.includes("4-7") && !s.includes("4.7")) return 95;
	if (s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 94;
	if (s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5")) return 90;
	if (s.includes("claude-3-7-sonnet") || s.includes("claude-3.7-sonnet")) return 80;
	if (s.includes("claude-3-5-sonnet") || s.includes("claude-3.5-sonnet")) return 70;
	if (s.includes("claude-3-5-haiku") || s.includes("claude-3.5-haiku")) return 65;
	if (s.includes("claude-3-opus")) return 60;
	if (s.includes("claude")) return 50;

	// ── OpenAI ──
	if (s.includes("gpt-5.5")) return GPT_55_RECENCY_RANK;
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

type SelectorModel = Model<any> & {
	id: string;
	provider: string;
	name?: string;
	authenticated?: boolean;
	available?: boolean;
	disabled?: boolean;
	locked?: boolean;
	status?: string;
	message?: string;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type FilteredModelEntry = { provider: string; id: string; model: SelectorModel };

const TARGET_CLOUD_MODEL_PROVIDERS = new Set(["anthropic", "openai", "openai-codex", "google", "google-gemini-cli"]);
const UNSELECTABLE_MODEL_STATUSES = new Set([
	"enabled_without_credential",
	"expired",
	"invalid",
	"locked",
	"unauthenticated",
	"unavailable",
	"oauth_unavailable",
]);

function isTargetCloudModelProvider(provider: string | undefined): boolean {
	return !!provider && TARGET_CLOUD_MODEL_PROVIDERS.has(provider);
}

function isHiddenModel(model: SelectorModel): boolean {
	return model.disabled === true || model.status === "disabled";
}

function isModelSelectable(model: SelectorModel): boolean {
	if (!model || isHiddenModel(model)) return false;
	if (model.locked === true || model.available === false) return false;
	if (model.authenticated === false) return false;
	if (model.status && UNSELECTABLE_MODEL_STATUSES.has(model.status)) return false;
	return true;
}

function modelSettingsDestination(model: SelectorModel): { label: string; action: string; hash: string } {
	if (isTargetCloudModelProvider(model.provider)) {
		return { label: "Connect", action: "Connect in Settings > System > Account", hash: "#/settings/system/account" };
	}
	return { label: "Configure", action: "Configure in Settings > System > Models", hash: "#/settings/system/models" };
}

function modelUnavailableTitle(model: SelectorModel): string {
	if (model.message) return model.message;
	if (isTargetCloudModelProvider(model.provider)) return "Connect this provider in Settings > System > Account before selecting this model.";
	return "Configure this provider in Settings > System > Models before selecting this model.";
}

function modelSupportsVision(model: SelectorModel): boolean {
	return Array.isArray(model.input) && model.input.includes("image");
}

@customElement("agent-model-selector")
export class ModelSelector extends DialogBase {
	@state() currentModel: Model<any> | null = null;
	@state() searchQuery = "";
	@state() filterThinking = false;
	@state() filterVision = false;
	@state() selectedIndex = 0;
	@state() private navigationMode: "mouse" | "keyboard" = "mouse";
	@state() private serverModels: SelectorModel[] = [];
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
			const res = await gatewayFetch("/api/models");
			if (res.ok) {
				const models = await res.json();
				this.serverModels = Array.isArray(models)
					? (models as SelectorModel[]).filter((model) => !isHiddenModel(model))
					: [];
				this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
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
			if (filteredModels.length === 0) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = this.nextSelectableIndex(filteredModels, 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = this.nextSelectableIndex(filteredModels, -1);
				this.scrollToSelected();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (filteredModels[this.selectedIndex]) {
					this.handleSelect(filteredModels[this.selectedIndex].model);
				}
			}
		});
	}

	private formatTokens(tokens: number | undefined): string {
		const value = Number.isFinite(tokens) ? (tokens as number) : 0;
		if (value >= 1000000) return `${(value / 1000000).toFixed(0)}M`;
		if (value >= 1000) return `${(value / 1000).toFixed(0)}`;
		return String(value);
	}

	private firstSelectableIndex(models: FilteredModelEntry[]): number {
		const index = models.findIndex(({ model }) => isModelSelectable(model));
		return index >= 0 ? index : 0;
	}

	private nextSelectableIndex(models: FilteredModelEntry[], direction: 1 | -1): number {
		if (models.length === 0) return 0;
		const fallback = Math.min(Math.max(this.selectedIndex, 0), models.length - 1);
		for (let i = fallback + direction; i >= 0 && i < models.length; i += direction) {
			if (isModelSelectable(models[i].model)) return i;
		}
		return fallback;
	}

	private currentModelNotice(): string | null {
		if (!this.currentModel || this.loading) return null;
		const current = this.serverModels.find((model) => modelsAreEqual(this.currentModel, model));
		if (!current) {
			return "The saved model is no longer available. Choose an available model or clear the preference to use Auto (best available).";
		}
		if (!isModelSelectable(current)) {
			return "The saved model needs provider authentication before it can be selected. Connect the provider or choose another model.";
		}
		return null;
	}

	private openSettingsForModel(model: SelectorModel) {
		const destination = modelSettingsDestination(model);
		if (typeof window !== "undefined") window.location.hash = destination.hash;
		this.close();
	}

	private handleSelect(model: SelectorModel) {
		if (!model || !isModelSelectable(model)) return;
		this.onSelectCallback?.(model);
		this.close();
	}

	private getFilteredModels(): FilteredModelEntry[] {
		const allModels: FilteredModelEntry[] = [];

		for (const model of this.serverModels) {
			if (!isHiddenModel(model)) allModels.push({ provider: model.provider, id: model.id, model });
		}

		// Filter models based on search and capability filters
		let filteredModels = allModels;

		// Apply search filter
		if (this.searchQuery) {
			filteredModels = filteredModels.filter(({ provider, id, model }) => {
				const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter((t) => t);
				const searchText = `${provider} ${id} ${model.name}`.toLowerCase();
				return searchTokens.every((token) => searchText.includes(token));
			});
		}

		// Apply capability filters
		if (this.filterThinking) {
			filteredModels = filteredModels.filter(({ model }) => model.reasoning);
		}
		if (this.filterVision) {
			filteredModels = filteredModels.filter(({ model }) => modelSupportsVision(model));
		}

		// Sort: selectable current model first, then selectable models, then by recency rank.
		filteredModels.sort((a, b) => {
			const aSelectable = isModelSelectable(a.model);
			const bSelectable = isModelSelectable(b.model);
			const aIsCurrent = aSelectable && modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = bSelectable && modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			if (aSelectable && !bSelectable) return -1;
			if (!aSelectable && bSelectable) return 1;

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
						this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
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
							this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
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
							this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
							if (this.scrollContainerRef.value) {
								this.scrollContainerRef.value.scrollTop = 0;
							}
						},
						className: "rounded-full",
						children: html`<span class="inline-flex items-center gap-1">${icon(ImageIcon, "sm")} ${i18n("Vision")}</span>`,
					})}
				</div>
			</div>

			${this.currentModelNotice() ? html`
				<div class="px-6 py-3 border-b border-border bg-muted/40 text-xs text-muted-foreground">
					${this.currentModelNotice()}
				</div>
			` : ""}

			<!-- Scrollable model list -->
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${this.loading && this.serverModels.length === 0
					? html`<div class="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading models...</div>`
					: filteredModels.length === 0
						? html`<div class="flex items-center justify-center py-8 px-6 text-muted-foreground text-sm text-center">No available models match these filters.</div>`
						: filteredModels.map(({ provider, id, model }, index) => {
						const isCurrent = isModelSelectable(model) && modelsAreEqual(this.currentModel, model);
						const isSelected = index === this.selectedIndex;
						const selectable = isModelSelectable(model);
						const destination = modelSettingsDestination(model);
						const cost = model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
						return html`
							<div
								data-model-item
								aria-disabled=${selectable ? "false" : "true"}
								class="px-4 py-3 border-b border-border ${
									selectable && this.navigationMode === "mouse" ? "hover:bg-muted" : ""
								} ${selectable ? "cursor-pointer" : "cursor-default opacity-60"} ${isSelected && selectable ? "bg-accent" : ""}"
								@click=${() => this.handleSelect(model)}
								@mouseenter=${() => {
									if (selectable && this.navigationMode === "mouse") {
										this.selectedIndex = index;
									}
								}}
								title=${selectable ? "" : modelUnavailableTitle(model)}
							>
								<div class="flex items-center justify-between gap-2 mb-1">
									<div class="flex items-center gap-2 flex-1 min-w-0">
										<span class="text-sm font-medium text-foreground truncate">${id}</span>
										${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
									</div>
									<div class="flex items-center gap-1.5">
										${!selectable ? html`<span class="text-muted-foreground" title=${modelUnavailableTitle(model)}>${icon(KeyRound, "sm")}</span>` : ""}
										${Badge(provider, "outline")}
									</div>
								</div>
								<div class="flex items-center justify-between text-xs text-muted-foreground gap-3">
									<div class="flex items-center gap-2 min-w-0">
										<span class="${model.reasoning ? "" : "opacity-30"}">${icon(Brain, "sm")}</span>
										<span class="${modelSupportsVision(model) ? "" : "opacity-30"}">${icon(ImageIcon, "sm")}</span>
										<span>${this.formatTokens(model.contextWindow)}K/${this.formatTokens(model.maxTokens)}K</span>
										${!selectable ? html`<span class="truncate">${destination.action}</span>` : ""}
									</div>
									<div class="flex items-center gap-2 shrink-0">
										${!selectable ? html`
											<button
												class="text-xs text-primary hover:underline"
												@click=${(e: Event) => { e.stopPropagation(); this.openSettingsForModel(model); }}
											>${destination.label}</button>
										` : html`<span>${formatModelCost(cost)}</span>`}
									</div>
								</div>
							</div>
						`;
					})}
			</div>
		`;
	}
}
