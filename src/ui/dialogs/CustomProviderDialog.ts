import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/api.js";
import "../components/ErrorDetails.js";
import type { CustomProvider, CustomProviderModelEntry, CustomProviderType } from "../storage/stores/custom-providers-store.js";

/** Shape of an entry in the /api/custom-providers/test response `models` array (server ApiModel, trimmed to what this dialog renders). */
interface DiscoveredModel {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
}

const NUMBER_INPUT_CLASS =
	"px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export class CustomProviderDialog extends DialogBase {
	private provider?: CustomProvider;
	private initialType?: CustomProviderType;
	private onSaveCallback?: () => void;

	@state() private name = "";
	@state() private type: CustomProviderType = "openai-completions";
	@state() private baseUrl = "";
	// The dialog NEVER receives the stored key from the server (read paths are
	// redacted — see redactCustomProviderConfig). `apiKey` holds only what the
	// user types in this dialog session; `hasStoredKey` mirrors the server's
	// `hasApiKey` flag; `clearStoredKey` marks an explicit user request to
	// remove the stored key on save.
	@state() private apiKey = "";
	@state() private hasStoredKey = false;
	@state() private clearStoredKey = false;
	@state() private testing = false;
	@state() private testError = "";
	@state() private discoveredModels: DiscoveredModel[] = [];
	// Structured per-model rows for non-auto-discovery ("manual") provider
	// types — replaces a free-text textarea so the optional contextWindow/
	// maxTokens overrides can be plain numeric inputs per row.
	@state() private manualModels: CustomProviderModelEntry[] = [];
	// Not itself rendered — distinguishes "never tested" (nothing shown) from
	// "tested, server reported 0 models" (shown as an explicit empty state).
	@state() private testAttempted = false;

	protected modalWidth = "min(800px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		provider: CustomProvider | undefined,
		initialType: CustomProviderType | undefined,
		onSave?: () => void,
	) {
		const dialog = new CustomProviderDialog();
		dialog.provider = provider;
		dialog.initialType = initialType;
		dialog.onSaveCallback = onSave;
		document.body.appendChild(dialog);
		dialog.initializeFromProvider();
		dialog.open();
		dialog.requestUpdate();
	}

	private initializeFromProvider() {
		if (this.provider) {
			this.name = this.provider.name;
			this.type = this.provider.type;
			this.baseUrl = this.provider.baseUrl;
			// Never prefill the key — the server redacts it on read, so all we
			// know is whether one is stored. Leaving the field blank keeps it.
			this.apiKey = "";
			this.hasStoredKey = Boolean(this.provider.hasApiKey);
			this.clearStoredKey = false;
			this.manualModels = (this.provider.models || []).map((m) => ({ ...m }));
		} else {
			this.name = "";
			this.type = this.initialType || "openai-completions";
			this.baseUrl = "";
			this.updateDefaultBaseUrl();
			this.apiKey = "";
			this.hasStoredKey = false;
			this.clearStoredKey = false;
			this.manualModels = [];
		}
		this.discoveredModels = [];
		this.testError = "";
		this.testing = false;
		this.testAttempted = false;
	}

	private updateDefaultBaseUrl() {
		if (this.baseUrl) return;

		const defaults: Record<string, string> = {
			ollama: "http://localhost:11434",
			"llama.cpp": "http://localhost:8080",
			vllm: "http://localhost:8000",
			lmstudio: "http://localhost:1234",
			"openai-completions": "",
			"openai-responses": "",
			"anthropic-messages": "",
			"openai-images": "https://api.openai.com",
			"gemini-images": "https://generativelanguage.googleapis.com",
			"google-imagen": "https://generativelanguage.googleapis.com",
		};

		this.baseUrl = defaults[this.type] || "";
	}

	private isAutoDiscoveryType(): boolean {
		return this.type === "ollama" || this.type === "llama.cpp" || this.type === "vllm" || this.type === "lmstudio";
	}

	/**
	 * Types for which "Test Connection" makes sense: auto-discovery servers
	 * (unchanged) PLUS manual/openai-completions remote APIs (e.g. NVIDIA
	 * NIM) — the server actually probes their /v1/models with the configured
	 * key (see probeOpenAICompatModels in src/server/agent/model-registry.ts),
	 * so the button validates reachability + auth honestly instead of just
	 * echoing the locally-typed model list back.
	 */
	private supportsTestConnection(): boolean {
		// Note: the Settings UI never emits the server-only "manual" type alias
		// (see CustomProviderType) — only "openai-completions" — so it isn't
		// checked here.
		return this.isAutoDiscoveryType() || this.type === "openai-completions";
	}

	/** Turn a raw error message into a distinct auth/unreachable/other classification for the headline. */
	private classifyTestError(message: string): string {
		const m = message.toLowerCase();
		if (/\b(401|403)\b/.test(m) || m.includes("unauthorized") || m.includes("forbidden")) {
			return i18n("Authentication failed — check the API key.");
		}
		if (m.includes("econnrefused") || m.includes("timeout") || m.includes("enotfound") || m.includes("eai_again") || m.includes("enetunreach")) {
			return i18n("Unreachable — check the base URL and that the server is running.");
		}
		return i18n("Test failed.");
	}

	private async testConnection() {
		if (!this.supportsTestConnection()) return;

		this.testing = true;
		this.testError = "";
		this.discoveredModels = [];
		this.testAttempted = true;

		try {
			// Test connection without persisting the provider
			const testConfig = {
				id: this.provider?.id || crypto.randomUUID(),
				name: this.name || this.type,
				type: this.type,
				baseUrl: this.baseUrl,
				apiKey: this.apiKey || undefined,
			};
			const res = await gatewayFetch("/api/custom-providers/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(testConfig),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				throw new Error(data?.error || `Test failed (HTTP ${res.status})`);
			}

			this.discoveredModels = data?.models || [];
			this.testError = "";
		} catch (error) {
			this.testError = error instanceof Error ? error.message : String(error);
			this.discoveredModels = [];
		} finally {
			this.testing = false;
			this.requestUpdate();
		}
	}

	/** Add a Test-Connection-discovered model into the manual models list (dedup by id). Manual types only — auto-discovery types never store `models`. */
	private addDiscoveredModel(model: DiscoveredModel) {
		if (this.manualModels.some((m) => m.id === model.id)) return;
		this.manualModels = [...this.manualModels, { id: model.id, name: model.name || model.id }];
		this.requestUpdate();
	}

	private addManualModelRow() {
		this.manualModels = [...this.manualModels, { id: "", name: "" }];
		this.requestUpdate();
	}

	private removeManualModelRow(index: number) {
		this.manualModels = this.manualModels.filter((_, i) => i !== index);
		this.requestUpdate();
	}

	private updateManualModelRow(index: number, patch: Partial<CustomProviderModelEntry>) {
		this.manualModels = this.manualModels.map((row, i) => (i === index ? { ...row, ...patch } : row));
		this.requestUpdate();
	}

	private async save() {
		if (!this.name || !this.baseUrl) {
			alert(i18n("Please fill in all required fields"));
			return;
		}

		try {
			// Auto-discovery types never persist a model list (fetched on-demand);
			// everything else sends the structured rows, filtering blank ones.
			const manualModels = this.isAutoDiscoveryType()
				? undefined
				: this.manualModels
						.map((m) => ({ ...m, id: m.id.trim() }))
						.filter((m) => m.id.length > 0)
						.map((m) => ({
							id: m.id,
							name: (m.name || "").trim() || m.id,
							...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
							...(typeof m.maxTokens === "number" && m.maxTokens > 0 ? { maxTokens: m.maxTokens } : {}),
						}));
			// apiKey is write-only: send it only when the user typed a new key
			// (replace) or explicitly asked to clear the stored one (null).
			// Omitting the field preserves the stored key server-side — never
			// send an empty string or a masked placeholder.
			const provider = {
				id: this.provider?.id || crypto.randomUUID(),
				name: this.name,
				type: this.type,
				baseUrl: this.baseUrl,
				...(this.apiKey ? { apiKey: this.apiKey } : this.clearStoredKey ? { apiKey: null } : {}),
				models: manualModels,
			};

			const res = await gatewayFetch("/api/custom-providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(provider),
			});
			if (!res.ok) throw new Error("Failed to save provider");

			if (this.onSaveCallback) {
				this.onSaveCallback();
			}
			this.close();
		} catch (error) {
			console.error("Failed to save provider:", error);
			alert(i18n("Failed to save provider"));
		}
	}

	private renderTestConnectionSection(): TemplateResult {
		return html`
			<div class="flex flex-col gap-2" data-testid="test-connection-section">
				${Button({
					onClick: () => this.testConnection(),
					variant: "outline",
					disabled: this.testing || !this.baseUrl,
					children: this.testing ? i18n("Testing...") : i18n("Test Connection"),
				})}
				${
					// The server only falls back to the stored key when the
					// baseUrl still matches the saved one (anti-exfiltration
					// guard) — testing a CHANGED URL needs the key typed in.
					this.hasStoredKey && !this.apiKey && this.provider && this.baseUrl !== this.provider.baseUrl
						? html`<div class="text-sm text-muted-foreground" data-testid="changed-url-key-hint">
								${i18n("Key required to test a changed URL")}
							</div>`
						: ""
				}
				${
					this.testError
						? html`<error-details
								.message=${this.classifyTestError(this.testError)}
								.code=${this.testError}
							></error-details>`
						: ""
				}
				${
					!this.testing && !this.testError && this.discoveredModels.length === 0 && this.testAttempted
						? html`<div class="text-sm text-muted-foreground" data-testid="test-connection-empty">
								${i18n("Connected — the server reported 0 models.")}
							</div>`
						: ""
				}
				${
					this.discoveredModels.length > 0
						? html`
							<div class="text-sm text-muted-foreground" data-testid="discovered-models">
								${i18n("Discovered")} ${this.discoveredModels.length} ${i18n("models")}:
								<ul class="list-disc list-inside mt-2 max-h-40 overflow-y-auto">
									${this.discoveredModels.slice(0, 20).map(
										(model) => html`
											<li class="flex items-center justify-between gap-2">
												<span>${model.name}</span>
												${
													!this.isAutoDiscoveryType() && !this.manualModels.some((m) => m.id === model.id)
														? Button({
																onClick: () => this.addDiscoveredModel(model),
																variant: "ghost",
																size: "sm",
																children: i18n("+ Add"),
															})
														: ""
												}
											</li>
										`,
									)}
									${
										this.discoveredModels.length > 20
											? html`<li>...${i18n("and")} ${this.discoveredModels.length - 20} ${i18n("more")}</li>`
											: ""
									}
								</ul>
							</div>
						`
						: ""
				}
			</div>
		`;
	}

	private renderManualModelsSection(): TemplateResult {
		return html`
			<div class="flex flex-col gap-2">
				${Label({ htmlFor: "provider-models", children: i18n("Models") })}
				<div class="flex flex-col gap-2" data-testid="manual-models-rows">
					${this.manualModels.map(
						(row, index) => html`
							<div class="flex flex-wrap items-end gap-2 rounded-md border border-border p-2" data-testid="manual-model-row">
								<div class="flex flex-col gap-1 flex-1 min-w-[160px]">
									<label class="text-xs text-muted-foreground">${i18n("Model ID")}</label>
									${Input({
										value: row.id,
										placeholder: "e.g. z-ai/glm-5.2",
										onInput: (e: Event) => this.updateManualModelRow(index, { id: (e.target as HTMLInputElement).value }),
									})}
								</div>
								<div class="flex flex-col gap-1 flex-1 min-w-[160px]">
									<label class="text-xs text-muted-foreground">${i18n("Display name (optional)")}</label>
									${Input({
										value: row.name,
										placeholder: row.id || i18n("same as ID"),
										onInput: (e: Event) => this.updateManualModelRow(index, { name: (e.target as HTMLInputElement).value }),
									})}
								</div>
								<div class="flex flex-col gap-1 w-36" data-testid="manual-model-context-window">
									<label class="text-xs text-muted-foreground">${i18n("Context window")}</label>
									<input
										type="number"
										min="0"
										class="${NUMBER_INPUT_CLASS}"
										placeholder="auto (8192)"
										.value=${row.contextWindow != null ? String(row.contextWindow) : ""}
										@input=${(e: Event) => {
											const v = (e.target as HTMLInputElement).value;
											this.updateManualModelRow(index, { contextWindow: v ? Number(v) : undefined });
										}}
									/>
								</div>
								<div class="flex flex-col gap-1 w-36" data-testid="manual-model-max-tokens">
									<label class="text-xs text-muted-foreground">${i18n("Max output tokens")}</label>
									<input
										type="number"
										min="0"
										class="${NUMBER_INPUT_CLASS}"
										placeholder="auto (4096)"
										.value=${row.maxTokens != null ? String(row.maxTokens) : ""}
										@input=${(e: Event) => {
											const v = (e.target as HTMLInputElement).value;
											this.updateManualModelRow(index, { maxTokens: v ? Number(v) : undefined });
										}}
									/>
								</div>
								${Button({
									onClick: () => this.removeManualModelRow(index),
									variant: "ghost",
									size: "sm",
									children: i18n("Remove"),
								})}
							</div>
						`,
					)}
				</div>
				${Button({
					onClick: () => this.addManualModelRow(),
					variant: "outline",
					size: "sm",
					children: i18n("+ Add model"),
				})}
				<div class="text-sm text-muted-foreground">
					${i18n(
						"Context window / max output tokens are optional overrides — leave blank to use the provider's default (8192 / 4096). Set these when the provider doesn't report context length via its API (e.g. NVIDIA NIM), otherwise Bobbit under-estimates the model's context and compacts sessions too aggressively.",
					)}
				</div>
			</div>
		`;
	}

	protected override renderContent(): TemplateResult {
		const providerTypes = [
			{ value: "ollama", label: "Ollama (auto-discovery)" },
			{ value: "llama.cpp", label: "llama.cpp (auto-discovery)" },
			{ value: "vllm", label: "vLLM (auto-discovery)" },
			{ value: "lmstudio", label: "LM Studio (auto-discovery)" },
			{ value: "openai-completions", label: "OpenAI Completions Compatible" },
			{ value: "openai-responses", label: "OpenAI Responses Compatible" },
			{ value: "anthropic-messages", label: "Anthropic Messages Compatible" },
			{ value: "openai-images", label: "OpenAI Images Compatible" },
			{ value: "gemini-images", label: "Gemini Images Compatible" },
			{ value: "google-imagen", label: "Google Imagen Compatible" },
		];

		return html`
			<div class="flex flex-col h-full overflow-hidden" data-testid="custom-provider-dialog-content">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<h2 class="text-lg font-semibold text-foreground">
						${this.provider ? i18n("Edit Provider") : i18n("Add Provider")}
					</h2>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-name", children: i18n("Provider Name") })}
							${Input({
								value: this.name,
								placeholder: i18n("e.g., My Ollama Server"),
								onInput: (e: Event) => {
									this.name = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-type", children: i18n("Provider Type") })}
							${Select({
								value: this.type,
								options: providerTypes.map((pt) => ({
									value: pt.value,
									label: pt.label,
								})),
								onChange: (value: string) => {
									this.type = value as CustomProviderType;
									this.baseUrl = "";
									this.updateDefaultBaseUrl();
									this.discoveredModels = [];
									this.testAttempted = false;
									this.testError = "";
									this.requestUpdate();
								},
								width: "100%",
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "base-url", children: i18n("Base URL") })}
							${Input({
								value: this.baseUrl,
								placeholder: i18n("e.g., http://localhost:11434"),
								onInput: (e: Event) => {
									this.baseUrl = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2" data-testid="api-key-field">
							${Label({ htmlFor: "api-key", children: i18n("API Key (Optional)") })}
							${Input({
								type: "password",
								value: this.apiKey,
								placeholder:
									this.hasStoredKey && !this.clearStoredKey
										? i18n("Key set — leave blank to keep")
										: i18n("Leave empty if not required"),
								onInput: (e: Event) => {
									this.apiKey = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
							${
								this.hasStoredKey
									? html`
										<div class="flex items-center gap-2 text-sm text-muted-foreground" data-testid="stored-key-hint">
											${
												this.clearStoredKey
													? html`<span>${i18n("Stored key will be removed on save.")}</span>
														${Button({
															onClick: () => {
																this.clearStoredKey = false;
																this.requestUpdate();
															},
															variant: "ghost",
															size: "sm",
															children: i18n("Keep stored key"),
														})}`
													: html`<span>${i18n("An API key is stored for this provider.")}</span>
														${Button({
															onClick: () => {
																this.clearStoredKey = true;
																this.requestUpdate();
															},
															variant: "ghost",
															size: "sm",
															children: i18n("Clear stored key"),
														})}`
											}
										</div>
									`
									: ""
							}
						</div>

						${this.supportsTestConnection() ? this.renderTestConnectionSection() : ""}
						${!this.isAutoDiscoveryType() ? this.renderManualModelsSection() : ""}
					</div>
				</div>

				<div class="p-6 flex-shrink-0 border-t border-border flex justify-end gap-2">
					${Button({
						onClick: () => this.close(),
						variant: "ghost",
						children: i18n("Cancel"),
					})}
					${Button({
						onClick: () => this.save(),
						variant: "default",
						disabled: !this.name || !this.baseUrl,
						children: i18n("Save"),
					})}
				</div>
			</div>
		`;
	}
}

customElements.define("custom-provider-dialog", CustomProviderDialog);
