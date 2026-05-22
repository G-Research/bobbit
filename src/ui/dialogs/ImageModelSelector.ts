import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Image as ImageIcon, KeyRound } from "lucide";
import { gatewayFetch } from "../../app/api.js";
import { Input } from "../components/Input.js";
import { i18n } from "../utils/i18n.js";

export interface ImageGenerationModel {
	id: string;
	name: string;
	provider: string;
	api: "openai-images" | "gemini-images" | "google-imagen";
	authenticated?: boolean;
	available?: boolean;
	disabled?: boolean;
	locked?: boolean;
	status?: string;
	message?: string;
	sizes?: string[];
	qualities?: string[];
	aspectRatios?: string[];
	formats?: string[];
}

/**
 * Assign a recency rank to an image model. Models are surfaced by the server
 * in `getAvailableImageModels` order (see `src/server/agent/image-generation.ts`)
 * so we use that fetched list as the source of truth: models earlier in the
 * registry rank higher. Models not in `registry` (e.g. transient mock entries
 * in tests) sort below known ones.
 */
export function imageModelRank(model: ImageGenerationModel, registry: readonly ImageGenerationModel[]): number {
	const idx = registry.findIndex((m) => m.provider === model.provider && m.id === model.id);
	if (idx < 0) return -1;
	return registry.length - idx;
}

function sameModel(a: ImageGenerationModel | null, b: ImageGenerationModel): boolean {
	return !!a && a.provider === b.provider && a.id === b.id;
}

const TARGET_CLOUD_IMAGE_PROVIDERS = new Set(["openai", "google"]);
const UNSELECTABLE_IMAGE_STATUSES = new Set([
	"enabled_without_credential",
	"expired",
	"invalid",
	"locked",
	"unauthenticated",
	"unavailable",
	"oauth_unavailable",
]);

function isHiddenImageModel(model: ImageGenerationModel): boolean {
	return model.disabled === true || model.status === "disabled";
}

function isImageModelSelectable(model: ImageGenerationModel): boolean {
	if (!model || isHiddenImageModel(model)) return false;
	if (model.locked === true || model.available === false) return false;
	if (model.authenticated === false) return false;
	if (model.status && UNSELECTABLE_IMAGE_STATUSES.has(model.status)) return false;
	return true;
}

function imageModelSettingsDestination(model: ImageGenerationModel): { label: string; action: string; hash: string } {
	if (TARGET_CLOUD_IMAGE_PROVIDERS.has(model.provider)) {
		return { label: "Connect", action: "Connect in Settings > System > Account", hash: "#/settings/system/account" };
	}
	return { label: "Configure", action: "Configure in Settings > System > Models", hash: "#/settings/system/models" };
}

function imageModelUnavailableTitle(model: ImageGenerationModel): string {
	if (model.message) return model.message;
	if (TARGET_CLOUD_IMAGE_PROVIDERS.has(model.provider)) return "Connect this provider in Settings > System > Account before selecting this image model.";
	return "Configure this provider in Settings > System > Models before selecting this image model.";
}

@customElement("image-model-selector")
export class ImageModelSelector extends DialogBase {
	@state() currentModel: ImageGenerationModel | null = null;
	@state() searchQuery = "";
	@state() selectedIndex = 0;
	@state() private serverModels: ImageGenerationModel[] = [];
	@state() private loading = false;

	private onSelectCallback?: (model: ImageGenerationModel) => void;
	private scrollContainerRef = createRef<HTMLDivElement>();
	private searchInputRef = createRef<HTMLInputElement>();

	protected override modalWidth = "min(400px, 90vw)";

	static async open(currentModel: ImageGenerationModel | null, onSelect: (model: ImageGenerationModel) => void) {
		const selector = new ImageModelSelector();
		selector.currentModel = currentModel;
		selector.onSelectCallback = onSelect;
		selector.open();
		selector.loadModels();
	}

	private async loadModels() {
		this.loading = true;
		try {
			const res = await gatewayFetch("/api/image-models");
			if (res.ok) {
				const models = await res.json();
				this.serverModels = Array.isArray(models)
					? (models as ImageGenerationModel[]).filter((model) => !isHiddenImageModel(model))
					: [];
				this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
			}
		} catch (err) {
			console.error("Failed to load image models:", err);
		} finally {
			this.loading = false;
		}
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		await this.updateComplete;
		// Skip auto-focus on mobile to avoid summoning the on-screen keyboard.
		const isMobile = typeof window !== "undefined" && typeof window.matchMedia === "function"
			&& !window.matchMedia("(min-width: 640px)").matches;
		if (!isMobile) this.searchInputRef.value?.focus();
		this.addEventListener("keydown", (e: KeyboardEvent) => {
			const filtered = this.getFilteredModels();
			if (filtered.length === 0) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.selectedIndex = this.nextSelectableIndex(filtered, 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.selectedIndex = this.nextSelectableIndex(filtered, -1);
				this.scrollToSelected();
			} else if (e.key === "Enter" && filtered[this.selectedIndex]) {
				e.preventDefault();
				this.handleSelect(filtered[this.selectedIndex]);
			}
		});
	}

	private firstSelectableIndex(models: ImageGenerationModel[]): number {
		const index = models.findIndex((model) => isImageModelSelectable(model));
		return index >= 0 ? index : 0;
	}

	private nextSelectableIndex(models: ImageGenerationModel[], direction: 1 | -1): number {
		if (models.length === 0) return 0;
		const fallback = Math.min(Math.max(this.selectedIndex, 0), models.length - 1);
		for (let i = fallback + direction; i >= 0 && i < models.length; i += direction) {
			if (isImageModelSelectable(models[i])) return i;
		}
		return fallback;
	}

	private currentModelNotice(): string | null {
		if (!this.currentModel || this.loading) return null;
		const current = this.serverModels.find((model) => sameModel(this.currentModel, model));
		if (!current) {
			return "The saved image model is no longer available. Choose an available model or clear the preference to use Auto.";
		}
		if (!isImageModelSelectable(current)) {
			return "The saved image model needs provider authentication before it can be selected. Connect the provider or choose another model.";
		}
		return null;
	}

	private openSettingsForModel(model: ImageGenerationModel) {
		const destination = imageModelSettingsDestination(model);
		if (typeof window !== "undefined") window.location.hash = destination.hash;
		this.close();
	}

	private getFilteredModels(): ImageGenerationModel[] {
		const q = this.searchQuery.toLowerCase().trim();
		let models = this.serverModels.filter((model) => !isHiddenImageModel(model));
		if (q) {
			const tokens = q.split(/\s+/).filter(Boolean);
			models = models.filter((m) => tokens.every((t) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(t)));
		}
		const registry = this.serverModels;
		return [...models].sort((a, b) => {
			const aSelectable = isImageModelSelectable(a);
			const bSelectable = isImageModelSelectable(b);
			const aCurrent = aSelectable && sameModel(this.currentModel, a);
			const bCurrent = bSelectable && sameModel(this.currentModel, b);
			if (aCurrent && !bCurrent) return -1;
			if (!aCurrent && bCurrent) return 1;
			if (aSelectable && !bSelectable) return -1;
			if (!aSelectable && bSelectable) return 1;
			const rankDiff = imageModelRank(b, registry) - imageModelRank(a, registry);
			if (rankDiff) return rankDiff;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
	}

	private handleSelect(model: ImageGenerationModel) {
		if (!isImageModelSelectable(model)) return;
		this.onSelectCallback?.(model);
		this.close();
	}

	private scrollToSelected() {
		requestAnimationFrame(() => {
			const selected = this.scrollContainerRef.value?.querySelectorAll("[data-image-model-item]")[this.selectedIndex] as HTMLElement;
			selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	}

	protected override renderContent(): TemplateResult {
		const filteredModels = this.getFilteredModels();
		return html`
			<div class="p-6 pb-4 flex flex-col gap-4 border-b border-border flex-shrink-0">
				${DialogHeader({ title: "Select Image Model" })}
				${Input({
					placeholder: i18n("Search models..."),
					value: this.searchQuery,
					inputRef: this.searchInputRef,
					onInput: (e: Event) => {
						this.searchQuery = (e.target as HTMLInputElement).value;
						this.selectedIndex = this.firstSelectableIndex(this.getFilteredModels());
						if (this.scrollContainerRef.value) this.scrollContainerRef.value.scrollTop = 0;
					},
				})}
			</div>
			${this.currentModelNotice() ? html`
				<div class="px-6 py-3 border-b border-border bg-muted/40 text-xs text-muted-foreground">
					${this.currentModelNotice()}
				</div>
			` : ""}
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${this.loading && this.serverModels.length === 0
					? html`<div class="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading models...</div>`
					: filteredModels.length === 0
						? html`<div class="flex items-center justify-center py-8 px-6 text-muted-foreground text-sm text-center">No available image models match these filters.</div>`
						: filteredModels.map((model, index) => {
						const selectable = isImageModelSelectable(model);
						const isCurrent = selectable && sameModel(this.currentModel, model);
						const isSelected = index === this.selectedIndex;
						const destination = imageModelSettingsDestination(model);
						return html`
							<div
								data-image-model-item
								aria-disabled=${selectable ? "false" : "true"}
								class="px-4 py-3 border-b border-border ${selectable ? "hover:bg-muted cursor-pointer" : "cursor-default opacity-60"} ${isSelected && selectable ? "bg-accent" : ""}"
								title=${selectable ? "" : imageModelUnavailableTitle(model)}
								@click=${() => this.handleSelect(model)}
								@mouseenter=${() => { if (selectable) this.selectedIndex = index; }}
							>
								<div class="flex items-center justify-between gap-2 mb-1">
									<div class="flex items-center gap-2 flex-1 min-w-0">
										<span class="text-muted-foreground">${icon(ImageIcon, "sm")}</span>
										<span class="text-sm font-medium text-foreground truncate">${model.name || model.id}</span>
										${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
									</div>
									<div class="flex items-center gap-1.5">
										${!selectable ? html`<span class="text-muted-foreground" title=${imageModelUnavailableTitle(model)}>${icon(KeyRound, "sm")}</span>` : ""}
										${Badge(model.provider, "outline")}
									</div>
								</div>
								<div class="text-xs text-muted-foreground flex items-center justify-between gap-2">
									<span class="truncate">${model.id}</span>
									<div class="flex items-center gap-2 shrink-0">
										${!selectable ? html`
											<span class="hidden sm:inline">${destination.action}</span>
											<button class="text-primary hover:underline" @click=${(e: Event) => { e.stopPropagation(); this.openSettingsForModel(model); }}>${destination.label}</button>
										` : html`<span>${model.api === "gemini-images" ? "Gemini" : model.api === "google-imagen" ? "Imagen" : "Images API"}</span>`}
									</div>
								</div>
							</div>
						`;
					})}
			</div>
		`;
	}
}
