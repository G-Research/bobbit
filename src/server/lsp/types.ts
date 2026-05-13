/**
 * LSP types — minimal re-exports/aliases over vscode-languageserver-protocol.
 *
 * We keep the supervisor wire layer thin and let the protocol types flow
 * through. Paths on the gateway-side adapter API are absolute; the gateway
 * HTTP route is responsible for converting tool-input relative paths to
 * absolute, and adapter-returned URIs back to caller-relative paths.
 */

export type Language = "typescript" | "python";

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	/** Caller-relative path (gateway re-relativises this against tool-input cwd). */
	path: string;
	range: Range;
}

export interface HoverResult {
	contents: string;
	range?: Range;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
	path: string;
	range: Range;
	severity: DiagnosticSeverity;
	message: string;
	source?: string;
	code?: string | number;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: number;
	path: string;
	range: Range;
	containerName?: string;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface WorkspaceEdit {
	changes: Record<string /* relative path */, TextEdit[]>;
}
