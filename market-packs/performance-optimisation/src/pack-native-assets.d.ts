declare module "bobbit:pack-native-assets" {
	export interface NativeAssetRuntime {
		platform: string;
		arch: string;
		glibcVersionRuntime?: string | null;
	}

	export function resolvePackNativeAsset(
		familyDirectory: string | URL,
		runtime?: NativeAssetRuntime,
	): string;
}
