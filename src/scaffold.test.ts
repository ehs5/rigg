import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PKG_MANAGERS } from "./pkg-managers.js"

const CLI = path.resolve(import.meta.dirname, "index.ts")
const TIMEOUT = 60 * 1000

function hasBin(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0
}

function scaffold(pm: string, tmpDir: string): ReturnType<typeof spawnSync> {
  return spawnSync("tsx", [CLI, "test-project", "--framework", "none", "--pm", pm], {
    cwd: tmpDir,
    timeout: TIMEOUT,
    encoding: "utf-8",
  })
}

describe("scaffolder", () => {
  for (const pm of PKG_MANAGERS) {
    it.skipIf(!hasBin(pm))(`creates project with ${pm}`, { timeout: TIMEOUT }, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigg-test-"))
      try {
        const result = scaffold(pm, tmpDir)
        expect(result.status, result.stderr as string).toBe(0)

        const projectDir = path.join(tmpDir, "test-project")
        expect(fs.existsSync(path.join(projectDir, "src", "index.ts"))).toBe(true)
        expect(fs.existsSync(path.join(projectDir, "test", "index.test.ts"))).toBe(true)
        expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true)

        const pkg = JSON.parse(
          fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"),
        ) as Record<string, unknown>
        expect(pkg.name).toBe("test-project")
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  }

  // git-init skipping happens before any package manager is invoked, so testing with one is enough
  const pm = PKG_MANAGERS.find(hasBin) ?? "npm"

  it.skipIf(!hasBin(pm))(
    "skips git init when scaffolding inside an existing git repo",
    { timeout: TIMEOUT },
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigg-test-"))
      try {
        spawnSync("git", ["init", "-b", "main"], { cwd: tmpDir })

        const result = scaffold(pm, tmpDir)
        expect(result.status, result.stderr as string).toBe(0)

        const projectDir = path.join(tmpDir, "test-project")
        expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true)
        expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(false)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!hasBin(pm))(
    "ignores dist and node_modules in the generated lint/format configs",
    { timeout: TIMEOUT },
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigg-test-"))
      try {
        const result = scaffold(pm, tmpDir)
        expect(result.status, result.stderr as string).toBe(0)

        const projectDir = path.join(tmpDir, "test-project")
        const oxlintConfig = JSON.parse(
          fs.readFileSync(path.join(projectDir, ".oxlintrc.json"), "utf-8"),
        ) as Record<string, unknown>
        const oxfmtConfig = JSON.parse(
          fs.readFileSync(path.join(projectDir, ".oxfmtrc.json"), "utf-8"),
        ) as Record<string, unknown>

        expect(oxlintConfig.ignorePatterns).toEqual(["dist", "node_modules"])
        expect(oxfmtConfig.ignorePatterns).toEqual(["dist", "node_modules"])
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )
})
