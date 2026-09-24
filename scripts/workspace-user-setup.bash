#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_VERSION="1.18.31"
readonly OMO_VERSION="4.19.4"
readonly JSONC_PARSER_VERSION="3.3.1"
readonly CODEX_VERSION="0.156.1"

fail() {
  printf 'workspace-user-setup: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found on PATH: $1"
}

require_command bash
require_command flock
require_command node
require_command npm

(( $# <= 1 )) || fail 'expected at most one tool selection argument'
selected_tool="${1:-opencode}"
case "$selected_tool" in
  opencode)
    selected_version="$OPENCODE_VERSION"
    selected_executable_name=opencode
    ;;
  codex)
    selected_version="$CODEX_VERSION"
    selected_executable_name=codex
    ;;
  *) fail "unsupported tool selection: $selected_tool" ;;
esac

[[ -n "${HOME:-}" ]] || fail 'HOME is not set'
[[ "$HOME" = /* ]] || fail "HOME must be an absolute path: $HOME"
[[ -d "$HOME" ]] || fail "HOME is not a directory: $HOME"
[[ -w "$HOME" ]] || fail "HOME is not writable: $HOME"

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
[[ "$config_home" = /* ]] || fail "XDG_CONFIG_HOME must be an absolute path: $config_home"
cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
[[ "$cache_home" = /* ]] || fail "XDG_CACHE_HOME must be an absolute path: $cache_home"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$data_home" = /* ]] || fail "XDG_DATA_HOME must be an absolute path: $data_home"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
[[ "$state_home" = /* ]] || fail "XDG_STATE_HOME must be an absolute path: $state_home"

canonical_home="$(node - "$HOME" <<'NODE'
const fs = require("node:fs")
const requestedHome = process.argv[2]
const home = fs.realpathSync(requestedHome)
if (home.includes("\n") || home.includes("\r")) throw new Error("HOME cannot contain newlines")
process.stdout.write(home)
NODE
)"

lock_path="$canonical_home/.workspace-user-setup.lock"
[[ ! -L "$lock_path" ]] || fail "unsafe workspace setup lock: $lock_path"
[[ ! -e "$lock_path" || -f "$lock_path" ]] || fail "unsafe workspace setup lock: $lock_path"
exec {setup_lock_fd}>"$lock_path"
flock -n "$setup_lock_fd" || fail 'workspace user setup is already running'
trap 'exit 130' HUP INT TERM

preflight_output="$(node - "$HOME" "$config_home" "$cache_home" "$data_home" "$state_home" "$selected_tool" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")

const requestedHome = process.argv[2]
const requestedConfigHome = process.argv[3]
const requestedCacheHome = process.argv[4]
const requestedDataHome = process.argv[5]
const requestedStateHome = process.argv[6]
const selectedTool = process.argv[7]
const home = fs.realpathSync(requestedHome)
const requestedHomeAbsolute = path.resolve(requestedHome)

function rebaseFromRequestedHome(candidate) {
  const absolute = path.resolve(candidate)
  const relative = path.relative(requestedHomeAbsolute, absolute)
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return path.join(home, relative)
  }
  return absolute
}

function isInsideHome(candidate) {
  const relative = path.relative(home, candidate)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function ensureDirectory(target, label) {
  const absolute = path.resolve(target)
  if (!isInsideHome(absolute)) throw new Error(`${label} escapes HOME lexically: ${target}`)
  const relative = path.relative(home, absolute)
  let current = home
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`${label} path component is not a directory: ${current}`)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      try {
        fs.mkdirSync(current, { mode: 0o700 })
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError
      }
    }
    const canonical = fs.realpathSync(current)
    if (!isInsideHome(canonical)) throw new Error(`${label} escapes canonical HOME: ${current}`)
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${current}`)
    current = canonical
  }
  return fs.realpathSync(current)
}

if (!path.isAbsolute(requestedConfigHome)) throw new Error(`XDG_CONFIG_HOME must be absolute: ${requestedConfigHome}`)
if (!path.isAbsolute(requestedCacheHome)) throw new Error(`XDG_CACHE_HOME must be absolute: ${requestedCacheHome}`)
if (!path.isAbsolute(requestedDataHome)) throw new Error(`XDG_DATA_HOME must be absolute: ${requestedDataHome}`)
if (!path.isAbsolute(requestedStateHome)) throw new Error(`XDG_STATE_HOME must be absolute: ${requestedStateHome}`)
for (const value of [home, requestedConfigHome, requestedCacheHome, requestedDataHome, requestedStateHome]) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("HOME and XDG home paths cannot contain newlines")
  }
}

const installPrefix = ensureDirectory(path.join(home, ".local"), "installation prefix")
ensureDirectory(path.join(installPrefix, "bin"), "npm executable directory")
const installLibrary = ensureDirectory(path.join(installPrefix, "lib"), "npm library directory")
ensureDirectory(path.join(installLibrary, "node_modules"), "npm package directory")
const toolLauncherDirectory = ensureDirectory(path.join(installPrefix, "libexec"), "tool launcher directory")
const toolStateDirectory = ensureDirectory(path.join(installPrefix, "state", "dim-project-tool"), "tool state directory")
const cacheHome = ensureDirectory(rebaseFromRequestedHome(requestedCacheHome), "XDG cache directory")
let omoDirectory = ""
let openCodeDirectory = ""
if (selectedTool === "opencode") {
  omoDirectory = ensureDirectory(path.join(home, ".omo"), "OMO configuration directory")
  const configHome = ensureDirectory(rebaseFromRequestedHome(requestedConfigHome), "XDG configuration directory")
  openCodeDirectory = ensureDirectory(path.join(configHome, "opencode"), "OpenCode configuration directory")
  const openCodeCache = ensureDirectory(path.join(cacheHome, "opencode"), "OpenCode cache directory")
  const packagesDirectory = ensureDirectory(path.join(openCodeCache, "packages"), "OpenCode package cache directory")
  const omoCacheCoordinate = path.join(packagesDirectory, "oh-my-openagent@4.19.4")
  try {
    const coordinateStat = fs.lstatSync(omoCacheCoordinate)
    if (coordinateStat.isSymbolicLink()) {
      throw new Error(`OMO cache coordinate must not be a symbolic link: ${omoCacheCoordinate}`)
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}
const dataHome = ensureDirectory(rebaseFromRequestedHome(requestedDataHome), "XDG data directory")
const stateHome = ensureDirectory(rebaseFromRequestedHome(requestedStateHome), "XDG state directory")
const npmStateDirectory = ensureDirectory(path.join(installPrefix, "share", "workspace-user-setup"), "npm state directory")
const npmCache = ensureDirectory(path.join(npmStateDirectory, "cache"), "npm cache directory")
const npmUserconfig = path.join(npmStateDirectory, "npmrc")
try {
  const npmUserconfigStat = fs.lstatSync(npmUserconfig)
  if (npmUserconfigStat.isSymbolicLink() || !npmUserconfigStat.isFile()) {
    throw new Error(`npm userconfig must be a regular file: ${npmUserconfig}`)
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}
process.stdout.write([
  home,
  installPrefix,
  omoDirectory,
  openCodeDirectory,
  cacheHome,
  dataHome,
  stateHome,
  npmCache,
  npmUserconfig,
  path.join(toolLauncherDirectory, "dim-project-tool-launch"),
  path.join(toolStateDirectory, "manifest.json"),
].join("\n"))
NODE
)"

mapfile -t setup_paths <<<"$preflight_output"
(( ${#setup_paths[@]} == 11 )) || fail 'internal path preflight returned an invalid result'
canonical_home="${setup_paths[0]}"
install_prefix="${setup_paths[1]}"
omo_dir="${setup_paths[2]}"
config_dir="${setup_paths[3]}"
cache_home="${setup_paths[4]}"
data_home="${setup_paths[5]}"
state_home="${setup_paths[6]}"
npm_cache="${setup_paths[7]}"
npm_userconfig="${setup_paths[8]}"
tool_launcher="${setup_paths[9]}"
tool_manifest="${setup_paths[10]}"

HOME="$canonical_home"
export HOME
export XDG_CACHE_HOME="$cache_home"
export XDG_DATA_HOME="$data_home"
export XDG_STATE_HOME="$state_home"
export NPM_CONFIG_USERCONFIG="$npm_userconfig"
export npm_config_userconfig="$npm_userconfig"
export NPM_CONFIG_CACHE="$npm_cache"
export npm_config_cache="$npm_cache"

if [[ "$selected_tool" = opencode ]]; then
  CI=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_YES=true \
  npm install --global --prefix "$install_prefix" --no-progress --loglevel=error \
    "opencode-ai@1.18.31" \
    "oh-my-openagent@4.19.4" \
    "jsonc-parser@3.3.1"
else
  CI=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_YES=true \
  npm install --global --prefix "$install_prefix" --no-progress --loglevel=error \
    "@openai/codex@0.156.1"
fi

if [[ "$selected_tool" = opencode ]]; then
  parser_path="$install_prefix/lib/node_modules/jsonc-parser"
  [[ -d "$parser_path" ]] || fail "JSONC parser installation is missing: $parser_path"

  node - "$parser_path" "$config_dir" "$omo_dir/omo.jsonc" <<'NODE'
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const parserPath = process.argv[2]
const configDir = process.argv[3]
const omoPath = process.argv[4]
const { applyEdits, modify, parse, printParseErrorCode } = require(parserPath)
const exactPlugin = "oh-my-openagent@4.19.4"

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function loadConfig(filePath) {
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`configuration must be a regular file: ${filePath}`)
    const source = fs.readFileSync(filePath, "utf8")
    const errors = []
    const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length > 0) {
      const details = errors.map(({ error, offset }) => `${printParseErrorCode(error)} at byte ${offset}`).join(", ")
      throw new Error(`malformed JSON/JSONC in ${filePath}: ${details}`)
    }
    if (!isObject(value)) throw new Error(`configuration root must be an object: ${filePath}`)
    return { filePath, source, value, mode: stat.mode & 0o777 }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    return { filePath, source: null, value: {}, mode: 0o600 }
  }
}

function setValue(source, propertyPath, value) {
  const input = source ?? "{}\n"
  const indentation = input.match(/\n([\t ]+)\S/)
  const formattingOptions = {
    insertSpaces: !indentation?.[1]?.includes("\t"),
    tabSize: indentation?.[1]?.includes("\t") ? 1 : (indentation?.[1]?.length || 2),
    eol: input.includes("\r\n") ? "\r\n" : "\n",
  }
  return applyEdits(input, modify(input, propertyPath, value, { formattingOptions }))
}

function isOmoPlugin(value) {
  return typeof value === "string" && /^(oh-my-openagent|oh-my-opencode)(@.*)?$/.test(value)
}

function normalizePluginSource(source, plugins, filePath) {
  if (plugins === undefined) return setValue(source, ["plugin"], [exactPlugin])
  if (!Array.isArray(plugins)) throw new Error(`OpenCode plugin must be an array: ${filePath}`)
  const matches = plugins
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isOmoPlugin(entry) || (Array.isArray(entry) && isOmoPlugin(entry[0])))
  if (matches.length === 0) return setValue(source, ["plugin", -1], exactPlugin)
  let output = Array.isArray(matches[0].entry)
    ? setValue(source, ["plugin", matches[0].index, 0], exactPlugin)
    : setValue(source, ["plugin", matches[0].index], exactPlugin)
  for (const { index } of matches.slice(1).reverse()) {
    output = setValue(output, ["plugin", index], undefined)
  }
  return output
}

const openCodeCandidates = ["opencode.jsonc", "opencode.json"]
const existingOpenCode = openCodeCandidates.filter((name) => fs.existsSync(path.join(configDir, name)))
const openCodeFiles = existingOpenCode.length > 0 ? existingOpenCode : ["opencode.json"]
const plans = []

for (const name of openCodeFiles) {
  const loaded = loadConfig(path.join(configDir, name))
  let output = normalizePluginSource(loaded.source, loaded.value.plugin, loaded.filePath)
  output = setValue(output, ["autoupdate"], false)
  plans.push({ ...loaded, output })
}

const omo = loadConfig(omoPath)
const openCodeNamespace = omo.value["[opencode]"]
if (openCodeNamespace !== undefined && !isObject(openCodeNamespace)) {
  throw new Error(`OMO [opencode] namespace must be an object: ${omoPath}`)
}
const teamMode = openCodeNamespace?.team_mode
if (teamMode !== undefined && !isObject(teamMode)) throw new Error(`OMO team_mode must be an object: ${omoPath}`)
let omoOutput = setValue(omo.source, ["[opencode]", "auto_update"], false)
for (const [key, value] of Object.entries({
  enabled: true,
  max_parallel_members: 4,
  max_members: 8,
  tmux_visualization: false,
})) {
  omoOutput = setValue(omoOutput, ["[opencode]", "team_mode", key], value)
}
plans.push({ ...omo, output: omoOutput })

const staged = []
function removeTemporary(temporaryPath) {
  try {
    fs.unlinkSync(temporaryPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

try {
  for (const plan of plans) {
    if (plan.output === plan.source) continue
    const temporaryPath = path.join(
      path.dirname(plan.filePath),
      `.${path.basename(plan.filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    )
    const descriptor = fs.openSync(temporaryPath, "wx", plan.mode)
    staged.push({ ...plan, temporaryPath })
    try {
      fs.writeFileSync(descriptor, plan.output, "utf8")
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }
  for (const plan of staged) {
    let current = null
    try {
      const stat = fs.lstatSync(plan.filePath)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`configuration changed to an unsafe file: ${plan.filePath}`)
      current = fs.readFileSync(plan.filePath, "utf8")
    } catch (readError) {
      if (readError?.code !== "ENOENT") throw readError
    }
    if (current !== plan.source) throw new Error(`configuration changed concurrently: ${plan.filePath}`)
    fs.renameSync(plan.temporaryPath, plan.filePath)
  }
} catch (error) {
  for (const { temporaryPath } of staged) removeTemporary(temporaryPath)
  throw error
}
NODE

fi

node - "$install_prefix" "$selected_tool" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const prefix = process.argv[2]
const selectedTool = process.argv[3]
const expected = selectedTool === "opencode"
  ? { "opencode-ai": "1.18.31", "oh-my-openagent": "4.19.4", "jsonc-parser": "3.3.1" }
  : { "@openai/codex": "0.156.1" }
for (const [name, version] of Object.entries(expected)) {
  const installed = JSON.parse(fs.readFileSync(path.join(prefix, "lib", "node_modules", name, "package.json"), "utf8")).version
  if (installed !== version) throw new Error(`expected ${name}@${version}, found ${installed}`)
}
NODE

node - "$tool_launcher" "$tool_manifest" "$install_prefix/bin/$selected_executable_name" \
  "$selected_tool" "$selected_version" <<'NODE'
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const launcherPath = process.argv[2]
const manifestPath = process.argv[3]
const executablePath = process.argv[4]
const selectedTool = process.argv[5]
const selectedVersion = process.argv[6]
const launcher = `#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'dim-project-tool-launch: %s\\n' "$*" >&2
  exit 1
}

(( $# >= 5 )) || fail 'expected CONTRACT_VERSION LAUNCHER TOOL VERSION EXECUTABLE [ARGS...]'
expected_contract_version="$1"
expected_launcher="$2"
expected_tool="$3"
expected_version="$4"
expected_executable="$5"
shift 5

[[ -n "\${HOME:-}" && "$HOME" = /* ]] || fail 'HOME must be an absolute path'
executable="$(node - "$HOME" "$expected_contract_version" "$expected_launcher" "$expected_tool" "$expected_version" "$expected_executable" <<'VERIFY'
const fs = require("node:fs")
const path = require("node:path")

const home = fs.realpathSync(process.argv[2])
const expectedContractVersion = Number(process.argv[3])
const expectedLauncher = process.argv[4]
const expectedTool = process.argv[5]
const expectedVersion = process.argv[6]
const expectedExecutable = process.argv[7]
const manifestPath = path.join(home, ".local", "state", "dim-project-tool", "manifest.json")
const manifestStat = fs.lstatSync(manifestPath)
if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("manifest must be a regular file")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest must be an object")
if (manifest.contractVersion !== expectedContractVersion) throw new Error("unsupported contract version")
if (manifest.tool !== expectedTool || manifest.version !== expectedVersion) throw new Error("incompatible tool identity")
const entry = manifest.launchers?.[expectedLauncher]
if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("unknown launcher")
if (entry.executable !== expectedExecutable) throw new Error("incompatible executable path")
const relative = path.relative(home, expectedExecutable)
if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
  throw new Error("executable must be below HOME")
}
const executableStat = fs.lstatSync(expectedExecutable)
if (!executableStat.isFile() && !executableStat.isSymbolicLink()) throw new Error("executable path must be a file or symbolic link")
fs.accessSync(expectedExecutable, fs.constants.X_OK)
const executableTarget = fs.realpathSync(expectedExecutable)
const targetRelative = path.relative(home, executableTarget)
if (targetRelative === "" || targetRelative === ".." || targetRelative.startsWith(".." + path.sep) || path.isAbsolute(targetRelative)) {
  throw new Error("executable target must be below HOME")
}
if (!fs.statSync(executableTarget).isFile()) throw new Error("executable target must be a regular file")
process.stdout.write(expectedExecutable)
VERIFY
)" || fail 'installed tool manifest is missing or incompatible'
exec "$executable" "$@"
`
const manifest = {
  contractVersion: 1,
  tool: selectedTool,
  version: selectedVersion,
  launchers: {
    agent: { executable: executablePath },
  },
}

function replaceRegularFile(filePath, contents, mode) {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`target must be a regular file: ${filePath}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  const descriptor = fs.openSync(temporaryPath, "wx", mode)
  try {
    fs.writeFileSync(descriptor, contents, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, filePath)
}

replaceRegularFile(launcherPath, launcher, 0o700)
replaceRegularFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
NODE

if [[ "$selected_tool" = opencode ]]; then
  printf '%s\n' \
    "Installed opencode-ai@$OPENCODE_VERSION and oh-my-openagent@$OMO_VERSION under $install_prefix." \
    "OpenCode configuration updated under $config_dir; OMO configuration updated at $omo_dir/omo.jsonc." \
    "Start a new login shell so $install_prefix/bin is on PATH; OpenCode was not started."
else
  printf '%s\n' \
    "Installed @openai/codex@$CODEX_VERSION under $install_prefix." \
    "Start a new login shell so $install_prefix/bin is on PATH; Codex was not started."
fi
