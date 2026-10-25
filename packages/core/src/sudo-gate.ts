export * as SudoGate from "./sudo-gate"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Machine-wide admission policy for the sudo tool: one privileged command runs
// at a time across every OpenCode tab and process, and at most three root
// requests are admitted per rolling five-minute window. State lives in files
// so the policy holds across processes, not just within one server.
const WINDOW_MS = 5 * 60 * 1_000
const MAX_REQUESTS = 3
const STALE_MS = 30 * 60 * 1_000

export class SudoGateError extends Error {
  constructor(
    readonly kind: "busy" | "rate-limited",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "SudoGateError"
  }
}

export interface Slot {
  release: () => void
}

// Overridable for tests; the default is the shared OpenCode data directory.
const gateDir = () =>
  process.env.OPENCODE_SUDO_GATE_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "sudo-gate")

export function acquireSudoSlot(): Slot {
  const dir = gateDir()
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const recent = readWindow(dir).filter((time) => now - time < WINDOW_MS)
  if (recent.length >= MAX_REQUESTS) {
    const retry = recent[0]! + WINDOW_MS - now
    throw new SudoGateError(
      "rate-limited",
      `Sudo rate limit reached: at most ${MAX_REQUESTS} root requests per rolling 5 minutes. Retry in ${Math.ceil(retry / 1000)}s.`,
      retry,
    )
  }

  const lockPath = path.join(dir, "active.lock")
  claimLock(lockPath, now)
  try {
    recent.push(now)
    writeWindow(dir, recent)
  } catch (error) {
    // The lock is already held: release before rethrowing so a failed admission cannot leak the slot.
    releaseLock(lockPath, process.pid)
    throw error
  }
  // Admission is counted here, before the approval prompt: a request the user
  // then cancels still consumed one of the three slots in the window.
  return { release: () => releaseLock(lockPath, process.pid) }
}

function claimLock(lockPath: string, now: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: now }), { flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (!isStale(lockPath, now)) throw busy()
      fs.rmSync(lockPath, { force: true })
      continue
    }
    // Read-back after the write: a racing tab may have replaced the lock
    // between our stale reclaim and our create (unlink + O_EXCL is not atomic),
    // so only the creator whose pid survives verification keeps the slot.
    if (readLock(lockPath)?.pid === process.pid) return
    throw busy()
  }
  throw busy()
}

function busy() {
  return new SudoGateError(
    "busy",
    "Another sudo command is already in progress (possibly in another tab). The machine-wide slot frees once that command finishes; retry then.",
  )
}

function isStale(lockPath: string, now: number) {
  const lock = readLock(lockPath)
  // A lock whose contents cannot identify a holder is reclaimed rather than blocking forever.
  if (!lock) return true
  if (now - lock.startedAt > STALE_MS) return true
  return !alive(lock.pid)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLock(lockPath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; startedAt: number }
    if (typeof parsed?.pid !== "number" || typeof parsed?.startedAt !== "number") return undefined
    return parsed
  } catch {
    return undefined
  }
}

function readWindow(dir: string): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "requests.json"), "utf8"))
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : []
  } catch {
    // A corrupted window degrades to empty rather than failing the call.
    return []
  }
}

function writeWindow(dir: string, window: number[]) {
  const file = path.join(dir, "requests.json")
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(window))
  // Rename so concurrent readers never observe a half-written window.
  fs.renameSync(tmp, file)
}

function releaseLock(lockPath: string, pid: number) {
  try {
    if (readLock(lockPath)?.pid === pid) fs.rmSync(lockPath, { force: true })
  } catch {
    // Best-effort: a leftover lock is reclaimed by pid liveness or the stale window.
  }
}
