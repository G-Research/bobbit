import http from "node:http";

import { expect, test } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";

const ASSERTION_MARKER = "REQUEST_ADMISSION_DNS_REBINDING";

function requestHealthWithAttackerAuthority(baseURL: string, token: string): Promise<number> {
	const gateway = new URL(baseURL);
	const attackerAuthority = `attacker.example:${gateway.port}`;

	return new Promise((resolve, reject) => {
		const request = http.request({
			hostname: "127.0.0.1",
			port: Number(gateway.port),
			path: "/api/health",
			method: "GET",
			headers: {
				Host: attackerAuthority,
				Origin: `http://${attackerAuthority}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				Authorization: `Bearer ${token}`,
				Connection: "close",
			},
		}, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode ?? 0));
		});
		request.once("error", reject);
		request.end();
	});
}

test("rejects DNS rebinding when attacker Host and Origin are equal", async ({ gateway }) => {
	const status = await requestHealthWithAttackerAuthority(gateway.baseURL, gateway.token);

	expect(
		status,
		`${ASSERTION_MARKER}: equal attacker Host and Origin must not authorize a loopback request`,
	).toBe(403);
});
