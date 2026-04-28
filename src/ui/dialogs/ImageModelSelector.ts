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
	sizes?: string[];
	qualities?: string[];
	aspectRatios?: string[];
	formats?: string[];
}

function imageModelRank(model: ImageGenerationModel): number {
	const s = `${model.provider}/${model.id}`.toLowerCase();
	if (s.includes("gpt-image-2")) return 100;
	if (s.includes("gemini-3.1")) return 98;
	if (s.includes("imagen-4.0-ultra")) return 97;
	if (s.includes("gemini-3-pro") || s.includes("nano-banana-pro")) return 96;
	if (s.includes("imagen-4.0-generate")) return 95;
	if (s.includes("imagen-4.0-fast")) return 94;
	if (s.includes("gpt-image-1.5")) return 94;
	if (s.includes("gpt-image-1-mini")) return 91;
	if (s.includes("gpt-image-1")) return 90;
	if (s.includes("gemini-2.5") || s.includes("nano-banana")) return 88;
	if (s.includes("dall-e-3")) return 70;
	if (s.includes("dall-e-2")) return 60;
	return 0;
}

function sameModel(a: ImageGenerationModel | null, b: ImageGenerationModel): boolean {
	return !!a && a.provider === b.provider && a.id === b.id;
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
			if (res.ok) this.serverModels = await res.json();
		} catch (err) {
			console.error("Failed to load image models:", err);
		} finally {
			this.loading = false;
		}
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		await this.updateComplete;
		this.searchInputRef.value?.focus();
		this.addEventListener("keydown", (e: KeyboardEvent) => {
			const filtered = this.getFilteredModels();
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.selectedIndex = Math.min(this.selectedIndex + 1, filtered.length - 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				this.scrollToSelected();
			} else if (e.key === "Enter" && filtered[this.selectedIndex]) {
				e.preventDefault();
				this.handleSelect(filtered[this.selectedIndex]);
			}
		});
	}

	private getFilteredModels(): ImageGenerationModel[] {
		const q = this.searchQuery.toLowerCase().trim();
		let models = this.serverModels;
		if (q) {
			const tokens = q.split(/\s+/).filter(Boolean);
			models = models.filter((m) => tokens.every((t) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(t)));
		}
		return [...models].sort((a, b) => {
			const aCurrent = sameModel(this.currentModel, a);
			const bCurrent = sameModel(this.currentModel, b);
			if (aCurrent && !bCurrent) return -1;
			if (!aCurrent && bCurrent) return 1;
			if (!!a.authenticated && !b.authenticated) return -1;
			if (!a.authenticated && !!b.authenticated) return 1;
			const rankDiff = imageModelRank(b) - imageModelRank(a);
			if (rankDiff) return rankDiff;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
	}

	private handleSelect(model: ImageGenerationModel) {
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
						this.selectedIndex = 0;
						if (this.scrollContainerRef.value) this.scrollContainerRef.value.scrollTop = 0;
					},
				})}
			</div>
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${this.loading && this.serverModels.length === 0
					? html`<div class="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading models...</div>`
					: filteredModels.map((model, index) => {
						const isCurrent = sameModel(this.currentModel, model);
						const isSelected = index === this.selectedIndex;
						const hasKey = model.authenticated ?? false;
						return html`
							<div
								data-image-model-item
								class="px-4 py-3 hover:bg-muted cursor-pointer border-b border-border ${isSelected ? "bg-accent" : ""} ${hasKey ? "" : "opacity-45"}"
								title=${hasKey ? "" : i18n("API key required — set up in Settings > Providers")}
								@click=${() => this.handleSelect(model)}
								@mouseenter=${() => { this.selectedIndex = index; }}
							>
								<div class="flex items-center justify-between gap-2 mb-1">
									<div class="flex items-center gap-2 flex-1 min-w-0">
										<span class="text-muted-foreground">${icon(ImageIcon, "sm")}</span>
										<span class="text-sm font-medium text-foreground truncate">${model.name || model.id}</span>
										${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
									</div>
									<div class="flex items-center gap-1.5">
										${!hasKey ? html`<span class="text-muted-foreground" title=${i18n("API key required")}>${icon(KeyRound, "sm")}</span>` : ""}
										${Badge(model.provider, "outline")}
									</div>
								</div>
								<div class="text-xs text-muted-foreground flex items-center justify-between gap-2">
									<span class="truncate">${model.id}</span>
									<span>${model.api === "gemini-images" ? "Gemini" : model.api === "google-imagen" ? "Imagen" : "Images API"}</span>
								</div>
							</div>
						`;
					})}
			</div>
		`;
	}
}
