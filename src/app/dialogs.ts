import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { WandSparkles } from "lucide";
import { cwdCombobox } from "./cwd-combobox.js";
import {
	state,
	renderApp,
	setProjects,
	activeSessionId,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GOAL_STATE_LABELS,
	type Goal,
	type GoalState,
} from "./state.js";
import { gatewayFetch, updateGoal, SymlinkRootError, type DetectedRepo, type MonorepoScanResult } from "./api.js";
import "../ui/components/DirectoryPicker.js";
import type {
	DirectoryPicker as DirectoryPickerEl,
	DirectoryPickerPathDetail,
	DirectoryBrowseResult,
} from "../ui/components/DirectoryPicker.js";
import type {
	ProjectScanItem,
	ProjectAssistantScanContext,
} from "./project-assistant-autoprompt.js";
import { errorDetails } from "./error-helpers.js";
import "../ui/components/ErrorDetails.js";
import { updateLocalSessionTitle } from "./api.js";
import { refreshSessions } from "./api.js";
import { BOBBIT_HUE_ROTATIONS, sessionColorMap, setSessionColor, statusBobbit, getAccessory } from "./session-colors.js";
// NOTE: session-manager imports from dialogs, so we use dynamic imports to break the cycle

// ============================================================================
// PREFLIGHT TYPES — mirror the server's PreflightReport shape from
// src/server/agent/project-preflight.ts. See docs/design/robust-add-project.md.
// Kept inline to avoid coupling the UI bundle to a server-only module.
// ============================================================================

export type PreflightLevel = "pass" | "warn" | "fail";

export interface PreflightCheck {
	id: string;
	level: PreflightLevel;
	title: string;
	detail: string;
	remediation?: {
		kind: "archive-bobbit" | "use-canonical" | "shorter-path" | "free-space" | "external";
		label: string;
		payload?: Record<string, unknown>;
	};
}

export interface PreflightReport {
	rootPath: string;
	canonical: string;
	checks: PreflightCheck[];
	hasFail: boolean;
}

export interface ArchiveResult {
	archiveDir: string;
	archivedAt: string;
	movedPaths: string[];
	preservedPaths: string[];
	gatewayOwned: boolean;
	partial?: { failed: Array<{ path: string; error: string }> };
}

// ============================================================================
// CONFIRM / ERROR DIALOGS
// ============================================================================

export function confirmAction(title: string, message: string, confirmLabel = "Confirm", destructive = false): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const cleanup = (result: boolean) => {
			document.removeEventListener("keydown", onKeydown);
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
			if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
		};
		document.addEventListener("keydown", onKeydown);

		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(false),
				width: "min(400px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title })}
							<p class="text-sm text-muted-foreground mt-2">${message}</p>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
								${Button({
									variant: destructive ? "destructive" as any : "default",
									onClick: () => cleanup(true),
									children: confirmLabel,
									className: destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	});
}

export function showConnectionError(title: string, message: string, opts?: { code?: string; stack?: string }): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	render(
		Dialog({
			isOpen: true,
			onClose: cleanup,
			width: "min(400px, 92vw)",
			height: "auto",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						${DialogHeader({ title })}
						<div class="mt-2"><error-details .message=${message} .code=${opts?.code} .stack=${opts?.stack}></error-details></div>
					`,
				})}
				${DialogFooter({
					className: "px-6 pb-4",
					children: html`
						<div class="flex gap-2 justify-end">
							${Button({ variant: "default", onClick: cleanup, children: "OK" })}
						</div>
					`,
				})}
			`,
		}),
		container,
	);
}

/**
 * Confirm-canonical-path modal shown when `registerProject` rejects with a
 * SymlinkRootError. Renders alongside (NOT closing) the parent add-project
 * dialog so the user can hit Cancel and return to it cleanly.
 */
function promptSymlinkConfirm(
	_name: string,
	rootPath: string,
	canonical: string,
	onConfirm: (canonical: string) => void,
	onCancel: () => void,
): Promise<void> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const close = () => {
			render(html``, container);
			container.remove();
			resolve();
		};

		const cancel = () => {
			close();
			onCancel();
		};

		const confirm = () => {
			close();
			onConfirm(canonical);
		};

		render(
			Dialog({
				isOpen: true,
				onClose: cancel,
				width: "min(480px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Symlinked project root" })}
							<div class="flex flex-col gap-2 mt-2 text-sm" data-testid="symlink-confirm">
								<p class="text-foreground">
									<code class="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground" data-testid="symlink-rootpath">${rootPath}</code>
									is a symlink to
									<code class="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground" data-testid="symlink-canonical">${canonical}</code>.
								</p>
								<p class="text-muted-foreground text-xs">
									Bobbit will register the canonical path to avoid worktree corruption. Continue?
								</p>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cancel, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: confirm,
									children: html`<span data-testid="confirm-use-canonical">Use canonical path</span>`,
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	});
}

/**
 * Render the preflight panel inside the add-project dialog. Surfaces the
 * pass/warn/fail checks from `GET /api/projects/preflight` and exposes the
 * inline archive CTA on the `bobbit.existing` row. Stateless: caller owns
 * the report + loading flags and re-renders on change.
 */
function renderPreflightPanel(opts: {
	report: PreflightReport | null;
	loading: boolean;
	error: string;
	archiving: boolean;
	onArchive: () => void;
}) {
	if (opts.loading && !opts.report) {
		return html`
			<div class="mt-3 border-t border-border pt-3" data-testid="preflight-panel" data-loading="1">
				<p class="text-xs text-muted-foreground">Running pre-flight checks…</p>
			</div>
		`;
	}
	if (opts.error && !opts.report) {
		return html`
			<div class="mt-3 border-t border-border pt-3" data-testid="preflight-panel" data-error="1">
				<p class="text-xs text-red-500">Pre-flight error: ${opts.error}</p>
			</div>
		`;
	}
	if (!opts.report) return "";

	const iconFor = (level: PreflightLevel) => {
		switch (level) {
			case "pass":
				return html`<span class="text-green-600 dark:text-green-400 font-bold" aria-label="pass">✓</span>`;
			case "warn":
				return html`<span class="text-amber-600 dark:text-amber-400 font-bold" aria-label="warn">⚠</span>`;
			case "fail":
				return html`<span class="text-red-600 dark:text-red-400 font-bold" aria-label="fail">✗</span>`;
		}
	};

	return html`
		<div class="mt-3 border-t border-border pt-3 flex flex-col gap-1.5" data-testid="preflight-panel" data-has-fail=${opts.report.hasFail ? "1" : "0"}>
			<div class="flex items-center justify-between">
				<p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pre-flight</p>
				${opts.report.hasFail
					? html`<span class="text-[10px] text-red-600 dark:text-red-400 font-medium" data-testid="preflight-blocked">Blocked</span>`
					: html`<span class="text-[10px] text-green-600 dark:text-green-400 font-medium" data-testid="preflight-ok">Ready</span>`}
			</div>
			<ul class="flex flex-col gap-1">
				${opts.report.checks.map(check => html`
					<li class="flex items-start gap-2 text-xs" data-testid="preflight-check" data-check-id=${check.id} data-check-level=${check.level}>
						<span class="shrink-0 w-4 text-center mt-0.5">${iconFor(check.level)}</span>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="text-foreground font-medium">${check.title}</span>
								${check.id === "bobbit.existing" && check.level !== "pass"
									? html`<button
										class="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
										@click=${opts.onArchive}
										?disabled=${opts.archiving}
										data-testid="preflight-archive-cta"
										title="Move existing .bobbit/ to .bobbit-archive-NNN/"
									>${opts.archiving ? "Archiving…" : (check.remediation?.label || "Archive existing .bobbit/")}</button>`
									: ""}
							</div>
							${check.detail ? html`<p class="text-muted-foreground text-[11px] leading-snug">${check.detail}</p>` : ""}
						</div>
					</li>
				`)}
			</ul>
		</div>
	`;
}

/**
 * Confirm-archive modal shown when the user clicks the inline archive CTA on
 * the `bobbit.existing` preflight row. Lists the target archive directory
 * and, if the gateway owns this directory, notes that gateway-owned files
 * are preserved. Resolves with the user's confirmation (true = proceed).
 */
function promptArchiveConfirm(opts: {
	rootPath: string;
	gatewayOwned: boolean;
	existingDetail: string;
}): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const close = (result: boolean) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		render(
			Dialog({
				isOpen: true,
				onClose: () => close(false),
				width: "min(520px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Archive existing .bobbit/" })}
							<div class="flex flex-col gap-3 mt-2 text-sm" data-testid="archive-confirm">
								<p class="text-foreground">
									Bobbit will move the existing
									<code class="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground">.bobbit/</code>
									contents into a new
									<code class="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground">.bobbit-archive-NNN/</code>
									directory under
									<code class="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground" data-testid="archive-rootpath">${opts.rootPath}</code>.
								</p>
								${opts.existingDetail ? html`<p class="text-muted-foreground text-xs" data-testid="archive-existing-detail">${opts.existingDetail}</p>` : ""}
								${opts.gatewayOwned ? html`
									<div class="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300" data-testid="archive-gateway-owned">
										This directory contains gateway-owned state (the running server depends on it).
										Files like <code class="font-mono">state/gateway-url</code>, <code class="font-mono">state/watchdog.json</code>,
										<code class="font-mono">state/tls/</code>, <code class="font-mono">state/projects.json</code>, and
										<code class="font-mono">state/sessions.json</code> will be <strong>preserved in place</strong>;
										everything else will be archived.
									</div>
								` : html`
									<p class="text-muted-foreground text-xs">
										A <code class="font-mono">MANIFEST.json</code> file inside the archive lists everything that moved
										so you can manually undo the operation if needed.
									</p>
								`}
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => close(false), children: "Cancel" })}
								${Button({
									variant: "destructive" as any,
									onClick: () => close(true),
									children: html`<span data-testid="confirm-archive-bobbit">Archive and continue</span>`,
									className: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	});
}

// ============================================================================
// OAUTH DIALOG
// ============================================================================

/**
 * Returns the OAuth authentication status for `provider`.
 *
 * IMPORTANT: a transient HTTP failure (network blip, gateway restart in
 * flight, server overload) must NOT be reported as "not authenticated" —
 * doing so causes `authenticateGateway()` to spuriously open the OAuth
 * dialog over a perfectly valid session, which is a confusing UX bug in
 * production and a long-tail E2E flake (the dialog steals focus and
 * subsequent assertions on sidebar/page elements time out).
 *
 * Distinguish:
 *   - HTTP 200 + `authenticated: false`  → genuinely not authenticated
 *   - any other response (non-2xx, JSON parse failure, network error)
 *     → status indeterminate; retry once. If still indeterminate, treat as
 *     authenticated (best-effort) — the actual gateway endpoints will
 *     reject if the credential really is missing.
 */
export async function checkOAuthStatus(provider = "anthropic"): Promise<boolean> {
	const attempt = async (): Promise<{ ok: boolean; auth: boolean | null }> => {
		try {
			const res = await gatewayFetch(`/api/oauth/status?provider=${encodeURIComponent(provider)}`);
			if (!res.ok) return { ok: false, auth: null };
			const data = await res.json();
			return { ok: true, auth: data.authenticated === true };
		} catch {
			return { ok: false, auth: null };
		}
	};
	const first = await attempt();
	if (first.ok) return first.auth === true;
	// Indeterminate — retry once after a short delay.
	await new Promise((r) => setTimeout(r, 250));
	const second = await attempt();
	if (second.ok) return second.auth === true;
	// Still indeterminate after a retry. Assume authenticated rather than
	// stealing the user's flow with a spurious OAuth dialog. The first real
	// authenticated request will fail-closed if the credential truly is
	// missing, and the dialog will surface there.
	return true;
}

export function openOAuthDialog(provider = "anthropic"): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let flowId = "";
		let authUrl = "";
		let callbackServer = false;
		let instructions = "";
		let codeValue = "";
		let step: "loading" | "waiting" | "exchanging" | "done" | "error" = "loading";
		let error = "";
		let pollTimer: number | undefined;
		let pollStartMs = 0;
		let pollDelayMs = 1000;
		const POLL_MAX_DELAY_MS = 8000;
		const POLL_MAX_TOTAL_MS = 5 * 60 * 1000;

		const providerName = provider === "openai-codex" || provider === "openai" ? "OpenAI" : "Anthropic";

		const cleanup = (result: boolean) => {
			if (pollTimer !== undefined) window.clearTimeout(pollTimer);
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const pollFlowStatus = async () => {
			if (!flowId || step !== "waiting") return;
			if (pollStartMs === 0) pollStartMs = Date.now();
			if (Date.now() - pollStartMs > POLL_MAX_TOTAL_MS) {
				error = "OAuth flow timed out after 5 minutes";
				step = "error";
				renderOAuthDialog();
				return;
			}
			try {
				const res = await gatewayFetch(`/api/oauth/flow-status?flowId=${encodeURIComponent(flowId)}&provider=${encodeURIComponent(provider)}`);
				if (res.ok) {
					const data = await res.json();
					if (data.complete) {
						step = "done";
						renderOAuthDialog();
						setTimeout(() => cleanup(true), 500);
						return;
					}
					if (data.error) {
						error = data.error;
						step = "error";
						renderOAuthDialog();
						return;
					}
				}
			} catch {
				// Keep polling; the manual paste path remains available.
			}
			// Exponential backoff: 1s → 2s → 4s → 8s (cap), capped at 5min total wait.
			pollTimer = window.setTimeout(pollFlowStatus, pollDelayMs);
			pollDelayMs = Math.min(pollDelayMs * 2, POLL_MAX_DELAY_MS);
		};

		const startFlow = async () => {
			try {
				const res = await gatewayFetch("/api/oauth/start", {
					method: "POST",
					body: JSON.stringify({ provider }),
				});
				if (!res.ok) throw new Error("Failed to start OAuth flow");
				const data = await res.json();
				flowId = data.flowId;
				authUrl = data.url;
				callbackServer = data.callbackServer === true;
				instructions = data.instructions || "";
				step = "waiting";
				window.open(authUrl, "_blank");
				renderOAuthDialog();
				if (callbackServer) pollFlowStatus();
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				step = "error";
				renderOAuthDialog();
			}
		};

		const handleSubmitCode = async () => {
			if (!codeValue.trim()) return;
			step = "exchanging";
			renderOAuthDialog();

			try {
				const res = await gatewayFetch("/api/oauth/complete", {
					method: "POST",
					body: JSON.stringify({ flowId, code: codeValue.trim() }),
				});
				const data = await res.json();
				if (data.success) {
					step = "done";
					renderOAuthDialog();
					setTimeout(() => cleanup(true), 500);
				} else {
					error = data.error || "OAuth exchange failed";
					step = "error";
					renderOAuthDialog();
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				step = "error";
				renderOAuthDialog();
			}
		};

		const renderOAuthDialog = () => {
			const content = (() => {
				switch (step) {
					case "loading":
						return html`<p class="text-sm text-muted-foreground">Starting OAuth flow...</p>`;
					case "waiting":
						return html`
							<div class="flex flex-col gap-3">
								<p class="text-sm text-muted-foreground">
									A browser tab has been opened for ${providerName} authentication.
									${callbackServer
										? "This should complete automatically after authorizing. If it does not, paste the full redirect URL or authorization code below."
										: "After authorizing, copy the code and paste it below."}
								</p>
								${instructions ? html`<p class="text-xs text-muted-foreground">${instructions}</p>` : ""}
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Authorization Code</label>
									${Input({
										type: "text",
										placeholder: callbackServer ? "Paste redirect URL or code" : "Paste code here (format: code#state)",
										value: codeValue,
										onInput: (e: Event) => {
											codeValue = (e.target as HTMLInputElement).value;
											renderOAuthDialog();
										},
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleSubmitCode();
											}
										},
									})}
								</div>
								<p class="text-xs text-muted-foreground">
									Didn't open?
									<a href="${authUrl}" target="_blank" class="underline text-foreground">Click here</a>
								</p>
							</div>
						`;
					case "exchanging":
						return html`<p class="text-sm text-muted-foreground">Exchanging code for tokens...</p>`;
					case "done":
						return html`<p class="text-sm text-green-600 dark:text-green-400">Authenticated successfully.</p>`;
					case "error":
						return html`
							<div class="flex flex-col gap-2">
								<error-details .message=${error}></error-details>
								${Button({ variant: "default", size: "sm", onClick: () => { step = "loading"; startFlow(); }, children: "Try again" })}
							</div>
						`;
				}
			})();

			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup(false),
					width: "min(480px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: `${providerName} Login` })}
								<div class="mt-2">${content}</div>
							`,
						})}
						${step === "waiting"
							? DialogFooter({
									className: "px-6 pb-4",
									children: html`
										<div class="flex gap-2 justify-end">
											${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
											${Button({
												variant: "default",
												onClick: handleSubmitCode,
												disabled: !codeValue.trim(),
												children: "Submit",
											})}
										</div>
									`,
								})
							: step === "error"
								? DialogFooter({
										className: "px-6 pb-4",
										children: html`
											<div class="flex gap-2 justify-end">
												${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
											</div>
										`,
									})
								: ""}
					`,
				}),
				container,
			);
		};

		renderOAuthDialog();
		startFlow();
	});
}

// ============================================================================
// GATEWAY DIALOG
// ============================================================================

export function openGatewayDialog(): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let urlValue = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	let tokenValue = localStorage.getItem(GW_TOKEN_KEY) || "";
	let connecting = false;
	let error = "";

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const handleConnect = async () => {
		if (connecting) return;
		connecting = true;
		error = "";
		renderDialog();

		const url = urlValue.trim();
		const token = tokenValue.trim();

		try {
			const { authenticateGateway } = await import("./session-manager.js");
			await authenticateGateway(url, token);
			cleanup();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Auth failures are permanent
			if (msg.includes("Invalid auth token")) {
				error = msg;
				connecting = false;
				renderDialog();
				return;
			}
			// Gateway not ready — poll until it responds
			error = "Waiting for server to start…";
			renderDialog();
			const POLL_INTERVAL = 1500;
			const MAX_WAIT = 60_000;
			const start = Date.now();
			while (Date.now() - start < MAX_WAIT) {
				await new Promise(r => setTimeout(r, POLL_INTERVAL));
				try {
					const { authenticateGateway: auth } = await import("./session-manager.js");
					await auth(url, token);
					cleanup();
					return;
				} catch (retryErr: any) {
					if (retryErr?.message?.includes("Invalid auth token")) {
						error = retryErr.message;
						connecting = false;
						renderDialog();
						return;
					}
				}
			}
			error = "Server did not respond. Check the gateway URL and try again.";
			connecting = false;
			renderDialog();
		}
	};

	const renderDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(),
				width: "min(440px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Connect to Gateway" })}
							<div class="flex flex-col gap-3 mt-2">
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Gateway URL</label>
									${Input({
										type: "text",
										placeholder: "http://localhost:3001",
										value: urlValue,
										onInput: (e: Event) => {
											urlValue = (e.target as HTMLInputElement).value;
										},
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Auth Token</label>
									${Input({
										type: "password",
										placeholder: "Paste token from gateway terminal",
										value: tokenValue,
										onInput: (e: Event) => {
											tokenValue = (e.target as HTMLInputElement).value;
										},
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleConnect();
											}
										},
									})}
								</div>
								${error ? html`<error-details .message=${error}></error-details>` : ""}
								<p class="text-xs text-muted-foreground">
									Start the gateway:
									<code class="px-1 py-0.5 rounded bg-secondary text-secondary-foreground font-mono text-[11px]">npx bobbit</code>
								</p>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-6",
						children: html`
							${Button({ variant: "ghost", onClick: () => cleanup(), children: "Cancel" })}
							${Button({
								variant: "default",
								onClick: handleConnect,
								children: connecting ? "Connecting..." : "Connect",
							})}
						`,
					})}
				`,
			}),
			container,
		);
	};

	renderDialog();
}

// ============================================================================
// QR CODE DIALOG
// ============================================================================

export async function showQrCodeDialog(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	const mobileUrl = `${window.location.origin}?token=${encodeURIComponent(token)}`;
	const caCertUrl = `${window.location.origin}/api/ca-cert`;

	let sessionQr = "";
	let certQr = "";
	let error = "";
	let firstTimeOs: null | "ios" | "android" = null;

	try {
		const { default: QRCode } = await import("qrcode");
		[sessionQr, certQr] = await Promise.all([
			QRCode.toDataURL(mobileUrl, { width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" } }),
			QRCode.toDataURL(caCertUrl, { width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" } }),
		]);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	const renderDialog = () => render(
		Dialog({
			isOpen: true,
			onClose: cleanup,
			width: "min(420px, 92vw)",
			height: "auto",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						${DialogHeader({ title: "Continue on Phone" })}
						<div class="flex flex-col items-center gap-3 mt-3">
							${error
								? html`<error-details .message=${error}></error-details>`
								: firstTimeOs === "ios"
									? html`
											<div class="rounded-lg overflow-hidden bg-white p-2">
												<img src="${certQr}" alt="CA Certificate QR" width="280" height="280" />
											</div>
											<p class="text-xs text-muted-foreground text-center max-w-[300px]">
												Scan with your phone camera and open the link in <strong>Safari</strong>.
											</p>
											<div class="text-xs text-muted-foreground w-full space-y-2 leading-relaxed mt-1">
												<p>Then on your phone:</p>
												<ol class="list-decimal list-inside space-y-1 pl-1">
													<li>Tap <strong>Allow</strong> when prompted to download a profile.</li>
													<li>
														Open <strong>Settings → General → VPN &amp; Device Management</strong>,
														tap <strong>Bobbit Local CA</strong>, then <strong>Install</strong>.
													</li>
													<li>
														Open <strong>Settings → General → About → Certificate Trust Settings</strong>
														and enable full trust for <strong>Bobbit Local CA</strong>.
													</li>
													<li>
														Come back here, collapse this section, scan the session QR, then in Safari tap
														<strong>Share → Add to Home Screen</strong>.
													</li>
												</ol>
											</div>
											<button
												type="button"
												class="w-full text-sm mt-2 border-t border-border pt-3 cursor-pointer text-foreground font-medium text-left hover:text-primary"
												@click=${() => { firstTimeOs = null; renderDialog(); }}
											>
												▴ Hide first-time setup
											</button>
										`
									: firstTimeOs === "android"
										? html`
												<div class="rounded-lg overflow-hidden bg-white p-2">
													<img src="${certQr}" alt="CA Certificate QR" width="280" height="280" />
												</div>
												<p class="text-xs text-muted-foreground text-center max-w-[300px]">
													Scan with your phone camera and download the certificate.
												</p>
												<div class="text-xs text-muted-foreground w-full space-y-2 leading-relaxed mt-1">
													<p>Then on your phone:</p>
													<ol class="list-decimal list-inside space-y-1 pl-1">
														<li>
															Open <strong>Settings → Security &amp; privacy → More security settings →
															Encryption &amp; credentials → Install a certificate → CA certificate</strong>.
															(Menu names vary by vendor — on Pixel it's
															<strong>Security → More security &amp; privacy → Encryption &amp; credentials</strong>.)
														</li>
														<li>Acknowledge the warning, then pick the downloaded <code>bobbit-ca.crt</code>.</li>
														<li>Give it a name (e.g. <strong>Bobbit Local CA</strong>) and confirm.</li>
														<li>
															Come back here, collapse this section, scan the session QR, then in Chrome tap
															the ⋮ menu → <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
														</li>
													</ol>
													<p class="italic">
														Note: user-installed CAs are only trusted by browsers and user apps. System trust requires a rooted device.
													</p>
												</div>
												<button
													type="button"
													class="w-full text-sm mt-2 border-t border-border pt-3 cursor-pointer text-foreground font-medium text-left hover:text-primary"
													@click=${() => { firstTimeOs = null; renderDialog(); }}
												>
													▴ Hide first-time setup
												</button>
											`
										: html`
												<div class="rounded-lg overflow-hidden bg-white p-2">
													<img src="${sessionQr}" alt="Session QR" width="280" height="280" />
												</div>
												<p class="text-xs text-muted-foreground text-center max-w-[260px]">
													Scan with your phone camera to open this session in your mobile browser.
												</p>
												<div class="w-full mt-2 border-t border-border pt-3 flex flex-col">
													<button
														type="button"
														class="text-sm py-1.5 cursor-pointer text-foreground font-medium text-left hover:text-primary"
														@click=${() => { firstTimeOs = "ios"; renderDialog(); }}
													>
														▾ First time on this device? (iPhone / iPad)
													</button>
													<button
														type="button"
														class="text-sm py-1.5 cursor-pointer text-foreground font-medium text-left hover:text-primary"
														@click=${() => { firstTimeOs = "android"; renderDialog(); }}
													>
														▾ First time on this device? (Android)
													</button>
												</div>
											`}
						</div>
					`,
				})}
				${DialogFooter({
					className: "px-6 pb-4",
					children: html`
						<div class="flex gap-2 justify-end">
							${Button({ variant: "ghost", onClick: cleanup, children: "Close" })}
						</div>
					`,
				})}
			`,
		}),
		container,
	);

	renderDialog();
}

// ============================================================================
// RENAME DIALOG
// ============================================================================

export function showRenameDialog(sessionId: string, currentTitle: string): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = currentTitle;
	let generating = false;
	let titleChangeUnsub: (() => void) | null = null;
	let roleDropdownOpen = false;
	let hasFocused = false;
	// Track pending changes — null means "no change from current"
	const session0 = state.gatewaySessions.find((s) => s.id === sessionId);
	const initialRole: string = session0?.role || "";
	const initialColorIndex: number = sessionColorMap.get(sessionId) ?? -1;
	let pendingRole: string | null = null;
	let pendingColorIndex: number | null = null;

	// Load roles for the picker
	import("./api.js").then(({ fetchRoles }) => {
		if (state.roles.length === 0) fetchRoles().then(() => renderDialog());
	});

	const cleanup = () => {
		titleChangeUnsub?.();
		titleChangeUnsub = null;
		render(html``, container);
		container.remove();
	};

	const doSave = async () => {
		// Apply title change
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== currentTitle) {
			updateLocalSessionTitle(sessionId, trimmed);
			if (state.remoteAgent && activeSessionId() === sessionId) {
				state.remoteAgent.setTitle(trimmed);
			} else {
				import("./api.js").then(({ patchSession }) => {
					patchSession(sessionId, { title: trimmed });
				});
				refreshSessions();
			}
		}

		// Apply colour change if pending
		if (pendingColorIndex !== null) {
			setSessionColor(sessionId, pendingColorIndex);
		}

		// Apply role changes (these restart the agent — do last)
		if (pendingRole !== null) {
			saving = true;
			renderDialog();
			try {
				const patchBody: any = { roleId: pendingRole };
				await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify(patchBody),
				});
				await refreshSessions();
			} catch (err) {
				console.error("[assign-role] Failed:", err);
			}
		}

		cleanup();
	};

	let saving = false;

	const doGenerate = async () => {
		if (generating) return;
		generating = true;
		renderDialog();

		const timeoutId = setTimeout(() => {
			if (generating) {
				generating = false;
				titleChangeUnsub?.();
				titleChangeUnsub = null;
				renderDialog();
			}
		}, 30_000);

		// Live path: use the WS so we get the same streaming UX. Otherwise call REST.
		if (state.remoteAgent && activeSessionId() === sessionId) {
			titleChangeUnsub?.();
			const prevOnTitle = state.remoteAgent.onTitleChange;
			state.remoteAgent.onTitleChange = (newTitle: string) => {
				if (state.remoteAgent) state.remoteAgent.onTitleChange = prevOnTitle;
				titleChangeUnsub = null;
				clearTimeout(timeoutId);
				titleValue = newTitle;
				generating = false;
				renderDialog();
				prevOnTitle?.(newTitle);
			};
			titleChangeUnsub = () => {
				if (state.remoteAgent) state.remoteAgent.onTitleChange = prevOnTitle;
			};
			state.remoteAgent.generateTitle();
			return;
		}

		// Non-active session: REST endpoint reads .jsonl / live messages server-side.
		try {
			const res = await gatewayFetch(`/api/sessions/${sessionId}/generate-title`, { method: "POST" });
			if (res.ok) {
				const body = await res.json().catch(() => null) as { title?: string } | null;
				if (body?.title) {
					titleValue = body.title;
					updateLocalSessionTitle(sessionId, body.title);
					refreshSessions();
				}
			} else {
				console.error("[generate-title] failed:", res.status, await res.text().catch(() => ""));
			}
		} catch (err) {
			console.error("[generate-title] error:", err);
		} finally {
			clearTimeout(timeoutId);
			generating = false;
			renderDialog();
		}
	};

	const selectRole = (roleName: string) => {
		pendingRole = roleName === initialRole ? null : roleName;
		roleDropdownOpen = false;
		renderDialog();
	};

	const renderDialog = () => {
		const session = state.gatewaySessions.find((s) => s.id === sessionId);

		// Use pending role for display if set, otherwise current session role
		const displayRole = pendingRole !== null ? pendingRole : (session?.role || "");
		const displayRoleObj = state.roles.find((r) => r.name === displayRole);
		const displayAccessory = displayRoleObj?.accessory
			?? (displayRole === "team-lead" ? "crown" : displayRole === "coder" ? "bandana" : "none");
		const acc = getAccessory(displayAccessory);
		const hasAccessory = acc.id !== "none" && acc.shadow !== "";

		// Split 14 colours into 2 equal rows of 7
		const ROW_SIZE = Math.ceil(BOBBIT_HUE_ROTATIONS.length / 2);

		const roleLabel = session?.assistantType === "goal" ? "Goal Assistant" : displayRoleObj?.label || displayRole || "None";
		const hasRoleChange = pendingRole !== null;
		const hasColorChange = pendingColorIndex !== null;
		const hasTitleChange = titleValue.trim() !== "" && titleValue.trim() !== currentTitle;
		const hasAnyChange = hasTitleChange || hasColorChange || hasRoleChange;
		const saveLabel = saving ? "Saving…" : hasRoleChange ? "Save & Restart" : "Save";
		const displayColorIndex = pendingColorIndex !== null ? pendingColorIndex : initialColorIndex;

		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(420px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Edit Session" })}
							<div class="mt-4 flex flex-col gap-4">
								<!-- Title -->
								<div>
									<div class="text-xs text-muted-foreground mb-1.5">Title</div>
									<div class="flex items-center gap-2">
										<div class="flex-1">
											${Input({
												value: titleValue,
												placeholder: "Session title…",
												onInput: (e: Event) => {
													titleValue = (e.target as HTMLInputElement).value;
													renderDialog();
												},
												onKeyDown: (e: KeyboardEvent) => {
													if (e.key === "Enter") doSave();
													if (e.key === "Escape") cleanup();
												},
											})}
										</div>
										${session?.assistantType === "goal"
											? ""
											: html`<button
													class="shrink-0 p-2 rounded-md border border-border hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
													@click=${doGenerate}
													?disabled=${generating}
													title="Auto-generate title from chat history"
												>
													${generating
														? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
																<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
															</svg>`
														: icon(WandSparkles, "sm")}
												</button>`}
									</div>
								</div>
								<!-- Colour picker -->
								<div>
									<div class="text-xs text-muted-foreground mb-2">Colour</div>
									<div class="flex flex-col gap-2">
										${[0, ROW_SIZE].map((start) => html`
											<div class="flex gap-2 justify-center">
												${BOBBIT_HUE_ROTATIONS.slice(start, start + ROW_SIZE).map((rot, j) => {
													const i = start + j;
													const isSelected = displayColorIndex === i;
													const accShadow = hasAccessory ? acc.shadow : "";
													// Counter-rotate accessory to cancel parent's hue-rotate (except flask which intentionally shifts)
													const accCounterFilter = acc.id !== "flask" ? `filter:hue-rotate(${-rot}deg);` : "";
													return html`
														<button
															class="relative transition-all rounded-lg flex items-center justify-center
																${isSelected
																	? "ring-2 ring-primary ring-offset-1 ring-offset-background"
																	: "hover:bg-secondary/50"}"
															style="width:${hasAccessory ? 34 : 28}px;height:24px;"
															title="Colour ${i + 1}"
															@click=${() => { pendingColorIndex = i === initialColorIndex ? null : i; renderDialog(); }}
														>
															<!-- Wrapper applies hue-rotate to both bobbit + accessory; accessory counter-rotates inside -->
															<span style="position:absolute;left:${hasAccessory ? 3 : 4}px;top:3px;filter:hue-rotate(${rot}deg);">
																<span style="position:absolute;left:0;top:0;display:block;width:1px;height:1px;image-rendering:pixelated;transform:scale(2);transform-origin:0 0;box-shadow:3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,2px 1px 0 #000,3px 1px 0 #8ec63f,4px 1px 0 #8ec63f,5px 1px 0 #8ec63f,6px 1px 0 #b5d98a,7px 1px 0 #b5d98a,8px 1px 0 #000,1px 2px 0 #000,2px 2px 0 #8ec63f,3px 2px 0 #8ec63f,4px 2px 0 #8ec63f,5px 2px 0 #8ec63f,6px 2px 0 #8ec63f,7px 2px 0 #b5d98a,8px 2px 0 #8ec63f,9px 2px 0 #000,0px 3px 0 #000,1px 3px 0 #8ec63f,2px 3px 0 #8ec63f,3px 3px 0 #8ec63f,4px 3px 0 #8ec63f,5px 3px 0 #8ec63f,6px 3px 0 #8ec63f,7px 3px 0 #8ec63f,8px 3px 0 #8ec63f,9px 3px 0 #000,0px 4px 0 #000,1px 4px 0 #8ec63f,2px 4px 0 #8ec63f,3px 4px 0 #1a3010,4px 4px 0 #8ec63f,5px 4px 0 #8ec63f,6px 4px 0 #1a3010,7px 4px 0 #8ec63f,8px 4px 0 #8ec63f,9px 4px 0 #000,0px 5px 0 #000,1px 5px 0 #8ec63f,2px 5px 0 #8ec63f,3px 5px 0 #1a3010,4px 5px 0 #8ec63f,5px 5px 0 #8ec63f,6px 5px 0 #1a3010,7px 5px 0 #8ec63f,8px 5px 0 #8ec63f,9px 5px 0 #000,0px 6px 0 #000,1px 6px 0 #6b9930,2px 6px 0 #8ec63f,3px 6px 0 #8ec63f,4px 6px 0 #8ec63f,5px 6px 0 #8ec63f,6px 6px 0 #8ec63f,7px 6px 0 #8ec63f,8px 6px 0 #8ec63f,9px 6px 0 #000,1px 7px 0 #000,2px 7px 0 #6b9930,3px 7px 0 #8ec63f,4px 7px 0 #8ec63f,5px 7px 0 #8ec63f,6px 7px 0 #8ec63f,7px 7px 0 #8ec63f,8px 7px 0 #000,2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000;"></span>
																${hasAccessory ? html`<span style="position:absolute;left:0;top:0;display:block;width:1px;height:1px;image-rendering:pixelated;transform:scale(2);transform-origin:0 0;box-shadow:${accShadow};${accCounterFilter}"></span>` : ""}
															</span>
														</button>
													`;
												})}
											</div>
										`)}
									</div>
								</div>
								<!-- Role picker -->
								<div>
									<div class="text-xs text-muted-foreground mb-1.5">Role</div>
									${session?.assistantType === "goal"
										? html`<div class="text-sm text-foreground/80 px-3 py-1.5 rounded-md bg-secondary/50">Goal Assistant</div>`
										: html`
											<div class="relative" id="role-picker-container">
												<button
													class="w-full text-left px-3 py-2 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-2.5"
													@click=${(e: Event) => { e.stopPropagation(); roleDropdownOpen = !roleDropdownOpen; renderDialog(); }}
													title="Select role"
												>
													<span class="shrink-0">${statusBobbit("idle", false, sessionId, false, false, false, false, displayAccessory, true)}</span>
													<span class="flex-1 ${displayRole ? "text-foreground" : "text-muted-foreground"}">${roleLabel}</span>
													${hasRoleChange ? html`<span class="text-[10px] text-primary font-medium px-1.5 py-0.5 rounded bg-primary/10">changed</span>` : ""}
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground transition-transform ${roleDropdownOpen ? "rotate-180" : ""}"><path d="m6 9 6 6 6-6"/></svg>
												</button>
												${roleDropdownOpen ? html`
													<div class="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 max-h-[240px] overflow-y-auto">
														<button
															class="w-full text-left px-3 py-2 text-sm text-popover-foreground/60 hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2.5 ${!displayRole ? "bg-accent/50" : ""}"
															@click=${(e: Event) => { e.stopPropagation(); selectRole(""); }}
															title="Remove role"
														>
															<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, "none", true)}</span>
															<span>None</span>
														</button>
														${state.roles.map((role) => html`
															<button
																class="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2.5 ${displayRole === role.name ? "bg-accent/50" : ""}"
																@click=${(e: Event) => { e.stopPropagation(); selectRole(role.name); }}
																title="Assign ${role.label} role"
															>
																<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
																<span>${role.label}</span>
															</button>
														`)}
													</div>
												` : ""}
											</div>
										`}
								</div>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									onClick: doSave,
									disabled: saving || !hasAnyChange,
									children: saveLabel,
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);

		if (!hasFocused) {
			hasFocused = true;
			requestAnimationFrame(() => {
				const input = container.querySelector("input");
				if (input) {
					input.focus();
					// Place caret at end — don't pre-select text. Highlighting on open
					// is jarring and the selection contrast is poor against the input bg.
					const end = input.value.length;
					try { input.setSelectionRange(end, end); } catch { /* non-text input */ }
				}
			});
		}

		// Close role dropdown on click outside
		if (roleDropdownOpen) {
			const closeDropdown = (e: MouseEvent) => {
				const picker = container.querySelector("#role-picker-container");
				if (picker && !picker.contains(e.target as Node)) {
					roleDropdownOpen = false;
					renderDialog();
				}
				document.removeEventListener("click", closeDropdown, true);
			};
			// Defer so the current click doesn't immediately close it
			requestAnimationFrame(() => {
				document.addEventListener("click", closeDropdown, true);
			});
		}
	};

	renderDialog();
}

// ============================================================================
// GOAL DIALOGS
// ============================================================================

export function showGoalDialog(existingGoal?: Goal, projectId?: string): void {
	if (existingGoal) {
		showGoalEditDialog(existingGoal);
	} else {
		createGoalAssistantSession(projectId);
	}
}

async function createGoalAssistantSession(projectId?: string): Promise<void> {
	// Invariant: goal creation must name an explicit registered project.
	// Post-refactor (eliminate default project, §5.2), every caller goes
	// through `startNewGoalFlow()` or passes an explicit projectId.
	if (!projectId) {
		const msg = "showGoalDialog() called without projectId for goal creation — callers must go through startNewGoalFlow() or pass an explicit projectId.";
		// Hard-fail in dev so the misuse is impossible to miss; soft-fail in
		// production. Read DEV from globalThis (set via Vite's `define`) rather
		// than `import.meta.env` so esbuild iife test-fixture bundles don't trip
		// the empty-import-meta warning.
		if ((globalThis as any).__BOBBIT_DEV__) throw new Error(msg);
		console.error(msg);
		return;
	}
	if (!state.projects.find(p => p.id === projectId)) {
		console.error(`showGoalDialog: projectId ${projectId} not in state.projects`);
		return;
	}
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const bodyObj: Record<string, any> = { assistantType: "goal" };
		if (projectId) {
			bodyObj.projectId = projectId;
			const project = state.projects.find(p => p.id === projectId);
			if (project) bodyObj.cwd = project.rootPath;
		}
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(bodyObj),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		// Pre-fill project context in state so the preview panel picks it up
		if (projectId) {
			const project = state.projects.find(p => p.id === projectId);
			state.previewProjectId = projectId;
			if (project && !state.previewCwdEdited) state.previewCwd = project.rootPath;
		}
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { assistantType: "goal" });
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create goal assistant", message, { code, stack });
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

function showGoalEditDialog(existingGoal: Goal): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = existingGoal.title;
	let cwdValue = existingGoal.cwd;
	let specValue = existingGoal.spec;
	let stateValue: GoalState = existingGoal.state;
	let saving = false;

	let cwdDropdownOpenEdit = false;
	let cwdHighlightIndexEdit = -1;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doSave = async () => {
		const trimmedTitle = titleValue.trim();
		if (!trimmedTitle) return;
		saving = true;
		renderDialog();

		await updateGoal(existingGoal.id, {
			title: trimmedTitle,
			cwd: cwdValue.trim() || undefined,
			state: stateValue,
			spec: specValue,
			team: true,
		});
		saving = false;
		cleanup();
	};

	const renderDialog = () => {
		const stateOptions = (["todo", "in-progress", "complete", "shelved"] as GoalState[]).map(
			(s) => ({ value: s, label: GOAL_STATE_LABELS[s] }),
		);

		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(540px, 92vw)",
				height: "auto",
				className: "max-h-[90vh]",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						className: "overflow-y-auto",
						children: html`
							${DialogHeader({ title: "Edit Goal" })}
							<div class="mt-4 flex flex-col gap-4">
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Title</label>
									${Input({
										type: "text",
										value: titleValue,
										onInput: (e: Event) => { titleValue = (e.target as HTMLInputElement).value; renderDialog(); },
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSave(); }
											if (e.key === "Escape") cleanup();
										},
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Working Directory</label>
									${cwdCombobox({
										value: cwdValue,
										placeholder: "/path/to/project",
										onInput: (v) => { cwdValue = v; renderDialog(); },
										onSelect: (v) => { cwdValue = v; renderDialog(); },
										dropdownOpen: cwdDropdownOpenEdit,
										onToggle: (open) => { cwdDropdownOpenEdit = open; renderDialog(); },
										highlightedIndex: cwdHighlightIndexEdit,
										onHighlight: (i) => { cwdHighlightIndexEdit = i; },
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">State</label>
									<div class="flex gap-1.5">
										${stateOptions.map((opt) => html`
											<button
												class="px-3 py-1.5 text-xs rounded-md border transition-colors
													${stateValue === opt.value
														? "border-primary bg-primary/10 text-primary font-medium"
														: "border-border text-muted-foreground hover:bg-secondary"}"
												@click=${() => { stateValue = opt.value as GoalState; renderDialog(); }}
												title="Set state to ${opt.label}"
											>${opt.label}</button>
										`)}
									</div>
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Goal Spec (Markdown)</label>
									<textarea
										class="w-full min-h-[120px] max-h-[300px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
										placeholder="Describe the goal, acceptance criteria, constraints..."
										.value=${specValue}
										@input=${(e: Event) => { specValue = (e.target as HTMLTextAreaElement).value; }}
									></textarea>
									<p class="text-[10px] text-muted-foreground mt-1">Injected into the context window of all sessions under this goal.</p>
								</div>
	
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: doSave,
									disabled: !titleValue.trim() || saving,
									children: saving ? "Saving…" : "Save",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);

		requestAnimationFrame(() => {
			const input = container.querySelector("input");
			if (input) { input.focus(); input.select(); }
		});
	};

	renderDialog();
}

// ============================================================================
// PROJECT REGISTRATION DIALOG
// ============================================================================

export async function createProjectAssistantSession(
	dirPath: string,
	scaffolding: boolean,
	opts?: {
		projectId?: string;
		existingProjectName?: string;
		/**
		 * User-confirmed initial repo/subdirectory selection from the Add
		 * Project scan checklist. Forwarded to the project-assistant's first
		 * turn via `connectToSession`'s `projectInitialScanContext` option so
		 * the assistant treats the selected ids as authoritative starting
		 * candidates for `propose_project.components`. Only meaningful when
		 * `scaffolding === false` (new-project registration); ignored
		 * otherwise. See `src/app/project-assistant-autoprompt.ts`.
		 */
		initialScanContext?: import("./project-assistant-autoprompt.js").ProjectAssistantScanContext;
	},
): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const bodyObj: Record<string, any> = {
			assistantType: scaffolding ? "project-scaffolding" : "project",
			cwd: dirPath,
		};
		// When attaching to an existing registered project, pass the projectId
		// so the server doesn't spin up a new provisional project at the same
		// rootPath (which would surface as a duplicate in the sidebar).
		if (opts?.projectId) bodyObj.projectId = opts.projectId;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(bodyObj),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		// Refresh projects so the sidebar sees the newly-created provisional project
		// before connectToSession renders. Without this, the session falls into the
		// default project bucket because state.projects doesn't contain the new ID yet.
		const { fetchProjects } = await import("./api.js");
		const { setProjects } = await import("./state.js");
		setProjects(await fetchProjects());
		const { connectToSession } = await import("./session-manager.js");
		const actualType = scaffolding ? "project-scaffolding" : "project";
		// Edit-mode is signalled solely by `projectId` (an already-registered
		// project). `existingProjectName` is only a display hint; if it's empty we
		// fall back to the project's id so the prompt still routes to the edit
		// branch (otherwise the assistant would re-run new-project discovery on
		// an already-registered project).
		const projectEditContext = opts?.projectId
			? { name: opts.existingProjectName || opts.projectId, rootPath: dirPath }
			: undefined;
		// Forward the optional user-confirmed initial scan subset to the
		// project-assistant's first turn. Only applies to new-project
		// registration (not scaffolding, not edit-mode) — the Add Project
		// scan checklist is the only caller that supplies it.
		const projectInitialScanContext =
			!scaffolding && !opts?.projectId ? opts?.initialScanContext : undefined;
		await connectToSession(id, false, {
			assistantType: actualType,
			projectDirPath: dirPath,
			projectEditContext,
			projectInitialScanContext,
		});
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create project assistant", message, { code, stack });
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// PROJECT REGISTRATION DIALOG
// ----------------------------------------------------------------------------
// Add Project dialog. Design source of truth: `design-doc` gate on the goal.
// Key invariants:
//   - Reusable `<directory-picker>` element (typeahead + browse trigger) for
//     the path input. Suggestions are absolutely-positioned by the picker so
//     the surrounding layout (in particular the footer) never shifts.
//   - Dedicated browse modal (`openProjectBrowseDialog`) opens on top of the
//     Add Project dialog when the user clicks Browse — the parent dialog
//     stays mounted with its footer in place.
//   - Fixed dialog shell (`min(720px, 94vw)` x `min(720px, 92vh)`) with
//     sticky header, scrollable body, and persistent footer. The footer
//     container is identical across all states (path/scan + loading + error)
//     so its bounding box is invariant. Pinned by
//     `tests/e2e/ui/add-project-footer-stability.spec.ts`.
//   - Scan checklist surfaces every detected repo *and* monorepo workspace
//     candidate as a normalized `ProjectScanItem` and forwards the
//     user-confirmed subset into the project-assistant's first turn via
//     `createProjectAssistantSession({ initialScanContext })`.
// ============================================================================

/**
 * Normalize the `scanProject` payload into a flat `ProjectScanItem[]` for the
 * scan checklist. Mirrors the spec in `project-assistant-autoprompt.ts`:
 *
 *   - One item per `repos[]` entry (`id = "repo:<folder>"`).
 *   - One item per `monorepo.candidates[]` entry (`id = "workspace:<rel>"`).
 *   - Fallback single-component candidate (`id = "repo:."`, label "(root)")
 *     when both arrays are empty, so the legacy single-repo path still
 *     routes through the assistant with a non-empty `selectedIds`.
 *
 * `absolutePath` is the on-disk path of the item; `joinPath` picks the
 * separator from the root so Windows roots stay Windows-y.
 */
function joinScanPath(root: string, rel: string): string {
	if (!rel || rel === ".") return root;
	const looksWindows = /^[A-Za-z]:[\\/]/.test(root) || (root.includes("\\") && !root.startsWith("/"));
	const sep = looksWindows ? "\\" : "/";
	const trimmedRoot = root.replace(/[\\/]+$/, "");
	const trimmedRel = rel.replace(/^[\\/]+/, "");
	return `${trimmedRoot}${sep}${trimmedRel}`;
}

function buildScanItems(
	rootPath: string,
	scan: { repos: DetectedRepo[]; monorepo?: MonorepoScanResult },
): ProjectScanItem[] {
	const out: ProjectScanItem[] = [];
	const repos = Array.isArray(scan.repos) ? scan.repos : [];
	for (const r of repos) {
		if (!r || typeof r.folder !== "string") continue;
		out.push({
			id: `repo:${r.folder}`,
			kind: "repo",
			label: r.folder === "." ? "(root)" : r.folder,
			repo: r.folder,
			absolutePath: joinScanPath(rootPath, r.folder),
			hasGit: !!r.hasGit,
			detectedCommands: { ...(r.detectedCommands || {}) },
		});
	}
	const candidates = scan.monorepo?.candidates ?? [];
	for (const w of candidates) {
		if (!w || typeof w.relativePath !== "string") continue;
		const wAny = w as unknown as { detectedCommands?: Record<string, string> };
		out.push({
			id: `workspace:${w.relativePath}`,
			kind: "workspace",
			label: w.relativePath,
			repo: ".",
			relativePath: w.relativePath,
			absolutePath: joinScanPath(rootPath, w.relativePath),
			hasGit: false,
			// MonorepoCandidate has no detectedCommands on the wire today; the
			// autoprompt helper only requires the field to be present.
			detectedCommands: wAny.detectedCommands ? { ...wAny.detectedCommands } : {},
		});
	}
	if (out.length === 0) {
		out.push({
			id: "repo:.",
			kind: "repo",
			label: "(root)",
			repo: ".",
			absolutePath: rootPath,
			hasGit: false,
			detectedCommands: {},
		});
	}
	return out;
}

/**
 * Standalone browse modal. Opens on top of the Add Project dialog when the
 * user clicks the picker's Browse button. Resolves with the selected absolute
 * path or `null` on cancel. Mirrors the legacy in-dialog browser semantics
 * (directory-only entries; skips hidden / `node_modules` / symlinks — that
 * filtering is done server-side by `/api/browse-directory`), but in a
 * dedicated overlay so the parent dialog's footer stays put.
 */
function openProjectBrowseDialog(initialPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let current = "";
		let parent: string | null = null;
		let entries: Array<{ name: string; path: string }> = [];
		let truncated = false;
		let loading = true;
		let errorMessage = "";
		let highlight = -1;

		const close = (result: string | null) => {
			document.removeEventListener("keydown", onKeyDown);
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const navigate = async (dirPath: string | undefined) => {
			loading = true;
			errorMessage = "";
			renderDialog();
			try {
				const { browseDirectory } = await import("./api.js");
				const result = await browseDirectory(dirPath) as DirectoryBrowseResult & { truncated?: boolean };
				current = result.current;
				parent = result.parent;
				entries = result.entries ?? [];
				truncated = !!result.truncated;
				highlight = entries.length > 0 ? 0 : -1;
			} catch (err) {
				errorMessage = err instanceof Error ? err.message : String(err);
				// Keep `current` so the user can still hit Select if they had a
				// valid path before the error.
			} finally {
				loading = false;
				renderDialog();
			}
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				close(null);
				return;
			}
			if (e.key === "ArrowDown") {
				if (entries.length === 0) return;
				e.preventDefault();
				highlight = highlight < 0 ? 0 : (highlight + 1) % entries.length;
				renderDialog();
				return;
			}
			if (e.key === "ArrowUp") {
				if (entries.length === 0) return;
				e.preventDefault();
				highlight = highlight <= 0 ? entries.length - 1 : highlight - 1;
				renderDialog();
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				if (highlight >= 0 && highlight < entries.length) {
					const target = entries[highlight];
					if (target) void navigate(target.path);
				} else if (current) {
					close(current);
				}
				return;
			}
		};

		const renderDialog = () => {
			render(
				Dialog({
					isOpen: true,
					onClose: () => close(null),
					width: "min(640px, 92vw)",
					height: "min(560px, 88vh)",
					backdropClassName: "bg-black/60 backdrop-blur-sm",
					children: html`
						<div class="flex flex-col h-full" data-testid="add-project-browse-dialog">
							<div class="shrink-0 px-6 pt-6 pb-2">
								${DialogHeader({ title: "Browse for directory" })}
								<div class="flex items-center gap-2 mt-3 min-h-[28px]">
									<button
										type="button"
										class="px-2 py-1 text-xs rounded border border-border text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
										?disabled=${parent == null || loading}
										@click=${() => parent != null && void navigate(parent)}
										data-testid="add-project-browse-up"
									>Up</button>
									<span
										class="text-xs text-muted-foreground flex-1 min-w-0 truncate font-mono"
										title=${current}
										data-testid="add-project-browse-current"
									>${current || "Loading…"}</span>
								</div>
							</div>
							<div class="flex-1 min-h-0 px-6 overflow-hidden flex flex-col gap-2">
								<div class="text-[11px] min-h-[16px] ${errorMessage ? "text-red-500" : "text-muted-foreground"}" data-testid="add-project-browse-status">
									${loading
										? "Loading…"
										: errorMessage
											? `Error: ${errorMessage}`
											: entries.length === 0
												? "No subdirectories."
												: truncated
													? `Showing first ${entries.length} directories.`
													: ""}
								</div>
								<div class="flex-1 min-h-0 overflow-y-auto border border-border rounded" data-testid="add-project-browse-list">
									${entries.length === 0 && !loading && !errorMessage
										? html`<div class="px-3 py-2 text-xs text-muted-foreground">No subdirectories</div>`
										: entries.map((entry, idx) => {
											const active = idx === highlight;
											const rowClass = active
												? "bg-accent text-accent-foreground"
												: "text-foreground hover:bg-secondary/50";
											return html`
												<button
													type="button"
													class="w-full text-left px-3 py-1.5 text-sm transition-colors flex items-center gap-2 border-b border-border last:border-0 ${rowClass}"
													data-testid="add-project-browse-entry"
													data-path=${entry.path}
													@click=${() => void navigate(entry.path)}
													@mouseenter=${() => { highlight = idx; renderDialog(); }}
												>
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
													<span class="truncate">${entry.name}</span>
												</button>
											`;
										})}
								</div>
							</div>
							<div class="shrink-0 px-6 py-4 border-t border-border" data-testid="add-project-browse-footer">
								<div class="flex gap-2 justify-end">
									${Button({ variant: "ghost", onClick: () => close(null), children: "Cancel" })}
									${Button({
										variant: "default",
										onClick: () => close(current || null),
										disabled: !current || loading,
										children: "Select current",
									})}
								</div>
							</div>
						</div>
					`,
				}),
				container,
			);
		};

		document.addEventListener("keydown", onKeyDown);
		renderDialog();
		void navigate(initialPath?.trim() || undefined);
	});
}

/**
 * Add Project dialog — see header comment above for design rationale.
 * Single entry point invoked from `src/app/dialogs-lazy.ts::showProjectDialog`.
 */
export function showProjectDialog(): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	type Step = "path" | "scan";
	let step: Step = "path";
	let pathValue = "";

	let detectionResult: { exists: boolean; hasBobbit: boolean; isEmpty: boolean; name: string } | null = null;
	let detectionToken = 0;

	let preflightReport: PreflightReport | null = null;
	let preflightLoading = false;
	let preflightError = "";
	let preflightToken = 0;
	let preflightUnavailable = false;
	let archiving = false;

	let scanItems: ProjectScanItem[] = [];
	let scanSelection = new Set<string>();

	let busy = false;
	let errorMessage: string | null = null;
	let detectDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Single picker instance reused across renders so its internal state
	// (focus, suggestion list, etc.) is preserved.
	const pickerEl = document.createElement("directory-picker") as DirectoryPickerEl;
	pickerEl.placeholder = "/path/to/project";
	pickerEl.setAttribute("data-testid", "add-project-picker");

	const recentPaths = (): Array<{ path: string; source: string }> => {
		const seen = new Set<string>();
		const out: Array<{ path: string; source: string }> = [];
		for (const p of state.projects ?? []) {
			if (!p?.rootPath || seen.has(p.rootPath)) continue;
			seen.add(p.rootPath);
			out.push({ path: p.rootPath, source: "registered" });
		}
		return out;
	};

	const cleanup = () => {
		if (detectDebounceTimer) {
			clearTimeout(detectDebounceTimer);
			detectDebounceTimer = null;
		}
		render(html``, container);
		container.remove();
	};

	const runDetection = async (dirPath: string) => {
		const trimmed = dirPath.trim();
		if (!trimmed) {
			detectionResult = null;
			renderDialog();
			return;
		}
		const token = ++detectionToken;
		try {
			const { detectProject } = await import("./api.js");
			const result = await detectProject(trimmed);
			if (token !== detectionToken) return;
			detectionResult = result;
		} catch {
			if (token !== detectionToken) return;
			detectionResult = null;
		}
		renderDialog();
	};

	const runPreflight = async (dirPath: string) => {
		const trimmed = dirPath.trim();
		if (!trimmed) {
			preflightReport = null;
			preflightLoading = false;
			preflightError = "";
			renderDialog();
			return;
		}
		if (preflightUnavailable) return;
		const token = ++preflightToken;
		preflightLoading = true;
		preflightError = "";
		renderDialog();
		try {
			const res = await gatewayFetch(`/api/projects/preflight?path=${encodeURIComponent(trimmed)}`);
			if (token !== preflightToken) return;
			if (res.status === 404) {
				console.warn("[preflight] endpoint unavailable — hiding panel");
				preflightUnavailable = true;
				preflightReport = null;
				preflightLoading = false;
				renderDialog();
				return;
			}
			if (!res.ok) {
				preflightError = `Preflight failed (${res.status})`;
				preflightReport = null;
			} else {
				preflightReport = (await res.json()) as PreflightReport;
			}
		} catch (err) {
			if (token !== preflightToken) return;
			preflightError = err instanceof Error ? err.message : String(err);
			preflightReport = null;
		} finally {
			if (token === preflightToken) {
				preflightLoading = false;
				renderDialog();
			}
		}
	};

	const onEffectivePathChange = (next: string, immediate: boolean): void => {
		pathValue = next;
		// Any path change drops us back to the path step and clears scan state.
		if (step !== "path") {
			step = "path";
			scanItems = [];
			scanSelection = new Set();
		}
		errorMessage = null;
		// Bump tokens immediately so stale in-flight responses for the previous
		// path can't overwrite the new path's state.
		detectionToken++;
		preflightToken++;
		if (detectDebounceTimer) {
			clearTimeout(detectDebounceTimer);
			detectDebounceTimer = null;
		}
		if (!next.trim()) {
			detectionResult = null;
			preflightReport = null;
			preflightLoading = false;
			preflightError = "";
			renderDialog();
			return;
		}
		const run = () => {
			void runDetection(pathValue);
			void runPreflight(pathValue);
		};
		if (immediate) {
			run();
		} else {
			detectDebounceTimer = setTimeout(run, 350);
		}
		renderDialog();
	};

	pickerEl.addEventListener("directory-input", (e: Event) => {
		const detail = (e as CustomEvent<DirectoryPickerPathDetail>).detail;
		onEffectivePathChange(detail.path, false);
	});
	pickerEl.addEventListener("directory-select", (e: Event) => {
		const detail = (e as CustomEvent<DirectoryPickerPathDetail>).detail;
		onEffectivePathChange(detail.path, true);
	});
	pickerEl.addEventListener("directory-commit", () => {
		// Enter with no highlighted suggestion → treat as Continue.
		void doContinue();
	});
	pickerEl.addEventListener("directory-browse-request", () => {
		void openBrowseModal();
	});
	pickerEl.addEventListener("directory-cancel", () => {
		cleanup();
	});

	const openBrowseModal = async () => {
		const selected = await openProjectBrowseDialog(pathValue);
		if (selected != null) {
			pickerEl.value = selected;
			onEffectivePathChange(selected, true);
		}
		// Focus returns to the picker regardless of outcome.
		pickerEl.focusInput();
	};

	const openArchiveConfirm = async () => {
		if (!preflightReport) return;
		const rootPath = preflightReport.rootPath;
		const gatewayOwned = preflightReport.checks.some(
			(c) => c.id === "bobbit.gateway-owned" && c.level !== "pass",
		);
		const existingDetail = preflightReport.checks.find((c) => c.id === "bobbit.existing")?.detail || "";
		const confirmed = await promptArchiveConfirm({ rootPath, gatewayOwned, existingDetail });
		if (!confirmed) return;
		archiving = true;
		renderDialog();
		try {
			const res = await gatewayFetch("/api/projects/archive-bobbit", {
				method: "POST",
				body: JSON.stringify({ rootPath }),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as any;
				showConnectionError(
					"Failed to archive .bobbit/",
					data?.error || `Failed: ${res.status}`,
					{ code: data?.code, stack: data?.stack },
				);
			}
		} catch (err) {
			const { message, code, stack } = errorDetails(err);
			showConnectionError("Failed to archive .bobbit/", message, { code, stack });
		} finally {
			archiving = false;
			void runDetection(pathValue);
			void runPreflight(pathValue);
		}
	};

	const doContinue = async () => {
		if (busy) return;
		const trimmed = pathValue.trim();
		if (!trimmed) return;
		if (step === "scan") {
			void confirmScanAndContinue();
			return;
		}
		// Block when preflight reports a hard fail (matches legacy behavior).
		if (preflightReport?.hasFail) return;
		busy = true;
		errorMessage = null;
		renderDialog();
		try {
			const { detectProject, registerProject, fetchProjects, scanProject } = await import("./api.js");
			const detection = await detectProject(trimmed);

			if (detection.hasBobbit) {
				// Auto-import existing project.
				try {
					const project = await registerProject(detection.name, trimmed, undefined);
					if (project) {
						setProjects(await fetchProjects());
						renderApp();
						cleanup();
					} else {
						busy = false;
						renderDialog();
					}
				} catch (e) {
					if (e instanceof SymlinkRootError) {
						await promptSymlinkConfirm(
							detection.name,
							trimmed,
							e.canonical,
							async (canonical) => {
								try {
									const p2 = await registerProject(
										detection.name,
										canonical,
										undefined,
										false,
										true,
									);
									if (p2) {
										setProjects(await fetchProjects());
										renderApp();
										cleanup();
									} else {
										busy = false;
										renderDialog();
									}
								} catch (err2) {
									const { message, code, stack } = errorDetails(err2);
									showConnectionError("Failed to register project", message, { code, stack });
									busy = false;
									renderDialog();
								}
							},
							() => {
								busy = false;
								errorMessage = null;
								renderDialog();
							},
						);
						return;
					}
					throw e;
				}
				return;
			}

			const scaffolding = !(detection.exists && !detection.isEmpty);
			if (scaffolding) {
				// Empty / new directory → scaffolding mode, no scan checklist.
				cleanup();
				await createProjectAssistantSession(trimmed, true);
				return;
			}

			// Non-bobbit, non-empty: scan to surface repo/subdirectory candidates.
			let scan: { repos: DetectedRepo[]; monorepo?: MonorepoScanResult } = { repos: [], monorepo: undefined };
			try {
				scan = await scanProject(trimmed);
			} catch {
				// Scan failure is non-fatal — fall back to a single-component item.
				scan = { repos: [], monorepo: undefined };
			}
			const items = buildScanItems(trimmed, scan);
			if (items.length <= 1) {
				const initialScanContext: ProjectAssistantScanContext | undefined =
					items.length === 1 && items[0]
						? { rootPath: trimmed, items, selectedIds: [items[0].id] }
						: undefined;
				cleanup();
				await createProjectAssistantSession(trimmed, false, { initialScanContext });
				return;
			}
			scanItems = items;
			scanSelection = new Set(items.map((it) => it.id));
			step = "scan";
			busy = false;
			renderDialog();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			busy = false;
			renderDialog();
		}
	};

	const confirmScanAndContinue = async () => {
		if (busy) return;
		const trimmed = pathValue.trim();
		if (!trimmed) return;
		if (scanSelection.size === 0) return;
		const initialScanContext: ProjectAssistantScanContext = {
			rootPath: trimmed,
			items: scanItems,
			selectedIds: scanItems.filter((it) => scanSelection.has(it.id)).map((it) => it.id),
		};
		busy = true;
		renderDialog();
		cleanup();
		await createProjectAssistantSession(trimmed, false, { initialScanContext });
	};

	const goBackToPath = () => {
		if (busy) return;
		step = "path";
		scanItems = [];
		scanSelection = new Set();
		renderDialog();
		pickerEl.focusInput();
	};

	const toggleScanItem = (id: string, checked: boolean) => {
		if (checked) scanSelection.add(id);
		else scanSelection.delete(id);
		renderDialog();
	};

	const selectAll = () => {
		scanSelection = new Set(scanItems.map((it) => it.id));
		renderDialog();
	};
	const deselectAll = () => {
		scanSelection = new Set();
		renderDialog();
	};

	// --- detection-status one-liner (reserved height) -----------------------
	const renderStatusLine = () => {
		const trimmed = pathValue.trim();
		if (errorMessage) {
			return html`<span class="text-red-500 text-xs">${errorMessage}</span>`;
		}
		if (!trimmed) {
			return html`<span class="text-muted-foreground text-xs">Type a path or click Browse to pick a directory.</span>`;
		}
		if (!detectionResult) {
			return html`<span class="text-muted-foreground text-xs">Checking directory…</span>`;
		}
		if (detectionResult.hasBobbit) {
			return html`<span class="text-green-600 dark:text-green-400 text-xs">An existing Bobbit project was found. Click <strong>Continue</strong> to register it.</span>`;
		}
		if (detectionResult.exists && !detectionResult.isEmpty) {
			return html`<span class="text-muted-foreground text-xs">This directory will be set up as a new Bobbit project.</span>`;
		}
		return html`<span class="text-muted-foreground text-xs">A new project will be scaffolded in this directory.</span>`;
	};

	// --- path step body -----------------------------------------------------
	const renderPathBody = () => html`
		<div class="flex flex-col gap-3 h-full min-h-0">
			<label class="text-xs text-muted-foreground block shrink-0">Project Directory</label>
			<div class="shrink-0">${pickerEl}</div>
			<div class="shrink-0 min-h-[20px]" data-testid="add-project-status-slot">${renderStatusLine()}</div>
			<div class="flex-1 min-h-0 overflow-y-auto" data-testid="add-project-preflight-slot">
				${pathValue.trim() && !preflightUnavailable
					? renderPreflightPanel({
						report: preflightReport,
						loading: preflightLoading,
						error: preflightError,
						archiving,
						onArchive: openArchiveConfirm,
					})
					: ""}
			</div>
		</div>
	`;

	// --- scan step body -----------------------------------------------------
	const renderScanBody = () => {
		const total = scanItems.length;
		const selected = scanSelection.size;
		return html`
			<div class="flex flex-col gap-3 h-full min-h-0" data-testid="add-project-scan-checklist">
				<p class="text-xs text-muted-foreground shrink-0">
					Detected ${total} repo/subdirectory candidate${total === 1 ? "" : "s"} in
					<code class="font-mono">${pathValue.trim()}</code>.
				</p>
				<div class="flex items-center gap-3 shrink-0 text-xs">
					<span data-testid="add-project-selected-count" class="text-foreground font-medium">
						Selected ${selected} of ${total}
					</span>
					<button
						type="button"
						class="px-2 py-1 rounded border border-border text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
						?disabled=${selected === total}
						@click=${selectAll}
						data-testid="add-project-select-all"
					>Select all</button>
					<button
						type="button"
						class="px-2 py-1 rounded border border-border text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
						?disabled=${selected === 0}
						@click=${deselectAll}
						data-testid="add-project-deselect-all"
					>Deselect all</button>
				</div>
				<div class="flex-1 min-h-0 overflow-y-auto border border-border rounded">
					${scanItems.map((item) => {
						const checked = scanSelection.has(item.id);
						const cmdCount = Object.keys(item.detectedCommands || {}).length;
						return html`
							<label
								class="flex items-start gap-2 px-3 py-2 text-sm border-b border-border last:border-0 cursor-pointer hover:bg-secondary/40"
								data-testid="add-project-scan-row-${item.id}"
								data-scan-id=${item.id}
							>
								<input
									type="checkbox"
									class="mt-1 shrink-0"
									.checked=${checked}
									data-testid="add-project-scan-checkbox-${item.id}"
									@change=${(e: Event) => toggleScanItem(item.id, (e.target as HTMLInputElement).checked)}
								/>
								<div class="flex flex-col min-w-0 flex-1">
									<div class="flex items-center gap-2 flex-wrap">
										<code class="font-mono text-foreground">${item.label}</code>
										<span class="text-[10px] uppercase tracking-wider text-muted-foreground">${item.kind === "workspace" ? "workspace" : item.hasGit ? "git" : "manifest"}</span>
										${cmdCount > 0
											? html`<span class="text-[10px] text-muted-foreground">${cmdCount} cmd${cmdCount === 1 ? "" : "s"}</span>`
											: html`<span class="text-[10px] text-amber-600 dark:text-amber-400 italic">data-only</span>`}
									</div>
									${cmdCount > 0
										? html`<div class="text-[10px] text-muted-foreground font-mono truncate" title=${Object.keys(item.detectedCommands).join(", ")}>${Object.keys(item.detectedCommands).join(", ")}</div>`
										: ""}
								</div>
							</label>
						`;
					})}
				</div>
				<p class="text-[11px] text-muted-foreground shrink-0">
					Unchecked repos/subdirectories will not be considered for the initial component proposal.
					The assistant can still add or remove components later.
				</p>
			</div>
		`;
	};

	// --- footer (sticky, position-invariant across all states) --------------
	const renderFooter = () => {
		if (step === "scan") {
			return html`
				<div class="flex gap-2 justify-end">
					${Button({ variant: "ghost", onClick: goBackToPath, children: "Back", disabled: busy })}
					${Button({
						variant: "default",
						onClick: confirmScanAndContinue,
						disabled: busy || scanSelection.size === 0,
						children: html`<span data-testid="add-project-continue">Continue with assistant</span>`,
					})}
				</div>
			`;
		}
		const trimmed = pathValue.trim();
		const continueDisabled =
			busy || archiving || !trimmed || (preflightReport?.hasFail === true);
		const continueLabel = busy ? "Detecting…" : archiving ? "Archiving…" : "Continue";
		return html`
			<div class="flex gap-2 justify-end">
				${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
				${Button({
					variant: "default",
					onClick: doContinue,
					disabled: continueDisabled,
					children: html`<span data-testid="add-project-continue">${continueLabel}</span>`,
				})}
			</div>
		`;
	};

	const renderDialog = () => {
		// Keep picker props in sync with current state. Properties are set
		// imperatively because the picker element is created once and embedded
		// as a stable DOM node, not via Lit's property bindings.
		pickerEl.value = pathValue;
		pickerEl.recentPaths = recentPaths();
		// Lazily wire the browseDirectory callback (avoids importing the API
		// module before the dialog is opened).
		const pickerAny = pickerEl as unknown as { __browseWired?: boolean };
		if (!pickerAny.__browseWired) {
			void import("./api.js").then((m) => {
				pickerEl.browseDirectory = m.browseDirectory;
				pickerAny.__browseWired = true;
			});
		}
		pickerEl.disabled = busy;

		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(720px, 94vw)",
				height: "min(720px, 92vh)",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					<div class="flex flex-col h-full" data-testid="add-project-dialog">
						<div class="shrink-0 px-6 pt-6 pb-2">
							${DialogHeader({
								title: step === "scan"
									? "Confirm repos/subdirectories"
									: detectionResult?.hasBobbit
										? "Register Project"
										: "Add Project",
							})}
							<span class="hidden" data-testid="add-project-step">${step}</span>
						</div>
						<div class="flex-1 min-h-0 px-6 pb-2 overflow-hidden">
							${step === "scan" ? renderScanBody() : renderPathBody()}
						</div>
						<div
							class="shrink-0 px-6 py-4 border-t border-border"
							data-testid="add-project-footer"
						>
							${renderFooter()}
						</div>
					</div>
				`,
			}),
			container,
		);

		// Focus the picker input when sitting on the path step (initial open and
		// when returning from the scan step).
		if (step === "path") {
			requestAnimationFrame(() => {
				if (document.activeElement?.tagName !== "INPUT") pickerEl.focusInput();
			});
		}
	};

	renderDialog();
	// First-paint kick: if the user opened the dialog with a non-empty pathValue
	// (e.g. via future deep-link), run detection eagerly. Otherwise the picker
	// drives everything via events.
	if (pathValue.trim()) {
		onEffectivePathChange(pathValue, true);
	}
}
