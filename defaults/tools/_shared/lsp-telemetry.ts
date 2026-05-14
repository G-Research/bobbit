// Best-effort client for the LSP adoption-telemetry endpoint.
//
// Tool extensions that emit `[lsp-hint]` lines (currently the grep/bash LSP
// nudges) call `recordHintEmitted()` after printing the hint so the gateway
// can track the `grepLspHintEmittedTotal` counter exposed at
// `GET /api/lsp/stats.counters`.
//
// Contract:
//   - Fire-and-forget. The hint MUST still print even if telemetry fails.
//   - Any error (gateway unreachable, missing token, non-2xx, JSON parse,
//     auth boot race) is swallowed silently. We never throw.
//   - No retries — the counter is best-effort gauge data, not durable.
//
// Server side: see `src/server/server.ts` route
// `POST /api/lsp/_internal/hint-emitted` and `LspSupervisor.recordHintEmitted()`.

import { getGatewayUrl, getGatewayToken } from "./gateway.ts";

export async function recordHintEmitted(): Promise<void> {
	try {
		const baseUrl = getGatewayUrl();
		const token = getGatewayToken();
		// Self-signed cert on the gateway loopback; agree to it the same way
		// every other tool extension does.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			await fetch(`${baseUrl}/api/lsp/_internal/hint-emitted`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: "{}",
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// Swallow: best-effort telemetry must never block hint emission.
	}
}
