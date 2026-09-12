import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
} from "../../src/app/gateway-fetch.js";
import {
	__resetMcpOperatorAuthForTests,
	hasMcpOperatorCredential,
	MCP_OPERATOR_APPROVAL_HEADER,
	MCP_OPERATOR_CREDENTIAL_STORAGE_KEY,
	mcpOperatorApprovalHeaders,
	MCP_OPERATOR_STORAGE_WARNING,
	pairMcpOperatorBrowser,
} from "../../src/app/mcp-operator-auth.js";

const GATEWAY_A = "https://gateway-a.example/team/bobbit";
const GATEWAY_B = "https://gateway-b.example/team/bobbit";
const CREDENTIAL = `v1.${"A".repeat(22)}.${"A".repeat(43)}`;

function pairResponse(credential = CREDENTIAL): Response {
	return new Response(JSON.stringify({ credential }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("MCP operator browser authorization", () => {
	beforeEach(() => {
		localStorage.clear();
		__resetGatewayConnectionForTests();
		__resetMcpOperatorAuthForTests();
		commitGatewayConnection(GATEWAY_A, "gateway-token");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		localStorage.clear();
		__resetGatewayConnectionForTests();
		__resetMcpOperatorAuthForTests();
	});

	it("trims one pairing request, validates the response, and durably restores it", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pairResponse());
		vi.stubGlobal("fetch", fetchMock);

		await expect(pairMcpOperatorBrowser("  terminal-code  ")).resolves.toEqual({ persisted: true });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe(`${GATEWAY_A}/api/mcp-operator/pair`);
		expect(JSON.parse(String(init?.body))).toEqual({ code: "terminal-code" });
		expect(new Headers(init?.headers).get(MCP_OPERATOR_APPROVAL_HEADER)).toBeNull();
		expect(mcpOperatorApprovalHeaders()).toEqual({ [MCP_OPERATOR_APPROVAL_HEADER]: CREDENTIAL });

		__resetMcpOperatorAuthForTests();
		expect(hasMcpOperatorCredential()).toBe(true);
		expect(mcpOperatorApprovalHeaders()).toEqual({ [MCP_OPERATOR_APPROVAL_HEADER]: CREDENTIAL });
	});

	it("keeps credentials isolated by normalized selected gateway", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pairResponse()));
		await pairMcpOperatorBrowser("terminal-code");

		commitGatewayConnection(`${GATEWAY_B}/`, "gateway-token-b");
		expect(hasMcpOperatorCredential()).toBe(false);
		expect(mcpOperatorApprovalHeaders()).toEqual({});

		commitGatewayConnection(`${GATEWAY_A}/`, "gateway-token");
		expect(hasMcpOperatorCredential()).toBe(true);
	});

	it("stores a delayed pairing response against the gateway that received the code", async () => {
		let resolvePair!: (response: Response) => void;
		vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
			resolvePair = resolve;
		})));
		const pairing = pairMcpOperatorBrowser("terminal-code");
		commitGatewayConnection(GATEWAY_B, "gateway-token-b");
		resolvePair(pairResponse());
		await pairing;

		expect(hasMcpOperatorCredential()).toBe(false);
		commitGatewayConnection(GATEWAY_A, "gateway-token");
		expect(hasMcpOperatorCredential()).toBe(true);
	});

	it("retains a tab-only credential and reports when durable storage fails", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pairResponse()));
		const unavailableStorage = {
			get length() { return 0; },
			clear: vi.fn(),
			key: vi.fn(() => null),
			getItem: vi.fn(() => { throw new Error("blocked"); }),
			removeItem: vi.fn(() => { throw new Error("blocked"); }),
			setItem: vi.fn(() => { throw new Error("blocked"); }),
		} satisfies Storage;
		vi.stubGlobal("localStorage", unavailableStorage);

		await expect(pairMcpOperatorBrowser("terminal-code")).resolves.toEqual({
			persisted: false,
			warning: MCP_OPERATOR_STORAGE_WARNING,
		});
		expect(mcpOperatorApprovalHeaders()).toEqual({ [MCP_OPERATOR_APPROVAL_HEADER]: CREDENTIAL });
	});

	it("rejects a non-canonical credential without persisting or exposing it", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pairResponse("v1.short.not-valid")));
		await expect(pairMcpOperatorBrowser("terminal-code")).rejects.toThrow("invalid MCP operator credential");
		expect(localStorage.getItem(MCP_OPERATOR_CREDENTIAL_STORAGE_KEY)).toBeNull();
		expect(mcpOperatorApprovalHeaders()).toEqual({});
	});
});
