import http from "node:http";
import { describe, expect, it } from "vitest";
import { createFencedFetch } from "../harness/fenced-fetch.js";

describe("fenced fetch", () => {
	it("rejects non-loopback hosts", async () => {
		const fencedFetch = createFencedFetch();
		await expect(fencedFetch("https://api.github.com/")).rejects.toThrow(/blocked non-loopback fetch/);
	});

	it("allows loopback hosts", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("expected TCP server address");
			const fencedFetch = createFencedFetch();
			const response = await fencedFetch(`http://127.0.0.1:${addr.port}/`);
			expect(await response.text()).toBe("ok");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
