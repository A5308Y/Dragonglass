/** Set by `esbuild.config.mjs`; absent when the sources run without it, as in tests. */
declare const __DRAGONGLASS_BUILD__: string | undefined;

/**
 * When this copy of the plugin was built, as an ISO timestamp, or `""` outside a build.
 * Devices that sync the plugin through the vault can run different builds for a while;
 * the settings show this so a difference between devices can be traced to it.
 */
export const BUILD_TIME: string = typeof __DRAGONGLASS_BUILD__ === "string" ? __DRAGONGLASS_BUILD__ : "";
