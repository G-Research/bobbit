import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loopbackForBind } from "../src/server/cli-loopback.js";

test("loopbackForBind: IPv4 wildcard 0.0.0.0 -> 127.0.0.1", () => {
	assert.equal(loopbackForBind("0.0.0.0"), "127.0.0.1");
});

test("loopbackForBind: IPv6 wildcard :: -> [::1]", () => {
	assert.equal(loopbackForBind("::"), "[::1]");
});

test("loopbackForBind: IPv6 wildcard [::] -> [::1]", () => {
	assert.equal(loopbackForBind("[::]"), "[::1]");
});

test("loopbackForBind: localhost is identity", () => {
	assert.equal(loopbackForBind("localhost"), "localhost");
});

test("loopbackForBind: 127.0.0.1 is identity", () => {
	assert.equal(loopbackForBind("127.0.0.1"), "127.0.0.1");
});

test("loopbackForBind: LAN IP is identity", () => {
	assert.equal(loopbackForBind("192.168.1.50"), "192.168.1.50");
});

test("loopbackForBind: hostname is identity", () => {
	assert.equal(loopbackForBind("bobbit.example.com"), "bobbit.example.com");
});
