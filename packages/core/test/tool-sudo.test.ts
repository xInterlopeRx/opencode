import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { SudoRuntime } from "@opencode-ai/core/sudo-runtime"
import { SudoTool } from "@opencode-ai/core/tool/sudo"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_sudo_tool_test")
const it = testEffect(Layer.empty)

const withTool = <A, E, R>(
  directory: string,
  binary: string,
  localTui: boolean,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const runtime = Layer.mergeAll(
    Layer.succeed(SudoRuntime.LocalTui)(localTui),
    Layer.succeed(SudoRuntime.Binary)(binary),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, EventV2.node, QuestionV2.node, SudoTool.node]),
        [
          [Location.node, activeLocation],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ).pipe(Layer.provideMerge(runtime)),
    ),
  )
}

describe("SudoTool", () => {
  it.live("is local-TUI-only and keeps the entered password out of events and tool output", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const binary = path.join(tmp.path, "sudo")
          yield* Effect.promise(() =>
            fs.writeFile(
              binary,
              `#!/bin/sh
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
printf '%s' "$prompt" >&2
IFS= read -r password
if [ "$password" != "sudo-test-canary" ]; then exit 1; fi
exec "$@"
`,
              { mode: 0o700 },
            ),
          )

          const disabled = yield* withTool(tmp.path, binary, false, toolDefinitions)
          expect(disabled).toEqual([])

          const result = yield* withTool(tmp.path, binary, true, (registry) =>
            Effect.gen(function* () {
              const questions = yield* QuestionV2.Service
              const events = yield* EventV2.Service
              const requests = yield* Queue.unbounded<QuestionV2.Request>()
              const published: EventV2.Payload[] = []
              const unsubscribe = yield* events.listen((event) =>
                Effect.gen(function* () {
                  if (event.type === QuestionV2.Event.Asked.type) {
                    yield* Queue.offer(requests, event.data as QuestionV2.Request)
                  }
                  if (event.type.startsWith("question.v2.")) published.push(event)
                }),
              )
              yield* Effect.addFinalizer(() => unsubscribe)

              const fiber = yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "call-sudo",
                  name: "sudo",
                  input: { command: "printf approved" },
                },
              }).pipe(Effect.forkScoped)
              const approval = yield* Queue.take(requests)
              expect(approval.sensitive).toBeUndefined()
              yield* questions.reply({ requestID: approval.id, answers: [["Run once"]] })

              const secret = yield* Queue.take(requests)
              expect(secret.sensitive).toBe(true)
              yield* questions.reply({ requestID: secret.id, answers: [["sudo-test-canary"]] })

              const settled = yield* Fiber.join(fiber)
              expect(JSON.stringify(published)).not.toContain("sudo-test-canary")
              expect(JSON.stringify(settled)).not.toContain("sudo-test-canary")
              expect(JSON.stringify(settled)).toContain("approved")
              return settled
            }),
          )

          expect(JSON.stringify(result)).toContain("approved")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
