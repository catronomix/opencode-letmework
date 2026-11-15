import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

/**
 * Pure decision logic for opencode-letmework. No OpenCode imports, no side
 * effects beyond the injectable filesystem predicate, so it stays testable with
 * `node --test`.
 */

export type Config = {
  /** Seconds to wait before auto-approving, so a present user can intervene. */
  waitseconds: number
  /** Appended to the current folder's name to build the sibling work folder. */
  suffix: string
  /** Folders (and everything below them) that never need a prompt. */
  extraFolders: string[]
  /** Folders that may not be touched directly, but whose subfolders may. */
  createAndUse: string[]
  /** Permission actions eligible for auto-approval. */
  actions: string[]
  /** How an auto-approval is recorded: `always` saves it, `once` does not. */
  decision: Decision
}

export type Decision = "always" | "once"

export const DEFAULT_ACTIONS = ["read", "edit", "write", "external_directory"]

export const DEFAULT_CONFIG: Config = {
  waitseconds: 5,
  suffix: "-wt",
  extraFolders: [],
  createAndUse: [],
  actions: [...DEFAULT_ACTIONS],
  decision: "always",
}

export type PermissionRequest = {
  action: string
  resources: readonly string[]
}

export type Decision = {
  allow: boolean
  reason: string
}

/* ------------------------------------------------------------------ yaml --- */

type YamlValue = string | string[]

/** Strip a trailing `# comment` that is outside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]!
    const last = trimmed.at(-1)!
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1)
  }
  return trimmed
}

function inlineList(value: string): string[] | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined
  const inner = value.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(",").map((item) => unquote(item))
}

/**
 * Minimal YAML subset: `key: scalar`, `key:` followed by `- item` lines, and
 * `key: [a, b]`. Enough for a flat config, and deliberately dependency-free so
 * the plugin loads without a local `node_modules`.
 */
export function parseYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {}
  let current: string | undefined

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed === "-" || trimmed.startsWith("- ")) {
      if (!current) continue
      const item = unquote(trimmed.slice(1))
      const previous = out[current]
      if (Array.isArray(previous)) previous.push(item)
      else out[current] = [item]
      continue
    }

    const match = /^([\w.-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]!
    const rest = match[2]!.trim()
    current = key

    if (!rest) {
      out[key] = []
      continue
    }
    const list = inlineList(rest)
    out[key] = list ?? unquote(rest)
  }

  return out
}

function strings(value: YamlValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter((item) => item.length > 0)
  if (typeof value === "string" && value.trim()) return [value.trim()]
  return []
}

export function parseConfig(text: string): Config {
  const raw = parseYaml(text)

  const waitValue = raw["waitseconds"]
  const waitText = (Array.isArray(waitValue) ? (waitValue[0] ?? "") : (waitValue ?? "")).trim()
  const wait = waitText === "" ? Number.NaN : Number(waitText)
  const waitseconds = Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 600) : DEFAULT_CONFIG.waitseconds

  const suffixValue = raw["suffix"]
  const rawSuffix = (Array.isArray(suffixValue) ? (suffixValue[0] ?? "") : (suffixValue ?? "")).trim()
  const suffix = rawSuffix === "" ? DEFAULT_CONFIG.suffix : rawSuffix

  const actions = strings(raw["actions"]).map((action) => action.toLowerCase())

  const decisionValue = raw["decision"]
  const rawDecision = (Array.isArray(decisionValue) ? (decisionValue[0] ?? "") : (decisionValue ?? "")).trim().toLowerCase()
  const decision: Decision = rawDecision === "once" ? "once" : "always"

  return {
    waitseconds,
    suffix,
    extraFolders: strings(raw["extra-folders"]),
    createAndUse: strings(raw["create-and-use"]),
    actions: actions.length > 0 ? actions : [...DEFAULT_ACTIONS],
    decision,
  }
}

/* ------------------------------------------------------------------ paths --- */

const WINDOWS = process.platform === "win32"
const GLOB_CHAR = /[*?[{]/

export function normalizePath(input: string): string {
  let path = resolve(input).replaceAll("\\", "/").replace(/\/+$/, "")
  if (/^[a-z]:$/i.test(path)) path = `${path}/`
  if (!path) path = "/"
  return WINDOWS ? path.toLowerCase() : path
}

export function isInside(child: string, parent: string, includeSelf: boolean): boolean {
  const target = normalizePath(child)
  const root = normalizePath(parent)
  if (target === root) return includeSelf
  if (root.endsWith("/")) return target.startsWith(root)
  return target.startsWith(`${root}/`)
}

export function hasGlob(resource: string): boolean {
  return GLOB_CHAR.test(resource)
}

/**
 * Path part of a resource before the first glob character. Rules in OpenCode are
 * glob patterns, so containment is judged on that literal prefix; a wildcard can
 * still only expand below an allowed folder.
 */
export function staticPrefix(resource: string): string {
  const match = GLOB_CHAR.exec(resource)
  return match ? resource.slice(0, match.index) : resource
}

function escapes(resource: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(resource)
}

/* ---------------------------------------------------------------- checks --- */

export type Root = {
  path: string
  includeSelf: boolean
  label: string
}

export function allowedRoots(cwd: string, config: Config): Root[] {
  const roots: Root[] = []

  if (config.suffix.length > 0) {
    const sibling = join(dirname(resolve(cwd)), `${basename(resolve(cwd))}${config.suffix}`)
    roots.push({ path: sibling, includeSelf: true, label: `work folder ${sibling}` })
  }

  for (const folder of config.extraFolders) {
    roots.push({ path: resolve(cwd, folder), includeSelf: true, label: `extra folder ${folder}` })
  }

  // Direct access to the configured folder itself stays denied; the agent may
  // create subfolders inside it and work there.
  for (const folder of config.createAndUse) {
    roots.push({ path: resolve(cwd, folder), includeSelf: false, label: `create-and-use folder ${folder}` })
  }

  return roots
}

export function isGitRepository(cwd: string, exists: (path: string) => boolean = existsSync): boolean {
  let directory = resolve(cwd)
  for (;;) {
    if (exists(join(directory, ".git"))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * All checks must pass: the session folder is a git repository, the action is
 * eligible, and every resource lives inside an allowed folder.
 */
export function evaluate(input: {
  cwd: string
  isGitRepo: boolean
  config: Config
  request: PermissionRequest
}): Decision {
  const { cwd, isGitRepo, config, request } = input
  const action = request.action.toLowerCase()

  if (!config.actions.includes(action)) {
    return { allow: false, reason: `action "${request.action}" is not in actions` }
  }
  if (request.resources.length === 0) {
    return { allow: false, reason: "no resources" }
  }
  if (!isGitRepo) {
    return { allow: false, reason: `${cwd} is not a git repository` }
  }

  const roots = allowedRoots(cwd, config)
  if (roots.length === 0) {
    return { allow: false, reason: "no folders are allowlisted" }
  }

  const outside: string[] = []
  for (const resource of request.resources) {
    if (escapes(resource)) {
      outside.push(resource)
      continue
    }
    const prefix = staticPrefix(resource)
    const target = isAbsolute(prefix) ? prefix : join(cwd, prefix)
    const root = roots.find((candidate) => isInside(target, candidate.path, candidate.includeSelf))
    if (!root) outside.push(resource)
  }

  if (outside.length > 0) {
    return { allow: false, reason: `outside the allowed folders: ${outside.join(", ")}` }
  }

  return { allow: true, reason: "all targets are inside the allowed folders" }
}
