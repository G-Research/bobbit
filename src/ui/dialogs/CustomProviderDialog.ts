import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@earendil-works/pi-ai";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/api.js";
import "../components/ErrorDetails.js";
import type { CustomProvider, CustomProviderType } from "../storage/stores/custom-providers-store.js";

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
	@state() private discoveredModels: Model<any>[] = [];
	@state() private manualModelsText = "";

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
			this.discoveredModels = this.provider.models || [];
			this.manualModelsText = (this.provider.models || []).map((m) => m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id).join("\n");
		} else {
			this.name = "";
			this.type = this.initialType || "openai-completions";
			this.baseUrl = "";
			this.updateDefaultBaseUrl();
			this.apiKey = "";
			this.hasStoredKey = false;
			this.clearStoredKey = false;
			this.discoveredModels = [];
			this.manualModelsText = "";
		}
		this.testError = "";
		this.testing = false;
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

	private async testConnection() {
		if (!this.isAutoDiscoveryType()) return;

		this.testing = true;
		this.testError = "";
		this.discoveredModels = [];

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
			if (!res.ok) throw new Error("Failed to test connection");

			const data = await res.json();
			this.discoveredModels = data.models || [];

			this.testError = "";
		} catch (error) {
			this.testError = error instanceof Error ? error.message : String(error);
			this.discoveredModels = [];
		} finally {
			this.testing = false;
			this.requestUpdate();
		}
	}

	private async save() {
		if (!this.name || !this.baseUrl) {
			alert(i18n("Please fill in all required fields"));
			return;
		}

		try {
			const manualModels = this.isAutoDiscoveryType() ? undefined : this.parseManualModels();
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

	private parseManualModels(): Array<{ id: string; name: string }> {
		return this.manualModelsText
			.split(/\n+/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [idPart, namePart] = line.split("|").map((part) => part.trim());
				return { id: idPart, name: namePart || idPart };
			});
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
			<div class="flex flex-col h-full overflow-hidden">
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

						${
							this.isAutoDiscoveryType()
								? html`
									<div class="flex flex-col gap-2">
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
										${this.testError ? html` <error-details .message=${this.testError}></error-details> ` : ""}
										${
											this.discoveredModels.length > 0
												? html`
													<div class="text-sm text-muted-foreground">
														${i18n("Discovered")} ${this.discoveredModels.length} ${i18n("models")}:
														<ul class="list-disc list-inside mt-2">
															${this.discoveredModels.slice(0, 5).map((model) => html`<li>${model.name}</li>`)}
															${
																this.discoveredModels.length > 5
																	? html`<li>...${i18n("and")} ${this.discoveredModels.length - 5} ${i18n("more")}</li>`
																	: ""
															}
														</ul>
													</div>
												`
												: ""
										}
									</div>
								`
								: html`
									<div class="flex flex-col gap-2">
										${Label({ htmlFor: "provider-models", children: i18n("Models") })}
										<textarea
											id="provider-models"
											class="min-h-28 px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
												focus:outline-none focus:ring-2 focus:ring-ring font-mono"
											placeholder="model-id&#10;model-id | Display name"
											.value=${this.manualModelsText}
											@input=${(e: Event) => {
												this.manualModelsText = (e.target as HTMLTextAreaElement).value;
												this.requestUpdate();
											}}
										></textarea>
										<div class="text-sm text-muted-foreground">
											Enter one model per line. Use <code>model-id | Display name</code> when the label should differ from the provider model ID.
										</div>
									</div>
								`
						}
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
