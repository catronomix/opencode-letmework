import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import {
  DEFAULT_CONFIG,
  activeNotice,
  evaluate,
  inactiveNotice,
  isGitRepository,
  parseConfig,
  type Config,
  type PermissionRequest,
} from "./logic.ts"

const CONFIG_FILE = "config.yaml"
/** User-level config name; kept distinct from OpenCode's own config files. */
const USER_CONFIG_FILE = "letmework.yaml"
const EXAMPLE_FILE = "config.example.yaml"
/** Guard against a runaway loop if the same request is announced twice. */
const SEEN_LIMIT = 256
/** Storage key for the one-time onboarding notice. */
const NOTICE_KEY = "letmework.notice"

type PermissionAsked = PermissionRequest & {
  id: string
  sessionID: string
  message?: string
}

type Loaded = {
  /** `active` only when a config file was found and parsed. */
  state: "active" | "missing" | "invalid"
  path: string
  config: Config
}

function pluginDirectory(): string {
  const dirname = (import.meta as { dirname?: string }).dirname
  return dirname ?? fileURLToPath(new URL(".", import.meta.url))
}

/** `~/.config` unless XDG_CONFIG_HOME says otherwise, on every platform. */
function configHome(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  return xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
}

/**
 * Where a config may live, most specific first: the plugin option, the plugin's
 * own folder (a clone or a dev checkout), and the user config dir (an npm
 * install, which never ships a config).
 */
function configCandidates(option: unknown): string[] {
  if (typeof option === "string" && option.length > 0) {
    return [option.startsWith("~") ? join(homedir(), option.slice(1)) : option]
  }
  return [join(pluginDirectory(), CONFIG_FILE), join(configHome(), "opencode", USER_CONFIG_FILE)]
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

/**
 * Re-reads the config when its mtime changes, so edits apply without a reload.
 * A missing file is reported, not papered over with defaults: the plugin stays
 * inert until someone writes a config on purpose.
 */
function configLoader(paths: string[]): () => Loaded {
  let mtime = Number.NaN
  let loaded: Loaded = { state: "missing", path: paths[0] ?? CONFIG_FILE, config: DEFAULT_CONFIG }

  return () => {
    const path = paths.find((candidate) => existsSync(candidate)) ?? paths[0] ?? CONFIG_FILE
    let next = Number.NaN
    try {
      next = statSync(path).mtimeMs
    } catch {
      next = Number.NaN
    }

    if (path === loaded.path && next === mtime) return loaded
    mtime = next

    if (!Number.isFinite(next)) {
      if (loaded.state !== "missing") console.error(`letmework: ${path} disappeared, staying idle`)
      loaded = { state: "missing", path, config: DEFAULT_CONFIG }
      return loaded
    }

    try {
      const config = parseConfig(readFileSync(path, "utf8"))
      loaded = { state: "active", path, config }
      console.error(
        `letmework: loaded ${path} (wait ${config.waitseconds}s, suffix "${config.suffix}", ` +
          `${config.extraFolders.length} extra folder(s), ${config.createAndUse.length} create-and-use folder(s), ` +
          `notice ${config.notice})`,
      )
    } catch (error) {
      console.error(`letmework: cannot read ${path}, staying idle`, error)
      loaded = { state: "invalid", path, config: DEFAULT_CONFIG }
    }

    return loaded
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
    const paths = configCandidates((ctx.options as { config?: unknown } | undefined)?.config)
    const load = configLoader(paths)
    const examplePath = join(pluginDirectory(), EXAMPLE_FILE)

    const start = load()
    if (start.state !== "active") {
      console.error(
        `letmework: idle, no usable config (${start.state}: ${start.path}). ` +
          `Copy ${examplePath} there to enable it.`,
      )
    }

    const controller = new AbortController()
    const seen = new Set<string>()
    const noticeShown = new Set<string>()

    /**
     * Delivers a one-time note into the session. This is the only surface a
     * server plugin has for talking to the user, and it lands right where the
     * prompt that just vanished was.
     */
    const notice = async (key: string, sessionID: string, text: string) => {
      if (noticeShown.has(key)) return
      noticeShown.add(key)
      try {
        const seenBefore = await ctx.storage.get(NOTICE_KEY)
        if (seenBefore === key) return
        await ctx.session.synthetic({ sessionID, text, description: "letmework" })
        await ctx.storage.set(NOTICE_KEY, key)
      } catch (error) {
        console.error("letmework: could not show the onboarding notice", error)
      }
    }

    const approve = async (request: PermissionAsked) => {
      const label = `${request.action} ${request.resources.join(", ")}`
      const loaded = load()

      if (loaded.state !== "active") {
        const config = loaded.config
        if (config.notice !== "off") {
          void notice(
            "inactive",
            request.sessionID,
            inactiveNotice({
              configPath: loaded.path,
              examplePath,
              platform: process.platform,
              reason: loaded.state === "invalid" ? `${loaded.path} could not be read` : `${loaded.path} not found`,
            }),
          )
        }
        console.error(`letmework: idle (${loaded.state}), leaving ${label} to the user`)
        return
      }

      const decision = evaluate({
        cwd,
        isGitRepo: isGitRepository(cwd),
        config: loaded.config,
        request,
      })

      if (!decision.allow) {
        console.error(`letmework: asking for ${label} (${decision.reason})`)
        return
      }

      // The prompt is already visible. Leave it up for a moment so a user who is
      // watching can still reject it before we answer for them. The reply is
      // saved, so later requests for the same folder do not prompt at all.
      const current = loaded.config
      const wait = current.waitseconds
      console.error(
        `letmework: auto-approving ${label} in ${wait}s (${decision.reason}, ${current.decision})`,
      )
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
          decision: current.decision,
        })
      } catch (error) {
        console.error(`letmework: could not auto-approve ${label}`, error)
        return
      }

      if (current.notice !== "off") {
        void notice(
          "active",
          request.sessionID,
          activeNotice({ label, reason: decision.reason, config: current, configPath: loaded.path }),
        )
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
