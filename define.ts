/**
 * A local stand-in for the one runtime helper this plugin used to import from
 * `@opencode/plugin`.
 *
 * `Plugin.define` is a pure function in the SDK — it returns its argument
 * unchanged — so there is nothing to keep importing at runtime. The type is
 * still taken from the SDK (a type-only import is erased), which keeps the
 * package signature-checked against the host API while the published package
 * has no dependencies at all.
 *
 * If a future SDK gives `Plugin.define` real behaviour, mirror it here: the
 * version we target is recorded in `devDependencies`.
 */

type PluginDefinition = Parameters<typeof import("@opencode/plugin").Plugin.define>[0]

/** Mirrors `Plugin.define` from `@opencode/plugin`: the definition, untouched. */
export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  return plugin
}
