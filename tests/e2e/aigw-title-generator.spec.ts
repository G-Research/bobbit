import { test, expect } from "@playwright/test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8")).version;
const EXPECTED_USER_AGENT = `Bobbit/${PACKAGE_VERSION}`;

interface RecordedRequest {
	method?: string;
	url?: string;
	headers: http.IncomingHttpHeaders;
	rawHeaders: string[];
}

interface MockGateway {
	url: string;
	requests: () => RecordedRequest[];
	close: () => Promise<void>;
}

function userAgentValues(record: RecordedRequest): string[] {
	const values: string[] = [];
	for (let i = 0; i < record.rawHeaders.length; i += 2) {
		if (record.rawHeaders[i]?.toLowerCase() === "user-agent") {
			values.push(record.rawHeaders[i + 1] || "");
		}
	}
	return values;
}

function expectSingleBobbitUserAgent(record: RecordedRequest | undefined): void {
	expect(record, "mock gateway should have recorded goal-summary request").toBeTruthy();
	expect(record!.headers["user-agent"]).toBe(EXPECTED_USER_AGENT);
	expect(userAgentValues(record!)).toEqual([EXPECTED_USER_AGENT]);
}

function startMockAigw(): Promise<MockGateway> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		requests.push({
			method: req.method,
			url: req.url,
			headers: req.headers,
			rawHeaders: [...req.rawHeaders],
		});

		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{ id: "aws/us.anthropic.claude-haiku-4-5", object: "model", created: 1700000000, owned_by: "system" },
				],
			}));
			return;
		}

		if (req.url === "/v1/chat/completions") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				choices: [
					{ message: { content: "<title>Gateway Summary</title>" } },
				],
			}));
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				requests: () => [...requests],
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

test.describe("AI Gateway title-generator User-Agent", () => {
	test("direct goal-summary gateway path sends Bobbit User-Agent", async () => {
		const mock = await startMockAigw();
		const previousSkipTitleGen = process.env.BOBBIT_SKIP_TITLE_GEN;
		delete process.env.BOBBIT_SKIP_TITLE_GEN;
		try {
			const { generateGoalSummaryTitle } = await import("../../dist/server/agent/title-generator.js");
			const title = await generateGoalSummaryTitle("Add AI Gateway user agent", {
				namingModel: "aigw/us.anthropic.claude-haiku-4-5",
				aigwUrl: mock.url,
			});

			expect(title).toBe("Gateway Summary");
			expectSingleBobbitUserAgent(
				mock.requests().find((record) => record.method === "POST" && record.url === "/v1/chat/completions"),
			);
		} finally {
			if (previousSkipTitleGen === undefined) delete process.env.BOBBIT_SKIP_TITLE_GEN;
			else process.env.BOBBIT_SKIP_TITLE_GEN = previousSkipTitleGen;
			await mock.close();
		}
	});
});
