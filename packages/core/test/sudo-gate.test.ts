import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { SudoGate } from "@opencode-ai/core/sudo-gate"
import { tmpdir } from "./fixture/tmpdir"

// The gate is exercised against real files in a temp directory (no mocks): the
// whole point of the module is machine-wide on-disk coordination.
afterEach(() => {
  delete process.env.OPENCODE_SUDO_GATE_DIR
})

async function gateDir() {
  const tmp = await tmpdir()
  process.env.OPENCODE_SUDO_GATE_DIR = tmp.path
  return tmp
}

function expectGateError(run: () => void): SudoGate.SudoGateError {
  try {
    run()
  } catch (error) {
    if (error instanceof SudoGate.SudoGateError) return error
    throw error
  }
  throw new Error("Expected SudoGateError")
}

describe("SudoGate", () => {
  test("fails fast while another request holds the slot, then admits after release", async () => {
    const tmp = await gateDir()
    try {
      const first = SudoGate.acquireSudoSlot()
      const error = expectGateError(() => SudoGate.acquireSudoSlot())
      expect(error.kind).toBe("busy")
      first.release()

      const second = SudoGate.acquireSudoSlot()
      second.release()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("admits at most three requests per rolling five minutes", async () => {
    const tmp = await gateDir()
    try {
      for (let index = 0; index < 3; index++) {
        SudoGate.acquireSudoSlot().release()
      }
      const error = expectGateError(() => SudoGate.acquireSudoSlot())
      expect(error.kind).toBe("rate-limited")
      expect(error.retryAfterMs).toBeGreaterThan(0)
      expect(error.message).toContain("3 root requests per rolling 5 minutes")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("reclaims a lock whose owning process is dead", async () => {
    const tmp = await gateDir()
    try {
      const dead = Bun.spawn(["/bin/sh", "-c", "exit 0"])
      await dead.exited
      await fs.writeFile(
        path.join(tmp.path, "active.lock"),
        JSON.stringify({ pid: dead.pid, startedAt: Date.now() }),
      )
      SudoGate.acquireSudoSlot().release()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("reclaims a lock older than thirty minutes even when the pid is alive", async () => {
    const tmp = await gateDir()
    try {
      await fs.writeFile(
        path.join(tmp.path, "active.lock"),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() - 31 * 60 * 1_000 }),
      )
      SudoGate.acquireSudoSlot().release()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("tolerates a corrupted admission window", async () => {
    const tmp = await gateDir()
    try {
      await fs.writeFile(path.join(tmp.path, "requests.json"), "{{{")
      SudoGate.acquireSudoSlot().release()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("does not release a lock held by someone else", async () => {
    const tmp = await gateDir()
    try {
      const mine = SudoGate.acquireSudoSlot()
      // Simulate a stale-reclaim race where another process replaced the lock.
      await fs.writeFile(
        path.join(tmp.path, "active.lock"),
        JSON.stringify({ pid: 4194300, startedAt: Date.now() }),
      )
      mine.release()
      const stillHeld = await fs.readFile(path.join(tmp.path, "active.lock"), "utf8")
      expect(JSON.parse(stillHeld).pid).toBe(4194300)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})
