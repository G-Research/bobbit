export const DEFAULT_ENTRYPOINT_ICON_ID = "zap";

export const SUPPORTED_ENTRYPOINT_ICON_IDS = [
	DEFAULT_ENTRYPOINT_ICON_ID,
	"terminal",
	"git-pull-request",
] as const;

export type EntrypointIconId = typeof SUPPORTED_ENTRYPOINT_ICON_IDS[number];

const SUPPORTED_ENTRYPOINT_ICON_ID_SET = new Set<string>(SUPPORTED_ENTRYPOINT_ICON_IDS);

export function isSupportedEntrypointIconId(value: unknown): value is EntrypointIconId {
	return typeof value === "string" && SUPPORTED_ENTRYPOINT_ICON_ID_SET.has(value);
}
