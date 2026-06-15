import fs from "node:fs";

function log(ctx, hook) {
	fs.appendFileSync(ctx.cwd + "/.provider-demo-log", hook + "\n", "utf-8");
}

export default {
	sessionSetup(ctx) {
		log(ctx, "sessionSetup");
		return {
			blocks: [{
				id: "demo:setup",
				title: "Demo",
				authority: "generic",
				priority: 10,
				reason: "fixture",
				content: "DEMO_SETUP_BLOCK " + ctx.sessionId,
			}],
		};
	},
	beforePrompt(ctx) {
		log(ctx, "beforePrompt");
		return { blocks: [] };
	},
	afterTurn(ctx) {
		log(ctx, "afterTurn");
		return { blocks: [] };
	},
	beforeCompact(ctx) {
		log(ctx, "beforeCompact");
		return { blocks: [] };
	},
	sessionShutdown(ctx) {
		log(ctx, "sessionShutdown");
		return { blocks: [] };
	},
};
