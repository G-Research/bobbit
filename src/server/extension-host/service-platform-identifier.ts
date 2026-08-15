const SERVICE_PLATFORM_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isServicePlatformIdentifier(value: unknown): value is string {
	return typeof value === "string" && SERVICE_PLATFORM_IDENTIFIER.test(value);
}
