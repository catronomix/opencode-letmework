import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_ACTIONS,
  allowedRoots,
  evaluate,
  isGitRepository,
  isInside,
  parseConfig,
  parseYaml,
  staticPrefix,
  type Config,
} from "./logic.ts"

const CWD = "C:\\GITHUB\\myProject"

function config(overrides: Partial<Config> = {}): Config {
  return {
    waitseconds: 5,
    suffix: "-wt",
    extraFolders: [],
    createAndUse: [],
    actions: [...DEFAULT_ACTIONS],
    decision: "always",
    ...overrides,
  }
}

function decide(action: string, resources: string[], overrides: Partial<Config> = {}, isGitRepo = true) {
  return evaluate({ cwd: CWD, isGitRepo, config: config(overrides), request: { action, resources } })
}

test("parseYaml reads scalars, lists, comments and quotes", () => {
  const parsed = parseYaml(
    [
      "# leading comment",
      "waitseconds: 5 # trailing comment",
      "suffix: '-wt'",
      "extra-folders:",
      "  - C:\\temp\\   # note",
      '  - "D:\\scratch"',
      "empty:",
      "inline: [a, b]",
    ].join("\n"),
  )

  assert.equal(parsed["waitseconds"], "5")
  assert.equal(parsed["suffix"], "-wt")
  assert.deepEqual(parsed["extra-folders"], ["C:\\temp\\", "D:\\scratch"])
  assert.deepEqual(parsed["empty"], [])
  assert.deepEqual(parsed["inline"], ["a", "b"])
})

test("parseConfig applies defaults and reads the documented keys", () => {
  const parsed = parseConfig(
    [
      "waitseconds: 2.5",
      "suffix: -wt",
      "extra-folders:",
      "  - C:\\temp\\",
      "create-and-use:",
      "  - C:\\Users\\me\\AppData\\Local\\Temp\\opencode",
    ].join("\n"),
  )

  assert.equal(parsed.waitseconds, 2.5)
  assert.equal(parsed.suffix, "-wt")
  assert.deepEqual(parsed.extraFolders, ["C:\\temp\\"])
  assert.deepEqual(parsed.createAndUse, ["C:\\Users\\me\\AppData\\Local\\Temp\\opencode"])
  assert.deepEqual(parsed.actions, DEFAULT_ACTIONS)
})

test("parseConfig falls back for missing or nonsense values", () => {
  const parsed = parseConfig("waitseconds: soon\nsuffix:\n")
  assert.equal(parsed.waitseconds, 5)
  assert.equal(parsed.suffix, "-wt")
  assert.deepEqual(parsed.actions, DEFAULT_ACTIONS)
})

test("parseConfig reads the decision mode and defaults to always", () => {
  assert.equal(parseConfig("decision: always\n").decision, "always")
  assert.equal(parseConfig("decision: once\n").decision, "once")
  assert.equal(parseConfig("decision: nonsense\n").decision, "always")
  assert.equal(parseConfig("").decision, "always")
})

test("isInside matches the folder and its children only when asked", () => {
  assert.equal(isInside("C:\\GITHUB\\myProject-wt", "C:\\GITHUB\\myProject-wt", true), true)
  assert.equal(isInside("C:\\GITHUB\\myProject-wt", "C:\\GITHUB\\myProject-wt", false), false)
  assert.equal(isInside("C:\\GITHUB\\myProject-wt\\src\\a.ts", "C:\\GITHUB\\myProject-wt", false), true)
  assert.equal(isInside("C:\\GITHUB\\myProject-wt2", "C:\\GITHUB\\myProject-wt", true), false)
  assert.equal(isInside("C:\\GITHUB\\myProject", "C:\\GITHUB\\myProject-wt", true), false)
  assert.equal(isInside("c:/github/MYPROJECT-WT/a.ts", "C:\\GITHUB\\myProject-wt", false), true)
})

test("isGitRepository walks up to the repository root", () => {
  const seen: string[] = []
  const exists = (path: string) => {
    seen.push(path)
    return path.toLowerCase().endsWith("myproject\\.git")
  }

  assert.equal(isGitRepository(CWD, exists), true)
  assert.equal(isGitRepository("C:\\GITHUB\\myProject\\src", exists), true)
  assert.equal(isGitRepository("C:\\GITHUB\\other\\src", exists), false)
  assert.ok(seen.length > 0)
})

test("sibling work folder and its subfolders are approved", () => {
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject-wt\\src\\a.ts"]).allow, true)
  assert.equal(decide("external_directory", ["C:\\GITHUB\\myProject-wt"]).allow, true)
  assert.equal(decide("read", ["c:/github/myproject-wt/README.md"]).allow, true)
})

test("a non-git session folder blocks everything", () => {
  const decision = decide("edit", ["C:\\GITHUB\\myProject-wt\\a.ts"], {}, false)
  assert.equal(decision.allow, false)
  assert.match(decision.reason, /not a git repository/)
})

test("sibling folders with another name, or the project itself, are not approved", () => {
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject-other\\a.ts"]).allow, false)
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject\\a.ts"]).allow, false)
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject-wt\\..\\secret.txt"]).allow, false)
})

test("every resource must be inside an allowed folder", () => {
  const decision = decide("edit", ["C:\\GITHUB\\myProject-wt\\a.ts", "C:\\Windows\\system.ini"])
  assert.equal(decision.allow, false)
  assert.match(decision.reason, /system\.ini/)
})

test("extra folders allow the folder itself and its subfolders", () => {
  const extra = { extraFolders: ["C:\\temp\\"] }
  assert.equal(decide("edit", ["C:\\temp\\a.txt"], extra).allow, true)
  assert.equal(decide("edit", ["C:\\temp\\deep\\a.txt"], extra).allow, true)
  assert.equal(decide("edit", ["C:\\temp2\\a.txt"], extra).allow, false)
})

test("create-and-use allows subfolders but not the folder itself", () => {
  const create = { createAndUse: ["C:\\Users\\me\\AppData\\Local\\Temp\\opencode"] }
  assert.equal(decide("edit", ["C:\\Users\\me\\AppData\\Local\\Temp\\opencode"], create).allow, false)
  assert.equal(decide("edit", ["C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\job-1\\a.ts"], create).allow, true)
})

test("glob resources are judged on their literal prefix", () => {
  assert.equal(staticPrefix("C:\\GITHUB\\myProject-wt\\**\\*.ts"), "C:\\GITHUB\\myProject-wt\\")
  assert.equal(staticPrefix("C:\\GITHUB\\myProject-wt\\a.ts"), "C:\\GITHUB\\myProject-wt\\a.ts")
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject-wt\\**\\*.ts"]).allow, true)
  assert.equal(decide("read", ["C:\\GITHUB\\myProject-wt\\*"]).allow, true)
  assert.equal(decide("read", ["C:\\GITHUB\\myProject-*\\a.ts"]).allow, false)
})

test("actions outside the allowlist always prompt", () => {
  assert.equal(decide("shell", ["C:\\GITHUB\\myProject-wt\\a.ts"]).allow, false)
  assert.equal(decide("edit", ["C:\\GITHUB\\myProject-wt\\a.ts"], { actions: ["read"] }).allow, false)
  assert.equal(decide("external_directory", ["C:\\temp\\a"], { extraFolders: ["C:\\temp"] }).allow, true)
})

test("empty resources are never auto-approved", () => {
  assert.equal(decide("edit", []).allow, false)
})

test("allowedRoots honours the configured suffix", () => {
  const roots = allowedRoots(CWD, config({ suffix: "-worktree", extraFolders: ["C:\\temp"] }))
  assert.equal(roots.length, 2)
  assert.match(roots[0]!.path.replaceAll("\\", "/").toLowerCase(), /myproject-worktree$/)
  assert.equal(roots[1]!.includeSelf, true)
})
