#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SpawnOptions } from "node:child_process"
import spawn from "cross-spawn"
import mri from "mri"
import * as p from "@clack/prompts"
import pc from "picocolors"
import {
  type Framework,
  FRAMEWORKS,
  FRAMEWORK_DEPS,
  FRAMEWORK_INDEX,
  FRAMEWORK_LABELS,
} from "./frameworks.js"
import { type PkgManager, PKG_MANAGERS } from "./pkg-managers.js"

type Argv = mri.Argv<{ framework?: string; pm?: string; verbose?: boolean }>

const PRIMARY: [number, number, number] = [251, 146, 60]
const SECONDARY: [number, number, number] = [236, 72, 153]
const THEME: [number, number, number][] = [PRIMARY, SECONDARY]

/** Resolved options coming from the CLI or user prompts. */
type Options = {
  projectName: string
  framework: Framework
  pkgManager: PkgManager
  verbose: boolean
}

/** Creates a colored gradient text effect */
function gradient(
  text: string,
  stops: [number, number, number][],
  whiteRange?: [number, number],
): string {
  const chars = [...text]
  return (
    chars
      .map((char, i) => {
        if (whiteRange && i >= whiteRange[0] && i < whiteRange[1])
          return `\x1b[38;2;255;255;255m${char}`
        const t = chars.length === 1 ? 0 : i / (chars.length - 1)
        const seg = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2)
        const segT = t * (stops.length - 1) - seg
        const [r1, g1, b1] = stops[seg]
        const [r2, g2, b2] = stops[seg + 1]
        const r = Math.round(r1 + (r2 - r1) * segT)
        const g = Math.round(g1 + (g2 - g1) * segT)
        const b = Math.round(b1 + (b2 - b1) * segT)
        return `\x1b[38;2;${r};${g};${b}m${char}`
      })
      .join("") + "\x1b[0m"
  )
}

/** Detects the package manager used to invoke the CLI via npm_config_user_agent. */
function detectPkgManager(): PkgManager {
  const ua: string = process.env.npm_config_user_agent ?? ""
  for (const pm of PKG_MANAGERS) {
    if (ua.startsWith(pm)) return pm
  }
  return "npm"
}

/** Builds the install/add command args for the given package manager. */
function addArgs(pkgManager: PkgManager, packages: string[], dev: boolean): string[] {
  const cmd = pkgManager === "npm" ? "install" : "add"
  const devFlag: Record<string, string> = {
    npm: "--save-dev",
    pnpm: "-D",
    yarn: "--dev",
    bun: "-d",
  }
  return dev ? [cmd, devFlag[pkgManager] ?? "--save-dev", ...packages] : [cmd, ...packages]
}

/** Runs a command asynchronously, exiting the process if it fails. */
function run(cmd: string, args: string[], opts?: SpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const result = spawn(cmd, args, { stdio: "ignore", ...opts })
    result.on("error", reject)
    result.on("close", (code) => {
      if (code !== 0) {
        p.cancel(`${cmd} ${args.join(" ")} failed with exit code ${code}`)
        process.exit(code ?? 1)
      }
      resolve()
    })
  })
}

/** Recursively copies a directory, renaming _gitignore → .gitignore (npm strips dotfiles during publish). */
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const srcPath: string = path.join(src, entry)
    const destName: string = entry === "_gitignore" ? ".gitignore" : entry
    const destPath: string = path.join(dest, destName)

    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/** Returns true if a directory doesn't exist or contains only a .git folder. */
function isEmpty(dir: string): boolean {
  if (!fs.existsSync(dir)) return true
  const files = fs.readdirSync(dir)
  return files.length === 0 || (files.length === 1 && files[0] === ".git")
}

/** Resolves the project name from the CLI arg or prompts the user. */
async function resolveProjectName(fromArg: string | undefined): Promise<string> {
  if (fromArg) return fromArg

  const answer = await p.text({
    message: "Project name:",
    placeholder: "rigg-project",
    defaultValue: "rigg-project",
  })

  if (p.isCancel(answer)) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  return answer || "rigg-project"
}

/** Resolves the framework from the --framework flag or prompts the user. */
async function resolveFramework(fromArg: string | undefined): Promise<Framework> {
  if (fromArg && FRAMEWORK_DEPS[fromArg as Framework]) return fromArg as Framework

  const answer = await p.select<Framework>({
    message: "Backend framework:",
    options: FRAMEWORKS,
    initialValue: "none",
  })

  if (p.isCancel(answer)) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  return answer
}

/** Asks the user to confirm before wiping a non-empty target directory. */
async function confirmOverwrite(projectName: string, targetDir: string): Promise<void> {
  if (isEmpty(targetDir)) return

  const overwrite = await p.confirm({
    message: `${pc.white(projectName)} is not empty. Remove existing files and continue?`,
    initialValue: false,
  })

  if (p.isCancel(overwrite) || !overwrite) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  const spin = p.spinner()
  spin.start("Removing existing files...")
  await fs.promises.rm(targetDir, { recursive: true, force: true })
  spin.stop("Removed existing files")
}

/** Copies the base template, sets the package name, and writes the framework starter code. */
async function scaffoldFiles(options: Options, targetDir: string) {
  const spin = p.spinner()
  spin.start("Generating project...")

  /** Copy the base template to the target directory. */
  const directory: string = path.dirname(fileURLToPath(import.meta.url))
  copyDir(path.join(directory, "..", "template"), targetDir)

  /** Set the package name in the package.json file. */
  const pkgJsonPath: string = path.join(targetDir, "package.json")
  const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
  pkg.name = options.projectName
  if (options.pkgManager === "npm") pkg.allowScripts = { esbuild: true } // npm 12+
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n")

  // pnpm 10+ and npm 12+ block post-install scripts by default; esbuild needs one to fetch its native binary
  if (options.pkgManager === "pnpm") {
    fs.writeFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "allowBuilds:\n  esbuild: true\n")
  }

  /** Replace the placeholder project name in README.md. */
  const readmePath: string = path.join(targetDir, "README.md")
  const readme: string = fs.readFileSync(readmePath, "utf-8")
  fs.writeFileSync(readmePath, readme.replaceAll("{{project_name}}", options.projectName))

  /** Create the src directory and write the framework starter code. */
  fs.mkdirSync(path.join(targetDir, "src"), { recursive: true })
  fs.writeFileSync(path.join(targetDir, "src", "index.ts"), FRAMEWORK_INDEX[options.framework])

  spin.stop("Project generated")
}

/** Installs shared dev dependencies and any framework-specific packages. */
async function installDependencies(options: Options, targetDir: string) {
  const { pkgManager, framework, verbose } = options
  const stdio = verbose ? "inherit" : "ignore"
  const depSpin = p.spinner()
  depSpin.start(`Installing dependencies with ${gradient(pkgManager, THEME)}...`)

  await run(
    pkgManager,
    addArgs(
      pkgManager,
      ["@types/node", "oxfmt", "oxlint", "tsdown", "tsx", "typescript", "vitest"],
      true,
    ),
    { cwd: targetDir, stdio },
  )

  depSpin.stop(`Dependencies installed with ${gradient(pkgManager, THEME)}`)

  if (framework !== "none") {
    const frameworkName: string = FRAMEWORK_LABELS[framework]

    const frameworkSpin = p.spinner()
    frameworkSpin.start(`Installing ${gradient(frameworkName, THEME)}...`)

    const { deps, devDeps } = FRAMEWORK_DEPS[framework]
    if (deps.length > 0)
      await run(pkgManager, addArgs(pkgManager, deps, false), { cwd: targetDir, stdio })
    if (devDeps.length > 0)
      await run(pkgManager, addArgs(pkgManager, devDeps, true), { cwd: targetDir, stdio })

    frameworkSpin.stop(`${gradient(frameworkName, THEME)} installed`)
  }
}

/** Prints the gradient intro. */
function showIntro() {
  console.log("")

  p.intro(
    pc.bold(
      gradient(
        "rigg - Node.js projects with a modern toolchain",
        [[255, 255, 255], ...THEME],
        [0, 6],
      ),
    ),
  )
}

/** Prints the gradient outro with next steps. */
function showOutro(options: Options) {
  const { projectName, framework, pkgManager } = options
  const frameworkLabel = FRAMEWORK_LABELS[framework]
  const text =
    frameworkLabel !== "None"
      ? `Created ${projectName} with ${frameworkLabel}`
      : `Created ${projectName}`
  const title = gradient(text, THEME, ["Created ".length, "Created ".length + projectName.length])
  const devCmd = pkgManager === "npm" ? "npm run dev" : `${pkgManager} dev`
  p.outro(`${title}\n\n  ${pc.dim("Now run:")}\n  cd ${projectName}\n  ${devCmd}`)
}

/**
 * Resolves options either from CLI args or user prompts.
 */
async function resolveOptions(argv: Argv): Promise<Options> {
  const projectName: string = await resolveProjectName(argv._[0] as string | undefined)
  await confirmOverwrite(projectName, path.resolve(process.cwd(), projectName))

  const framework: Framework = await resolveFramework(argv.framework)
  const pkgManager: PkgManager = (argv.pm as PkgManager) || detectPkgManager()
  const verbose: boolean = argv.verbose ?? false

  return {
    projectName,
    framework,
    pkgManager,
    verbose,
  }
}

/** Initializes a git repository in targetDir, unless git is missing or targetDir is already inside one. */
async function initializeGit(options: Options, targetDir: string) {
  const git = spawn.sync("git", ["--version"], { stdio: "ignore" })
  if (git.error || git.status !== 0) {
    p.log.info("Git not found. Skipping repository initialization.")
    return
  }

  // Skip init if targetDir is already inside a git work tree (e.g. scaffolding into a monorepo)
  const insideWorkTree = spawn.sync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: targetDir,
    stdio: "ignore",
  })
  if (insideWorkTree.status === 0) {
    p.log.info("Already inside a git repository. Skipping git init.")
    return
  }

  const spin = p.spinner()
  spin.start("Initializing git repository...")
  const stdio = options.verbose ? "inherit" : "ignore"
  await run("git", ["init", "-b", "main"], { cwd: targetDir, stdio })
  spin.stop("Git repository initialized")
}

/**
 * Creates oxlint+oxfmt configuration files and formats the code.
 */
async function formatCode(options: Options, targetDir: string) {
  const { pkgManager, verbose } = options
  const stdio = verbose ? "inherit" : "ignore"
  const execCmd = pkgManager === "bun" ? "x" : "exec"
  const sep = pkgManager === "npm" || pkgManager === "yarn" ? ["--"] : []

  const spin = p.spinner()
  spin.start("Formatting code...")
  await run(pkgManager, [execCmd, "oxlint", ...sep, "--init"], { cwd: targetDir, stdio })
  await run(pkgManager, [execCmd, "oxfmt", ...sep, "--init"], { cwd: targetDir, stdio })
  await run(pkgManager, [execCmd, "oxfmt", ...sep, "."], { cwd: targetDir, stdio })
  spin.stop("Code formatted")
}

async function main(): Promise<void> {
  // Parse CLI arguments
  const argv: Argv = mri(process.argv.slice(2), {
    string: ["framework", "pm"],
    boolean: ["verbose"],
    alias: { f: "framework", v: "verbose" },
  })

  showIntro()

  // Get options either from CLI or user prompts
  const options: Options = await resolveOptions(argv)
  const targetDir: string = path.resolve(process.cwd(), options.projectName)

  await scaffoldFiles(options, targetDir)
  await initializeGit(options, targetDir)
  await installDependencies(options, targetDir)
  await formatCode(options, targetDir)

  showOutro(options)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
