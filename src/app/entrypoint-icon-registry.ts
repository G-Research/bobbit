import { GitPullRequest, Terminal, Zap } from "lucide";
import {
	DEFAULT_ENTRYPOINT_ICON_ID,
	isSupportedEntrypointIconId,
	type EntrypointIconId,
} from "../shared/entrypoint-icons.js";

const ENTRYPOINT_ICON_NODES = {
	zap: Zap,
	terminal: Terminal,
	"git-pull-request": GitPullRequest,
} satisfies Record<EntrypointIconId, typeof Zap>;

export function entrypointIconNode(iconId?: string): typeof Zap {
	return ENTRYPOINT_ICON_NODES[isSupportedEntrypointIconId(iconId) ? iconId : DEFAULT_ENTRYPOINT_ICON_ID];
}
