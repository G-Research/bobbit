import { resolvePackNativeAsset } from "bobbit:pack-native-assets";
import { createPerformanceToolExtension } from "./performance-tool-extension.ts";

const nativeBinding = resolvePackNativeAsset(new URL("../../lib/native/database-driver/", import.meta.url));

export default createPerformanceToolExtension({ nativeBinding });
