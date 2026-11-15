import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import plugin from "./index.ts"

/** The plugin context type, taken from the setup signature we already have. */
type Context = Parameters<typeof plugin.setup>[0]

function workspace(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "letmework-"))
  const project = join(root, "myProject")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(root, "myProject-wt"), { recursive: true })
  writeFileSync(join(project, "config.yaml"), config)
  return project
}

type Reply = { sessionID: string; requestID: string; decision: string }

type Harness = {
  ctx: Context
  replies: Reply[]
  config: string
  directory: string
}

function harness(options: {
  config: string
  directory: string
  request: { id: string; sessionID: string; action: string; resources: string[] }
  pending: readonly { id: string }[]
}): Harness {
  const replies: Reply[] = []
  const ctx = {
    location: { directory: options.directory },
    options: { config: options.config },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: "permission.asked", data: options.request }
        })(),
    },
    permission: {
      list: async () => options.pending,
      reply: async (input: Reply) => {
        replies.push(input)
      },
    },
  } as unknown as Context
  return { ctx, replies, config: options.config, directory: options.directory }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

test("approves a work-folder request after the grace period", async () => {
  const directory = workspace("waitseconds: 0\n")
  const request = {
    id: "per_1",
    sessionID: "ses_1",
    action: "edit",
    resources: [join(directory + "-wt", "src", "a.ts")],
  }
  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request,
    pending: [{ id: request.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(60)
  await cleanup?.()

  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0], { sessionID: "ses_1", requestID: "per_1", decision: "always" })
})

test("keeps the user's answer when the request is no longer pending", async () => {
  const directory = workspace("waitseconds: 0\n")
  const request = {
    id: "per_2",
    sessionID: "ses_2",
    action: "edit",
    resources: [join(directory + "-wt", "a.ts")],
  }
  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request,
    pending: [],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(60)
  await cleanup?.()

  assert.equal(replies.length, 0)
})

test("waits out the configured delay", async () => {
  const directory = workspace("waitseconds: 0.3\n")
  const request = {
    id: "per_3",
    sessionID: "ses_3",
    action: "edit",
    resources: [join(directory + "-wt", "a.ts")],
  }
  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request,
    pending: [{ id: request.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(100)
  assert.equal(replies.length, 0, "must not answer before the grace period")
  await delay(400)
  await cleanup?.()

  assert.equal(replies.length, 1)
})

test("does nothing outside the work folder", async () => {
  const directory = workspace("waitseconds: 0\n")
  const request = {
    id: "per_4",
    sessionID: "ses_4",
    action: "edit",
    resources: [join(directory, "src", "a.ts")],
  }
  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request,
    pending: [{ id: request.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(60)
  await cleanup?.()

  assert.equal(replies.length, 0)
})
