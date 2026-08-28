import { resolvePackNativeAsset } from "bobbit:pack-native-assets";
import { createPerformanceRoutes } from "./performance-routes.ts";

const nativeBinding = resolvePackNativeAsset(new URL("./native/database-driver/", import.meta.url));

export const routes = createPerformanceRoutes({ nativeBinding });
