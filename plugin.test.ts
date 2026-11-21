import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import plugin, { MAX_PENDING } from "./index.ts"

/** The plugin context type, taken from the setup signature we already have. */
type Context = Parameters<typeof plugin.setup>[0]

function workspace(config: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "letmework-"))
  const project = join(root, "myProject")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(root, "myProject-wt"), { recursive: true })
  if (config !== undefined) writeFileSync(join(project, "config.yaml"), config)
  return project
}

type Reply = { sessionID: string; requestID: string; decision: string }

type Harness = {
  ctx: Context
  replies: Reply[]
  notices: string[]
  config: string
  directory: string
}

function harness(options: {
  config: string
  directory: string
  request: { id: string; sessionID: string; action: string; resources: string[] }
  pending: readonly { id: string }[]
  requests?: readonly { id: string; sessionID: string; action: string; resources: string[] }[]
}): Harness {
  const replies: Reply[] = []
  const notices: string[] = []
  const storage = new Map<string, unknown>()
  const requests = options.requests ?? [options.request]
  const ctx = {
    location: { directory: options.directory },
    options: { config: options.config },
    event: {
      subscribe: () =>
        (async function* () {
          for (const request of requests) yield { type: "permission.asked", data: request }
        })(),
    },
    permission: {
      list: async () => options.pending,
      reply: async (input: Reply) => {
        replies.push(input)
      },
    },
    session: {
      synthetic: async (input: { text: string }) => {
        notices.push(input.text)
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
  } as unknown as Context
  return { ctx, replies, notices, config: options.config, directory: options.directory }
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

test("explains the auto-approval once, so the user learns the plugin is active", async () => {
  const directory = workspace("waitseconds: 0\n")
  const first = {
    id: "per_10",
    sessionID: "ses_10",
    action: "edit",
    resources: [join(directory + "-wt", "a.ts")],
  }
  const second = { ...first, id: "per_11", resources: [join(directory + "-wt", "b.ts")] }
  const { ctx, replies, notices } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request: first,
    requests: [first, second],
    pending: [{ id: first.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(120)
  await cleanup?.()

  assert.equal(replies.length, 1, "only the first request is still pending")
  assert.equal(notices.length, 1, "the notice must not repeat")
  assert.match(notices[0]!, /limited YOLO mode/)
  assert.match(notices[0]!, new RegExp(join(directory, "config.yaml").replaceAll("\\", "\\\\")))
})

test("stays inert without a config file and says so", async () => {
  const directory = workspace(undefined)
  const request = {
    id: "per_12",
    sessionID: "ses_12",
    action: "edit",
    resources: [join(directory + "-wt", "a.ts")],
  }
  const missing = join(directory, "nowhere", "config.yaml")
  const { ctx, replies, notices } = harness({
    config: missing,
    directory,
    request,
    pending: [{ id: request.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(80)
  await cleanup?.()

  assert.equal(replies.length, 0, "no config means no auto-approval")
  assert.equal(notices.length, 1)
  assert.match(notices[0]!, /installed but idle/)
  assert.match(notices[0]!, /Copy-Item|cp "/)
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
  const { ctx, replies, notices } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request,
    pending: [{ id: request.id }],
  })

  const cleanup = await plugin.setup(ctx)
  await delay(60)
  await cleanup?.()

  assert.equal(replies.length, 0)
  assert.equal(notices.length, 0, "a kept prompt needs no explanation")
})

test("a malformed permission event is dropped instead of rejecting", async () => {
  const directory = workspace("waitseconds: 0\n")
  const malformed = [
    { id: "per_bad_1", sessionID: "ses_1" },
    { id: "per_bad_2", sessionID: "ses_2", action: "edit", resources: [1, 2] },
  ] as unknown as { id: string; sessionID: string; action: string; resources: string[] }[]

  const rejected: unknown[] = []
  const onRejection = (reason: unknown) => {
    rejected.push(reason)
  }
  process.on("unhandledRejection", onRejection)

  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request: malformed[0]!,
    requests: malformed,
    pending: malformed.map((request) => ({ id: request.id })),
  })

  const cleanup = await plugin.setup(ctx)
  await delay(80)
  await cleanup?.()
  process.off("unhandledRejection", onRejection)

  assert.deepEqual(rejected, [], "nothing may escape as an unhandled rejection")
  assert.equal(replies.length, 0, "a malformed request is left to the user")
})

test("a burst of prompts is capped instead of piling up", async () => {
  const directory = workspace("waitseconds: 0.3\n")
  const requests = Array.from({ length: MAX_PENDING + 2 }, (_, index) => ({
    id: `per_burst_${index}`,
    sessionID: "ses_burst",
    action: "edit",
    resources: [join(directory + "-wt", "a.ts")],
  }))

  const { ctx, replies } = harness({
    config: join(directory, "config.yaml"),
    directory,
    request: requests[0]!,
    requests,
    pending: requests.map((request) => ({ id: request.id })),
  })

  const cleanup = await plugin.setup(ctx)
  await delay(600)
  await cleanup?.()

  assert.equal(replies.length, MAX_PENDING)
})
