import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { definePlugin } from "./define.ts"

type Definition = Parameters<typeof definePlugin>[0]

test("definePlugin returns its argument unchanged", () => {
  const plugin = { id: "letmework", setup: async () => () => {} } as unknown as Definition
  assert.equal(definePlugin(plugin), plugin, "the shim must be an identity function")

  const other = { id: "another" } as unknown as Definition
  assert.equal(definePlugin(other), other)
  assert.notEqual(definePlugin(other), plugin)
})

test("the package declares no runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  assert.equal(manifest.dependencies, undefined, "nothing may be installed at runtime")
  assert.equal(manifest.peerDependencies, undefined, "a peer dependency would be installed too")
})
