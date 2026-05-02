import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { WandSparkles } from "lucide";
import { cwdCombobox } from "./cwd-combobox.js";
import QRCode from "qrcode";
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
import { gatewayFetch, updateGoal } from "./api.js";
import { updateLocalSessionTitle } from "./api.js";
import { refreshSessions } from "./api.js";
import { BOBBIT_HUE_ROTATIONS, sessionColorMap, setSessionColor, statusBobbit, getAccessory } from "./session-colors.js";
// NOTE: session-manager imports from dialogs, so we use dynamic imports to break the cycle


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

export function showConnectionError(title: string, message: string): void {
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
						<p class="text-sm text-destructive mt-2">${message}</p>
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
								<p class="text-sm text-red-500">${error}</p>
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
								${error ? html`<p class="text-xs text-red-500">${error}</p>` : ""}
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
								? html`<p class="text-sm text-red-500">${error}</p>`
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
		if ((import.meta as any)?.env?.DEV) throw new Error(msg);
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
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create goal assistant", msg);
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
// ASSIGN ROLE DIALOG
// ============================================================================

export async function showAssignRoleDialog(sessionId: string): Promise<void> {
	const { fetchRoles } = await import("./api.js");
	if (state.roles.length === 0) await fetchRoles();
	if (state.roles.length === 0) return; // no roles available

	const container = document.createElement("div");
	document.body.appendChild(container);

	let assigning = false;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doAssign = async (roleName: string) => {
		assigning = true;
		renderDialog();
		try {
			await gatewayFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: roleName }),
			});
			await refreshSessions();
		} catch (err) {
			console.error("[assign-role] Failed:", err);
		}
		cleanup();
		renderApp();
	};

	const renderDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(),
				width: "min(360px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Assign Role" })}
							<p class="text-sm text-muted-foreground mt-2 mb-3">Choose a role for this session. The agent will restart with the role's system prompt.</p>
							<div class="flex flex-col gap-1">
								${assigning
									? html`<div class="flex items-center justify-center py-4 text-sm text-muted-foreground">
										<svg class="animate-spin mr-2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
										Assigning role…
									</div>`
									: state.roles.filter(r => r.name !== "general").map(role => html`
										<button
											class="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-secondary/50 text-foreground transition-colors flex items-center gap-2"
											@click=${() => doAssign(role.name)}
											title="Assign ${role.label} role">
											<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
											<span>${role.label}</span>
										</button>
									`)
								}
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => cleanup(), children: "Cancel" })}
							</div>
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
// PROJECT REGISTRATION DIALOG
// ============================================================================

export function showProjectDialog(): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let pathValue = "";
	let loading = false;
	let error = "";
	let browsing = false;
	let browseEntries: Array<{ name: string; path: string }> = [];
	let browseCurrent = "";
	let browseParent: string | null = null;
	let browseLoading = false;
	let browseError = "";

	// Live detection state — updated as the user types/selects a path
	let detectionResult: { exists: boolean; hasBobbit: boolean; isEmpty: boolean; name: string } | null = null;
	let detectTimer: ReturnType<typeof setTimeout> | null = null;

	// Multi-repo scan checklist state — surfaced as an intermediate step when
	// the chosen path resolves to more than one detected repo. Single-repo
	// projects skip this step entirely. The selection is informational
	// (transparency before routing to the assistant); the project assistant
	// re-runs `scanRepos` server-side and uses it as ground truth, but this
	// step gives the user a chance to confirm + understand what's coming
	// without typing anything in chat.
	interface DetectedRepo { folder: string; hasGit: boolean; detectedCommands: Record<string, string> }
	let scanResults: DetectedRepo[] | null = null;
	let scanSelection: Set<string> = new Set();
	let showingScan = false;
	let scanScaffolding = false;

	const runDetection = async (dirPath: string) => {
		if (!dirPath.trim()) { detectionResult = null; renderDialog(); return; }
		try {
			const { detectProject } = await import("./api.js");
			detectionResult = await detectProject(dirPath.trim());
		} catch {
			detectionResult = null;
		}
		renderDialog();
	};

	const debouncedDetect = (dirPath: string) => {
		if (detectTimer) clearTimeout(detectTimer);
		detectTimer = setTimeout(() => runDetection(dirPath), 400);
	};

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doContinue = async () => {
		const trimmedPath = pathValue.trim();
		if (!trimmedPath) return;
		loading = true;
		error = "";
		renderDialog();

		try {
			const { detectProject, registerProject, fetchProjects, scanProjectRepos } = await import("./api.js");
			const detection = await detectProject(trimmedPath);

			if (detection.hasBobbit) {
				// Path A: Auto-import
				const project = await registerProject(detection.name, trimmedPath, undefined);
				if (project) {
					setProjects(await fetchProjects());
					renderApp();
					cleanup();
				} else {
					loading = false;
					renderDialog();
				}
				return;
			}

			const scaffolding = !(detection.exists && !detection.isEmpty);
			// Run a multi-repo scan for non-scaffolding paths so we can surface
			// detected sibling repos as a checklist before routing to the
			// assistant. Scaffolding (empty dir / new path) skips the scan.
			if (!scaffolding) {
				try {
					const repos = await scanProjectRepos(trimmedPath);
					const hasMulti = repos.length > 1 || repos.some(r => r.folder !== ".");
					if (hasMulti) {
						scanResults = repos;
						scanSelection = new Set(repos.map(r => r.folder));
						showingScan = true;
						scanScaffolding = false;
						loading = false;
						renderDialog();
						return;
					}
				} catch {
					// Scan failure is non-fatal — fall through to the standard flow.
				}
			}

			// Single-repo (or scan failed / scaffolding): existing flow.
			cleanup();
			await createProjectAssistantSession(trimmedPath, scaffolding);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			loading = false;
			renderDialog();
		}
	};

	const confirmScanAndContinue = async () => {
		const trimmedPath = pathValue.trim();
		if (!trimmedPath) return;
		cleanup();
		await createProjectAssistantSession(trimmedPath, scanScaffolding);
	};

	const openBrowser = async () => {
		browsing = true;
		browseLoading = true;
		browseError = "";
		renderDialog();
		try {
			const { browseDirectory } = await import("./api.js");
			const result = await browseDirectory(pathValue.trim() || undefined);
			browseEntries = result.entries;
			browseCurrent = result.current;
			browseParent = result.parent;
		} catch (err) {
			browseError = err instanceof Error ? err.message : String(err);
		}
		browseLoading = false;
		renderDialog();
	};

	const navigateBrowse = async (dirPath: string) => {
		browseLoading = true;
		browseError = "";
		renderDialog();
		try {
			const { browseDirectory } = await import("./api.js");
			const result = await browseDirectory(dirPath);
			browseEntries = result.entries;
			browseCurrent = result.current;
			browseParent = result.parent;
		} catch (err) {
			browseError = err instanceof Error ? err.message : String(err);
		}
		browseLoading = false;
		renderDialog();
	};

	const selectBrowsed = () => {
		pathValue = browseCurrent;
		browsing = false;
		renderDialog();
		runDetection(pathValue);
	};

	const renderDialog = () => {
		const browseContent = browsing ? html`
			<div class="flex flex-col gap-2" data-testid="directory-browser">
				<div class="flex items-center gap-2">
					${browseParent != null ? html`
						<button
							class="px-2 py-1 text-xs text-foreground rounded border border-border hover:bg-secondary/50 transition-colors"
							@click=${() => navigateBrowse(browseParent!)}
							data-testid="browse-up"
						>Up</button>
					` : ""}
					<span class="text-xs text-muted-foreground truncate flex-1" title="${browseCurrent}">${browseCurrent}</span>
				</div>
				${browseLoading ? html`<p class="text-xs text-muted-foreground">Loading…</p>` : ""}
				${browseError ? html`<p class="text-xs text-red-500">${browseError}</p>` : ""}
				${!browseLoading && !browseError ? html`
					<div class="max-h-[200px] overflow-y-auto border border-border rounded">
						${browseEntries.length === 0
							? html`<div class="px-3 py-2 text-xs text-muted-foreground">No subdirectories</div>`
							: browseEntries.map(entry => html`
								<button
									class="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2 border-b border-border last:border-0"
									@click=${() => navigateBrowse(entry.path)}
									data-testid="browse-entry"
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
									<span class="truncate">${entry.name}</span>
								</button>
							`)}
					</div>
				` : ""}
				<div class="flex gap-2 justify-end">
					${Button({ variant: "ghost", size: "sm" as any, onClick: () => { browsing = false; renderDialog(); }, children: "Cancel" })}
					${Button({ variant: "default", size: "sm" as any, onClick: selectBrowsed, children: "Select", disabled: !browseCurrent })}
				</div>
			</div>
		` : "";

		const scanContent = showingScan && scanResults ? html`
			<div class="flex flex-col gap-3" data-testid="project-scan-checklist">
				<p class="text-xs text-muted-foreground">
					Detected ${scanResults.length} repo${scanResults.length === 1 ? "" : "s"} in <code class="font-mono">${pathValue.trim()}</code>.
					The project assistant will use this as a starting point — you can refine
					the selection in the chat.
				</p>
				<div class="max-h-[260px] overflow-y-auto border border-border rounded" data-testid="scan-repo-list">
					${scanResults.length === 0
						? html`<div class="px-3 py-2 text-xs text-muted-foreground">No repos detected.</div>`
						: scanResults.map(r => {
							const checked = scanSelection.has(r.folder);
							const cmdCount = Object.keys(r.detectedCommands || {}).length;
							return html`
								<label class="flex items-start gap-2 px-3 py-2 text-sm border-b border-border last:border-0 cursor-pointer hover:bg-secondary/40" data-testid="scan-repo-row" data-repo-folder=${r.folder}>
									<input type="checkbox" class="mt-1 shrink-0" .checked=${checked}
										data-testid="scan-repo-toggle"
										@change=${(e: Event) => {
											if ((e.target as HTMLInputElement).checked) scanSelection.add(r.folder);
											else scanSelection.delete(r.folder);
											renderDialog();
										}}/>
									<div class="flex flex-col min-w-0 flex-1">
										<div class="flex items-center gap-2">
											<code class="font-mono text-foreground">${r.folder === "." ? "(root)" : r.folder}</code>
											<span class="text-[10px] text-muted-foreground uppercase tracking-wider">${r.hasGit ? "git" : "manifest"}</span>
											<span class="text-[10px] text-muted-foreground">${cmdCount} cmd${cmdCount === 1 ? "" : "s"}</span>
											${cmdCount === 0
												? html`<span class="text-[10px] text-amber-600 dark:text-amber-400 italic" data-testid="scan-repo-data-only">data-only</span>`
												: ""}
										</div>
										${cmdCount > 0 ? html`<div class="text-[10px] text-muted-foreground font-mono truncate" title=${Object.keys(r.detectedCommands).join(", ")}>${Object.keys(r.detectedCommands).join(", ")}</div>` : ""}
									</div>
								</label>
							`;
						})}
				</div>
				<p class="text-[11px] text-muted-foreground">
					Unchecked repos won't be added as components. The project assistant
					will scaffold workflows for the checked ones, or you can preview
					and edit later in <strong>Settings → Components</strong>.
				</p>
			</div>
		` : "";

		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(480px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: showingScan ? "Detected repos" : (detectionResult?.hasBobbit ? "Register Project" : "Add Project") })}
							<div class="mt-4 flex flex-col gap-4">
								${showingScan ? scanContent : !browsing ? html`
									<div>
										<label class="text-xs text-muted-foreground mb-1 block">Project Directory</label>
										<div class="flex items-center gap-2">
											<div class="flex-1">
												${Input({
													type: "text",
													placeholder: "/path/to/project",
													value: pathValue,
													onInput: (e: Event) => {
														pathValue = (e.target as HTMLInputElement).value;
														debouncedDetect(pathValue);
														renderDialog();
													},
													onKeyDown: (e: KeyboardEvent) => {
														if (e.key === "Enter") { e.preventDefault(); doContinue(); }
														if (e.key === "Escape") cleanup();
													},
												})}
											</div>
											${Button({
												variant: "ghost",
												onClick: openBrowser,
												children: "Browse",
											})}
										</div>
										${detectionResult && pathValue.trim() ? html`
											<p class="text-xs mt-1.5 ${detectionResult.hasBobbit ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}">
												${detectionResult.hasBobbit
													? html`An existing Bobbit project was found in this directory. Click <strong>Continue</strong> to register it.`
													: detectionResult.exists && !detectionResult.isEmpty
														? "This directory will be set up as a new Bobbit project."
														: "A new project will be scaffolded in this directory."}
											</p>
										` : ""}
									</div>
								` : browseContent}
								${error ? html`<p class="text-xs text-red-500">${error}</p>` : ""}
							</div>
						`,
					})}
					${showingScan ? DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => { showingScan = false; scanResults = null; renderDialog(); }, children: "Back" })}
								${Button({
									variant: "default",
									onClick: confirmScanAndContinue,
									disabled: scanSelection.size === 0,
									children: "Continue with assistant",
								})}
							</div>
						`,
					}) : !browsing ? DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: doContinue,
									disabled: !pathValue.trim() || loading,
									children: loading ? "Detecting…" : "Continue",
								})}
							</div>
						`,
					}) : ""}
				`,
			}),
			container,
		);

		requestAnimationFrame(() => {
			const input = container.querySelector("input");
			if (input && !browsing) input.focus();
		});
	};

	renderDialog();
}

export async function createProjectAssistantSession(dirPath: string, scaffolding: boolean, opts?: { projectId?: string; existingProjectName?: string }): Promise<void> {
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
		await connectToSession(id, false, { assistantType: actualType, projectDirPath: dirPath, projectEditContext });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create project assistant", msg);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// CASCADE CONFIRMATION DIALOGS — Phase 5b
//
// These mirror the existing `confirmAction` pattern but show explicit
// per-cascade choices (`Archive descendants too`, `Pause/Resume descendants`)
// instead of a single boolean confirm. The server-side endpoints require
// `cascade=true|false` (422 otherwise), so the UI is the policy authority.
// ============================================================================

interface CascadeArchiveResult { archived: number }

/**
 * Archive a goal with cascade UX. Emits `DELETE /api/goals/:id?cascade=...`.
 * Returns the count of goals archived (0 = cancelled).
 *
 * Flow:
 *  1. Pre-flight `DELETE /api/goals/:id?cascade=false`. If 200 → archived
 *     immediately (no descendants); resolve with `{archived: 1}`.
 *  2. If 409 `HAS_DESCENDANTS` → open the cascade dialog. The "Archive
 *     descendants too" checkbox is checked + read-only (you cannot orphan
 *     children); the user can cancel or confirm. On confirm, send
 *     `cascade=true`.
 *  3. Any other failure → reject (caller decides — typically just refresh).
 */
export async function showArchiveGoalDialog(goal: Goal): Promise<CascadeArchiveResult> {
	// Pre-flight: try cascade=false. If the server reports descendants we'll
	// open the dialog; otherwise treat as a normal archive and we're done.
	let preflightStatus = 0;
	let preflightBody: { code?: string; count?: number; archived?: number; ok?: boolean } | null = null;
	try {
		const res = await gatewayFetch(`/api/goals/${goal.id}?cascade=false`, { method: "DELETE" });
		preflightStatus = res.status;
		preflightBody = await res.json().catch(() => null);
	} catch {
		// fall through — let the dialog explain the failure if any
	}

	if (preflightStatus === 200) {
		return { archived: typeof preflightBody?.archived === "number" ? preflightBody.archived : 1 };
	}

	if (preflightStatus !== 409 || preflightBody?.code !== "HAS_DESCENDANTS") {
		// Not a descendants conflict — surface the error and bail.
		const msg = preflightStatus
			? `Archive failed (HTTP ${preflightStatus}).`
			: "Archive failed (network error).";
		showConnectionError("Failed to archive goal", msg);
		return { archived: 0 };
	}

	const descendantCount = preflightBody?.count ?? 0;

	return new Promise<CascadeArchiveResult>((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let confirming = false;

		const cleanup = (result: CascadeArchiveResult) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const doConfirm = async () => {
			if (confirming) return;
			confirming = true;
			renderDialog();
			try {
				const res = await gatewayFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
				const body = await res.json().catch(() => null);
				if (!res.ok) {
					confirming = false;
					renderDialog();
					showConnectionError("Failed to archive goal", `HTTP ${res.status}`);
					cleanup({ archived: 0 });
					return;
				}
				cleanup({ archived: typeof body?.archived === "number" ? body.archived : descendantCount + 1 });
			} catch (err) {
				confirming = false;
				renderDialog();
				const msg = err instanceof Error ? err.message : String(err);
				showConnectionError("Failed to archive goal", msg);
				cleanup({ archived: 0 });
			}
		};

		const renderDialog = () => {
			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup({ archived: 0 }),
					width: "min(460px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: "Archive goal & descendants" })}
								<p class="text-sm text-muted-foreground mt-2" data-testid="cascade-archive-summary">
									"${goal.title}" has ${descendantCount} descendant goal${descendantCount === 1 ? "" : "s"}.
								</p>
								<div class="mt-3 flex flex-col gap-2 text-sm">
									<label class="flex items-start gap-2 cursor-not-allowed" title="Cannot orphan child goals — must cascade or cancel.">
										<input type="checkbox" checked disabled data-testid="cascade-archive-checkbox-cascade" />
										<span>
											Archive descendants too (${descendantCount} child goal${descendantCount === 1 ? "" : "s"})
											<span class="block text-[10px] text-muted-foreground">Required: cannot orphan child goals.</span>
										</span>
									</label>
									<label class="flex items-start gap-2 cursor-not-allowed" title="Sessions are torn down automatically by archive.">
										<input type="checkbox" checked disabled data-testid="cascade-archive-checkbox-teardown" />
										<span>
											Tear down running team sessions
											<span class="block text-[10px] text-muted-foreground">Required: archive intrinsically tears down sessions.</span>
										</span>
									</label>
								</div>
							`,
						})}
						${DialogFooter({
							className: "px-6 pb-4",
							children: html`
								<div class="flex gap-2 justify-end">
									${Button({ variant: "ghost", onClick: () => cleanup({ archived: 0 }), children: "Cancel", disabled: confirming })}
									${Button({
										variant: "default",
										onClick: () => doConfirm(),
										disabled: confirming,
										className: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
										children: confirming
											? "Archiving…"
											: `Archive parent + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`,
									})}
								</div>
							`,
						})}
					`,
				}),
				container,
			);
		};
		renderDialog();
	});
}

interface CascadePauseResult { paused: number }

/**
 * Pause a goal with optional cascade. Emits `POST /api/goals/:id/pause`
 * with body `{ cascade: boolean }`. Cascade defaults to ON when descendants
 * exist (the typical user intent). Returns count of goals paused.
 *
 * If the goal has zero descendants, sends `cascade: false` directly without
 * showing a dialog.
 */
export async function showPauseGoalDialog(goal: Goal, descendantCount: number): Promise<CascadePauseResult> {
	if (descendantCount === 0) {
		const res = await gatewayFetch(`/api/goals/${goal.id}/pause`, {
			method: "POST",
			body: JSON.stringify({ cascade: false }),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			showConnectionError("Failed to pause goal", `HTTP ${res.status}`);
			return { paused: 0 };
		}
		return { paused: typeof data?.paused === "number" ? data.paused : 0 };
	}

	return new Promise<CascadePauseResult>((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let cascade = true;
		let working = false;

		const cleanup = (result: CascadePauseResult) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const doConfirm = async () => {
			if (working) return;
			working = true;
			renderDialog();
			try {
				const res = await gatewayFetch(`/api/goals/${goal.id}/pause`, {
					method: "POST",
					body: JSON.stringify({ cascade }),
				});
				const body = await res.json().catch(() => null);
				if (!res.ok) {
					working = false;
					renderDialog();
					showConnectionError("Failed to pause goal", `HTTP ${res.status}`);
					cleanup({ paused: 0 });
					return;
				}
				cleanup({ paused: typeof body?.paused === "number" ? body.paused : 0 });
			} catch (err) {
				working = false;
				renderDialog();
				showConnectionError("Failed to pause goal", err instanceof Error ? err.message : String(err));
				cleanup({ paused: 0 });
			}
		};

		const renderDialog = () => {
			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup({ paused: 0 }),
					width: "min(440px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: "Pause goal" })}
								<p class="text-sm text-muted-foreground mt-2" data-testid="cascade-pause-summary">
									"${goal.title}" has ${descendantCount} descendant goal${descendantCount === 1 ? "" : "s"}.
								</p>
								<label class="flex items-start gap-2 mt-3 text-sm cursor-pointer">
									<input type="checkbox"
										?checked=${cascade}
										data-testid="cascade-pause-checkbox"
										@change=${(e: Event) => { cascade = (e.target as HTMLInputElement).checked; renderDialog(); }} />
									<span>Also pause ${descendantCount} descendant goal${descendantCount === 1 ? "" : "s"}</span>
								</label>
							`,
						})}
						${DialogFooter({
							className: "px-6 pb-4",
							children: html`
								<div class="flex gap-2 justify-end">
									${Button({ variant: "ghost", onClick: () => cleanup({ paused: 0 }), children: "Cancel", disabled: working })}
									<span data-testid="cascade-pause-confirm">${Button({
										variant: "default",
										disabled: working,
										onClick: () => doConfirm(),
										children: working ? "Pausing…" : (cascade ? `Pause goal + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}` : "Pause goal"),
									})}</span>
								</div>
							`,
						})}
					`,
				}),
				container,
			);
		};
		renderDialog();
	});
}

interface CascadeResumeResult { resumed: number }

/**
 * Resume a goal with optional cascade. Symmetric to pause; checkbox
 * defaults OFF (the typical user intent is to resume only the focused
 * goal). Sends `POST /api/goals/:id/resume` with `{ cascade: boolean }`.
 */
export async function showResumeGoalDialog(goal: Goal, descendantCount: number): Promise<CascadeResumeResult> {
	if (descendantCount === 0) {
		const res = await gatewayFetch(`/api/goals/${goal.id}/resume`, {
			method: "POST",
			body: JSON.stringify({ cascade: false }),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			showConnectionError("Failed to resume goal", `HTTP ${res.status}`);
			return { resumed: 0 };
		}
		return { resumed: typeof data?.resumed === "number" ? data.resumed : 0 };
	}

	return new Promise<CascadeResumeResult>((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let cascade = false; // default OFF for resume — targeted by default
		let working = false;

		const cleanup = (result: CascadeResumeResult) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const doConfirm = async () => {
			if (working) return;
			working = true;
			renderDialog();
			try {
				const res = await gatewayFetch(`/api/goals/${goal.id}/resume`, {
					method: "POST",
					body: JSON.stringify({ cascade }),
				});
				const body = await res.json().catch(() => null);
				if (!res.ok) {
					working = false;
					renderDialog();
					showConnectionError("Failed to resume goal", `HTTP ${res.status}`);
					cleanup({ resumed: 0 });
					return;
				}
				cleanup({ resumed: typeof body?.resumed === "number" ? body.resumed : 0 });
			} catch (err) {
				working = false;
				renderDialog();
				showConnectionError("Failed to resume goal", err instanceof Error ? err.message : String(err));
				cleanup({ resumed: 0 });
			}
		};

		const renderDialog = () => {
			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup({ resumed: 0 }),
					width: "min(440px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: "Resume goal" })}
								<p class="text-sm text-muted-foreground mt-2" data-testid="cascade-resume-summary">
									"${goal.title}" has ${descendantCount} descendant goal${descendantCount === 1 ? "" : "s"} that may also be paused.
								</p>
								<label class="flex items-start gap-2 mt-3 text-sm cursor-pointer">
									<input type="checkbox"
										?checked=${cascade}
										data-testid="cascade-resume-checkbox"
										@change=${(e: Event) => { cascade = (e.target as HTMLInputElement).checked; renderDialog(); }} />
									<span>Also resume ${descendantCount} descendant goal${descendantCount === 1 ? "" : "s"}</span>
								</label>
							`,
						})}
						${DialogFooter({
							className: "px-6 pb-4",
							children: html`
								<div class="flex gap-2 justify-end">
									${Button({ variant: "ghost", onClick: () => cleanup({ resumed: 0 }), children: "Cancel", disabled: working })}
									${Button({
										variant: "default",
										disabled: working,
										onClick: () => doConfirm(),
										children: working ? "Resuming…" : (cascade ? `Resume goal + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}` : "Resume goal"),
									})}
								</div>
							`,
						})}
					`,
				}),
				container,
			);
		};
		renderDialog();
	});
}

/** Walk client state for the count of non-archived descendants of `goalId`. */
export function countDescendants(goalId: string): number {
	let total = 0;
	const queue = [goalId];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of state.goals) {
			if (g.parentGoalId !== cur || g.archived) continue;
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			total++;
			queue.push(g.id);
		}
	}
	return total;
}
