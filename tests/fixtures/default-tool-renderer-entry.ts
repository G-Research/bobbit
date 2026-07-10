// Test entry for DefaultRenderer browser-fixture coverage.
import { render } from "lit";
import { DefaultRenderer } from "../../src/ui/tools/renderers/DefaultRenderer.js";
import { McpDefaultRenderer } from "../../src/ui/tools/renderers/McpDefaultRenderer.js";
import { renderTool } from "../../src/ui/tools/index.js";

class TestCodeBlock extends HTMLElement {
	private _code = "";

	set code(value: string) {
		this._code = value ?? "";
		this.render();
	}

	get code(): string {
		return this._code;
	}

	static get observedAttributes() {
		return ["code", "language"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
		if (name === "code") this._code = newValue ?? "";
		this.render();
	}

	private render() {
		const language = this.getAttribute("language") || "";
		this.style.display = "block";
		this.innerHTML = "";
		const pre = document.createElement("pre");
		pre.setAttribute("data-language", language);
		pre.textContent = this._code;
		this.appendChild(pre);
	}
}

if (!customElements.get("code-block")) {
	customElements.define("code-block", TestCodeBlock);
}

function makeResult(payload: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "diagnostic_tool",
		isError,
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
		timestamp: Date.now(),
	};
}

(window as any).__renderDefaultTool = (
	toolName: string,
	params: any,
	resultPayload: any,
	isError = false,
	isStreaming = false,
) => {
	const container = document.getElementById("container");
	if (!container) throw new Error("missing #container");
	const renderer = new DefaultRenderer(toolName);
	const result = resultPayload === undefined ? undefined : makeResult(resultPayload, isError);
	const out = renderer.render(params, result, isStreaming);
	render(out.content, container);
};

(window as any).__renderMcpTool = (
	toolName: string,
	params: any,
	resultPayload: any,
	isError = false,
) => {
	const container = document.getElementById("container");
	if (!container) throw new Error("missing #container");
	const renderer = new McpDefaultRenderer(toolName);
	const result = resultPayload === undefined ? undefined : makeResult(resultPayload, isError);
	const out = renderer.render(params, result, false);
	render(out.content, container);
};

(window as any).__renderCascadeTool = (
	toolName: string,
	params: any,
	resultPayload: any,
	isError = false,
) => {
	const container = document.getElementById("container");
	if (!container) throw new Error("missing #container");
	const result = resultPayload === undefined ? undefined : makeResult(resultPayload, isError);
	const out = renderTool(toolName, params, result, false);
	render(out.content, container);
};

(window as any).__ready = true;
