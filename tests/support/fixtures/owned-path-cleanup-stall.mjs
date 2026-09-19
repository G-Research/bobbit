import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

let encoded = "";
for await (const chunk of process.stdin) encoded += chunk.toString("utf8");
const request = JSON.parse(encoded);
const entries = await readdir(request.target);

// Force the parent's bounded graceful→forced escalation while performing real
// filesystem work. The tracked process tree must stop this loop before the
// caller is allowed to observe settlement.
process.on("SIGTERM", () => {});
for (const entry of entries) {
	await new Promise(resolve => setTimeout(resolve, 40));
	await unlink(path.join(request.target, entry)).catch(() => {});
}
await new Promise(() => {});
