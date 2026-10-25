export * as SudoTool from "./sudo"

import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { randomUUID } from "node:crypto"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { QuestionV2 } from "../question"
import { PositiveInt } from "../schema"
import { SudoGate } from "../sudo-gate"
import { SudoRuntime } from "../sudo-runtime"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const name = "sudo"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_CAPTURE_BYTES = 1024 * 1024
const PROMPT_TIMEOUT_MS = 2 * 60 * 1_000

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "One exact shell command to execute with sudo" }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}).` }),
})

const Output = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  output: Schema.String,
  timeout: Schema.Boolean.pipe(Schema.optional),
  truncated: Schema.Boolean,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Capture = {
  chunks: Uint8Array[]
  bytes: number
  truncated: boolean
}

const append = (capture: Capture, chunk: Uint8Array) => {
  const remaining = MAX_CAPTURE_BYTES - capture.bytes
  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining)
    capture.chunks.push(kept)
    capture.bytes += kept.length
  }
  if (chunk.length > remaining) capture.truncated = true
}

const text = (capture: Capture) => Buffer.concat(capture.chunks).toString("utf8")

const failure = (message: string) => Effect.fail(new ToolFailure({ message }))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* SudoRuntime.LocalTui) || process.platform === "win32") return

    const tools = yield* Tools.Service
    const appProcess = yield* AppProcess.Service
    const questions = yield* QuestionV2.Service
    const location = yield* Location.Service
    const sudoBinary = yield* SudoRuntime.Binary
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      TERM: process.env.TERM ?? "dumb",
      LANG: process.env.LANG ?? "C",
      LC_ALL: "C",
    }

    const execute = Effect.fn("SudoTool.execute")(function* (input: typeof Input.Type, context: Tool.Context) {
      if (!input.command.trim() || /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]|\p{Cf}/u.test(input.command)) {
        return yield* failure(
          "The sudo command must be non-empty and contain no control or invisible formatting characters.",
        )
      }

      // Hold the machine-wide slot before the approval prompt so a second tab
      // fails fast instead of stacking a parallel root prompt, and so a canceled
      // request has already consumed its admission. Released via ensuring below.
      const slot = yield* Effect.try({
        try: () => SudoGate.acquireSudoSlot(),
        catch: (error) =>
          new ToolFailure({
            message: error instanceof Error ? error.message : "Unable to acquire the machine-wide sudo slot.",
          }),
      })

      const attempt = Effect.gen(function* () {
        const source = { messageID: context.assistantMessageID, callID: context.toolCallID }
        const approval = yield* questions
          .ask({
            sessionID: context.sessionID,
            tool: source,
            questions: [
              {
                question: `Run this exact command with sudo?\n\n${input.command}`,
                header: "sudo",
                options: [{ label: "Run once", description: "Approve only this command." }],
                custom: false,
              },
            ],
          })
          .pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(PROMPT_TIMEOUT_MS),
              orElse: () => Effect.fail(new ToolFailure({ message: "Sudo approval timed out." })),
            }),
            Effect.catchTag("QuestionV2.RejectedError", () =>
              Effect.fail(new ToolFailure({ message: "Sudo command was not approved." })),
            ),
          )
        if (approval[0]?.[0] !== "Run once") return yield* failure("Sudo command was not approved.")

        const marker = `OPENCODE_SUDO_${randomUUID()}__`
        const targetCommand = `exec </dev/null\n${input.command}`
        const run = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* appProcess.spawn(
              ChildProcess.make(sudoBinary, ["-S", "-k", "-p", marker, "--", "/bin/sh", "-c", targetCommand], {
                cwd: location.directory,
                env,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                detached: true,
                forceKillAfter: Duration.seconds(3),
              }),
            )
            const stdout: Capture = { chunks: [], bytes: 0, truncated: false }
            const stderr: Capture = { chunks: [], bytes: 0, truncated: false }
            let markerTail = ""
            let promptCount = 0
            let rejectedPassword = false

            const stdoutFiber = yield* Effect.forkScoped(
              Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => append(stdout, chunk))),
            )
            const stderrFiber = yield* Effect.forkScoped(
              Stream.runForEach(
                handle.stderr,
                Effect.fnUntraced(function* (chunk) {
                  append(stderr, chunk)
                  const combined = markerTail + Buffer.from(chunk).toString("utf8")
                  markerTail = combined.slice(-Math.max(0, marker.length - 1))
                  const matches = combined.split(marker).length - 1
                  if (!matches) return
                  markerTail = ""
                  promptCount += matches
                  if (promptCount > 1) {
                    rejectedPassword = true
                    yield* handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void))
                    return
                  }

                  const password = yield* questions
                    .askSecret({
                      sessionID: context.sessionID,
                      tool: source,
                      question: {
                        question: `Enter the sudo password for this command:\n\n${input.command}`,
                        header: "sudo password",
                        options: [],
                        custom: false,
                      },
                    })
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: Duration.millis(PROMPT_TIMEOUT_MS),
                        orElse: () =>
                          handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(
                            Effect.catch(() => Effect.void),
                            Effect.andThen(Effect.fail(new ToolFailure({ message: "Sudo password entry timed out." }))),
                          ),
                      }),
                      Effect.catchTag("QuestionV2.RejectedError", () =>
                        handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(
                          Effect.catch(() => Effect.void),
                          Effect.andThen(
                            Effect.fail(new ToolFailure({ message: "Sudo password entry was cancelled." })),
                          ),
                        ),
                      ),
                    )
                  const line = Buffer.alloc(password.length + 1)
                  line.set(password)
                  line[line.length - 1] = 10
                  password.fill(0)
                  yield* Stream.run(Stream.make(line), handle.stdin).pipe(
                    Effect.ensuring(Effect.sync(() => line.fill(0))),
                  )
                }),
              ),
            )

            const completion = yield* Effect.raceFirst(
              handle.exitCode.pipe(Effect.map((exit) => ({ type: "exit" as const, exit }))),
              Effect.sleep(Duration.millis(input.timeout ?? DEFAULT_TIMEOUT_MS)).pipe(
                Effect.as({ type: "timeout" as const }),
              ),
            )
            if (completion.type === "timeout") {
              yield* handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void))
              yield* Fiber.interrupt(stdoutFiber)
              yield* Fiber.interrupt(stderrFiber)
            } else {
              yield* Fiber.join(stdoutFiber)
              yield* Fiber.join(stderrFiber)
            }

            if (rejectedPassword) return yield* failure("Sudo rejected the password; run the command again to retry.")
            const output = [text(stdout), text(stderr).replaceAll(marker, "")].filter(Boolean).join("\n") || "(no output)"
            return {
              ...(completion.type === "exit" ? { exit: Number(completion.exit) } : { timeout: true }),
              output,
              truncated: stdout.truncated || stderr.truncated,
              ...(promptCount > 0
                ? { warnings: ["The operating system may retain a short-lived sudo authentication timestamp."] }
                : {}),
            }
          }),
        )

        return yield* run.pipe(
          Effect.mapError((error) =>
            error instanceof ToolFailure
              ? error
              : new ToolFailure({ message: "Unable to run the approved sudo command." }),
          ),
        )
      })

      return yield* attempt.pipe(Effect.ensuring(Effect.sync(() => slot.release())))
    })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Run one command with sudo in the standard local OpenCode TUI using its in-process worker transport. Every call asks the user to approve the exact command; a masked password prompt appears only if sudo requests authentication. The password is not included in tool arguments, session history, logs, config, or events. This tool is unavailable in --mini, --port/--hostname, attached, browser, or serve modes. Commands do not receive stdin. The operating system may retain its normal short-lived sudo authentication timestamp. One root command runs machine-wide at a time: a request made while another tab holds the slot fails fast instead of queueing, and at most 3 root requests are admitted per rolling 5 minutes.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: [
                output.output,
                output.timeout ? "Command timed out." : `Command exited with code ${output.exit}.`,
                ...(output.warnings ?? []),
              ].join("\n\n"),
            },
          ],
          execute,
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/sudo",
  layer,
  deps: [ToolRegistry.node, AppProcess.node, QuestionV2.node, Location.node],
})
