// @ts-check
const fs = require("node:fs")
const path = require("node:path")

const [installPrefix, openCodePath, omoPath, fixture = "fresh"] = process.argv.slice(2)
if (installPrefix === undefined || openCodePath === undefined || omoPath === undefined) {
  throw new Error("usage: node workspace-user-setup-assertions.cjs INSTALL_PREFIX OPENCODE_CONFIG OMO_CONFIG [fresh|preserved]")
}
if (fixture !== "fresh" && fixture !== "preserved") throw new Error(`unknown fixture: ${fixture}`)

const parserPath = path.join(installPrefix, "lib", "node_modules", "jsonc-parser")
/** @type {{parse: (contents: string, errors: unknown[], options: {allowTrailingComma: boolean, disallowComments: boolean}) => unknown}} */
const { parse } = require(parserPath)

/** @param {string} filePath @returns {Record<string, unknown>} */
function parseJsonc(filePath) {
  /** @type {unknown[]} */
  const errors = []
  const value = parse(fs.readFileSync(filePath, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length !== 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid JSONC object: ${filePath}`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

const expectedVersions = {
  "opencode-ai": "1.18.31",
  "oh-my-openagent": "4.19.4",
  "jsonc-parser": "3.3.1",
}
/** @type {Record<string, string>} */
const versions = {}
for (const [name, expectedVersion] of Object.entries(expectedVersions)) {
  const packagePath = path.join(installPrefix, "lib", "node_modules", name, "package.json")
  /** @type {unknown} */
  const installedPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  if (typeof installedPackage !== "object" || installedPackage === null || !("version" in installedPackage)) throw new Error("invalid installed package")
  const installedVersion = installedPackage.version
  if (installedVersion !== expectedVersion) {
    throw new Error(`${name} version ${installedVersion} did not equal ${expectedVersion}`)
  }
  versions[name] = installedVersion
}

const openCode = parseJsonc(openCodePath)
const expectedPlugins = fixture === "preserved"
  ? ["example-plugin@2.0.0", ["oh-my-openagent@4.19.4", { preserve: "plugin-options" }]]
  : ["oh-my-openagent@4.19.4"]
if (openCode.autoupdate !== false) throw new Error("OpenCode autoupdate was not disabled")
if (JSON.stringify(openCode.plugin) !== JSON.stringify(expectedPlugins)) {
  throw new Error(`unexpected OpenCode plugins: ${JSON.stringify(openCode.plugin)}`)
}

const omo = parseJsonc(omoPath)
const omoOpenCode = object(omo["[opencode]"])
const expectedTeamMode = fixture === "preserved"
  ? {
      label: "preserved",
      enabled: true,
      max_parallel_members: 4,
      max_members: 8,
      tmux_visualization: false,
    }
  : {
      enabled: true,
      max_parallel_members: 4,
      max_members: 8,
      tmux_visualization: false,
    }
if (omoOpenCode?.auto_update !== false) throw new Error("OMO OpenCode automatic updates were not disabled")
if (JSON.stringify(omoOpenCode.team_mode) !== JSON.stringify(expectedTeamMode)) {
  throw new Error(`unexpected Team Mode configuration: ${JSON.stringify(omoOpenCode.team_mode)}`)
}

if (fixture === "preserved") {
  if (openCode.theme !== "dim-smoke" || object(openCode.nested).keep !== true) {
    throw new Error("unrelated OpenCode configuration was not preserved")
  }
  if (object(omo.unrelated).keep !== true || omoOpenCode.channel !== "stable") {
    throw new Error("unrelated OMO configuration was not preserved")
  }
}

process.stdout.write(`${JSON.stringify({ versions, openCode, omo })}\n`)

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected configuration object")
  return /** @type {Record<string, unknown>} */ (value)
}
