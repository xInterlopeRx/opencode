export * as SudoRuntime from "./sudo-runtime"

import { Context } from "effect"

export const LocalTui = Context.Reference<boolean>("@opencode/SudoRuntime/LocalTui", {
  defaultValue: () => false,
})

export const Binary = Context.Reference<string>("@opencode/SudoRuntime/Binary", {
  defaultValue: () => "/usr/bin/sudo",
})
