/**
 * LSP error taxonomy. Tool callers receive these as `{ error: <code>, message }`
 * shapes so the agent can branch (fall back to grep on `lsp_unavailable`, etc.).
 */

export class LspError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "LspError";
	}
}

export class LspUnavailableError extends LspError {
	constructor(message: string) { super("lsp_unavailable", message); }
}

export class LspCapacityError extends LspError {
	constructor(message: string) { super("lsp_capacity", message); }
}

export class LspTimeoutError extends LspError {
	constructor(message: string) { super("lsp_timeout", message); }
}
