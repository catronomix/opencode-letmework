import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import {
  DEFAULT_CONFIG,
  evaluate,
  isGitRepository,
  parseConfig,
  type Config,
  type PermissionRequest,
} from "./logic.ts"

const CONFIG_FILE = "config.yaml"
/** Guard against a runaway loop if the same request is announced twice. */
const SEEN_LIMIT = 256

type PermissionAsked = PermissionRequest & {
  id: string
  sessionID: string
  message?: string
}

function pluginDirectory(): string {
  const dirname = (import.meta as { dirname?: string }).dirname
  return dirname ?? fileURLToPath(new URL(".", import.meta.url))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      done()
    }
    const timer = setTimeout(finish, ms)
    if (signal?.aborted) return finish()
    signal?.addEventListener("abort", finish, { once: true })
  })
}

/** Re-reads config.yaml when its mtime changes, so edits apply without a reload. */
function configLoader(path: string): () => Config {
  let mtime = Number.NaN
  let config: Config = DEFAULT_CONFIG

  return () => {
    let next = Number.NaN
    try {
      next = statSync(path).mtimeMs
    } catch {
      next = Number.NaN
    }

    if (next === mtime) return config
    mtime = next

    if (!Number.isFinite(next)) {
      console.error(`letmework: ${path} not found, using defaults`)
      config = DEFAULT_CONFIG
      return config
    }

    try {
      config = parseConfig(readFileSync(path, "utf8"))
      console.error(
        `letmework: loaded ${path} (wait ${config.waitseconds}s, suffix "${config.suffix}", ` +
          `${config.extraFolders.length} extra folder(s), ${config.createAndUse.length} create-and-use folder(s))`,
      )
    } catch (error) {
      console.error(`letmework: cannot read ${path}, using defaults`, error)
      config = DEFAULT_CONFIG
    }

    return config
  }
}

/** Tolerates both shapes: a bare array or an API envelope with `data`. */
function pendingList(value: unknown): readonly { id: string }[] {
  if (Array.isArray(value)) return value as readonly { id: string }[]
  const data = (value as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? (data as readonly { id: string }[]) : []
}

export default Plugin.define({
  id: "letmework",
  async setup(ctx) {
    const cwd = ctx.location.directory
    const option = (ctx.options as { config?: unknown } | undefined)?.config
    const configPath =
      typeof option === "string" && option.length > 0 ? option : join(pluginDirectory(), CONFIG_FILE)
    const config = configLoader(configPath)

    const controller = new AbortController()
    const seen = new Set<string>()

    const approve = async (request: PermissionAsked) => {
      const label = `${request.action} ${request.resources.join(", ")}`
      const decision = evaluate({
        cwd,
        isGitRepo: isGitRepository(cwd),
        config: config(),
        request,
      })

      if (!decision.allow) {
        console.error(`letmework: asking for ${label} (${decision.reason})`)
        return
      }

      // The prompt is already visible. Leave it up for a moment so a user who is
      // watching can still reject it before we answer for them.
      const wait = config().waitseconds
      console.error(`letmework: auto-approving ${label} in ${wait}s (${decision.reason})`)
      await sleep(wait * 1000, controller.signal)
      if (controller.signal.aborted) return

      try {
        const pending = (await ctx.permission.list({ sessionID: request.sessionID })) as unknown
        const list = pendingList(pending)
        const stillPending = list.some((item) => item.id === request.id)
        if (!stillPending) {
          console.error(`letmework: kept the user's answer for ${label}`)
          return
        }
        await ctx.permission.reply({
          sessionID: request.sessionID,
          requestID: request.id,
          decision: "once",
        })
      } catch (error) {
        console.error(`letmework: could not auto-approve ${label}`, error)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["permission.asked"],
          signal: controller.signal,
        })) {
          const data = (event as unknown as { data?: PermissionAsked }).data
          if (!data || !data.id) continue
          if (seen.has(data.id)) continue
          seen.add(data.id)
          if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string)
          void approve(data)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("letmework: permission stream stopped", error)
      }
    })()

    return () => controller.abort()
  },
})
