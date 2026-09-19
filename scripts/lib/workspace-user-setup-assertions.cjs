const fs = require("node:fs")
const path = require("node:path")

const [installPrefix, openCodePath, omoPath, fixture = "fresh"] = process.argv.slice(2)
if (installPrefix === undefined || openCodePath === undefined || omoPath === undefined) {
  throw new Error("usage: node workspace-user-setup-assertions.cjs INSTALL_PREFIX OPENCODE_CONFIG OMO_CONFIG [fresh|preserved]")
}
if (fixture !== "fresh" && fixture !== "preserved") throw new Error(`unknown fixture: ${fixture}`)

const parserPath = path.join(installPrefix, "lib", "node_modules", "jsonc-parser")
const { parse } = require(parserPath)

function parseJsonc(filePath) {
  const errors = []
  const value = parse(fs.readFileSync(filePath, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length !== 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid JSONC object: ${filePath}`)
  }
  return value
}

const expectedVersions = {
  "opencode-ai": "1.18.31",
  "oh-my-openagent": "4.19.4",
  "jsonc-parser": "3.3.1",
}
const versions = {}
for (const [name, expectedVersion] of Object.entries(expectedVersions)) {
  const packagePath = path.join(installPrefix, "lib", "node_modules", name, "package.json")
  const installedVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version
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
const omoOpenCode = omo["[opencode]"]
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
  if (openCode.theme !== "dim-smoke" || openCode.nested?.keep !== true) {
    throw new Error("unrelated OpenCode configuration was not preserved")
  }
  if (omo.unrelated?.keep !== true || omoOpenCode.channel !== "stable") {
    throw new Error("unrelated OMO configuration was not preserved")
  }
}

process.stdout.write(`${JSON.stringify({ versions, openCode, omo })}\n`)
