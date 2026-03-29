import type { AppContext } from "../app-context.js";
import http from "node:http";

export async function handle(
	_ctx: AppContext,
	_url: URL,
	_req: http.IncomingMessage,
	_res: http.ServerResponse,
): Promise<boolean> {
	// TODO: Extract route handlers from server.ts
	return false;
}
