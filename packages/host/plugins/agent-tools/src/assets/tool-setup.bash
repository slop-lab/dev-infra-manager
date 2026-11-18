#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_VERSION="1.18.31"
readonly OMO_VERSION="4.19.4"
readonly JSONC_PARSER_VERSION="3.3.1"
readonly CODEX_VERSION="0.156.1"
readonly OMP_VERSION="18.22.0"
readonly BUN_VERSION="1.4.4"
readonly CONTEXT_MODE_VERSION="2.2.0"
readonly CAVEMAN_VERSION="4.1.0"
readonly CAVEMAN_COMMIT="1e91f1306d602d4ca23618701b1185575ae1869b"
readonly SERENA_AGENT_VERSION="2.1.0"
readonly UV_VERSION="0.13.8"
readonly UV_SHA256_X86_64="61fb26dabc4f0cf1d050fc6c67d40e43e4fae2994af21ebc1e050b233bf2b5ed"
readonly UV_SHA256_AARCH64="0c6f8593fcf1eadfc60e663b685c408267559d7c5d61c689bbb9f3a7e369ba32"

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
    require_command git
    selected_version="$OPENCODE_VERSION"
    selected_executable_name=opencode
    ;;
  codex)
    selected_version="$CODEX_VERSION"
    selected_executable_name=codex
    ;;
  omp)
    require_command git
    require_command python3
    selected_version="$OMP_VERSION"
    selected_executable_name=omp
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
const toolLauncherDirectory = ensureDirectory(path.join(installPrefix, "bin"), "tool launcher directory")
const toolStateDirectory = ensureDirectory(path.join(installPrefix, "state", "dim-tools"), "tool state directory")
const cacheHome = ensureDirectory(rebaseFromRequestedHome(requestedCacheHome), "XDG cache directory")
let omoDirectory = ""
let openCodeDirectory = ""
if (selectedTool === "opencode") {
  omoDirectory = ensureDirectory(path.join(home, ".omo"), "OMO configuration directory")
  const configHome = ensureDirectory(rebaseFromRequestedHome(requestedConfigHome), "XDG configuration directory")
  openCodeDirectory = ensureDirectory(path.join(configHome, "opencode"), "OpenCode configuration directory")
  ensureDirectory(path.join(cacheHome, "opencode"), "OpenCode cache directory")
}
if (selectedTool === "omp") {
  ensureDirectory(path.join(home, ".omp"), "Caveman OMP plugin directory")
  ensureDirectory(path.join(home, process.env.PI_CONFIG_DIR || ".omp"), "OMP configuration root")
  if (process.env.PI_CODING_AGENT_DIR) {
    if (!path.isAbsolute(process.env.PI_CODING_AGENT_DIR)) throw new Error("PI_CODING_AGENT_DIR must be absolute")
    ensureDirectory(rebaseFromRequestedHome(process.env.PI_CODING_AGENT_DIR), "OMP agent directory")
  }
}
const dataHome = ensureDirectory(rebaseFromRequestedHome(requestedDataHome), "XDG data directory")
const stateHome = ensureDirectory(rebaseFromRequestedHome(requestedStateHome), "XDG state directory")
const npmStateDirectory = ensureDirectory(path.join(installPrefix, "share", "workspace-user-setup"), "npm state directory")
const npmCache = ensureDirectory(path.join(npmStateDirectory, "cache"), "npm cache directory")
const bunHome = selectedTool === "omp"
  ? ensureDirectory(path.join(installPrefix, "share", "dim-agent-tools", "bun"), "Bun installation directory")
  : ""
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
  path.join(toolLauncherDirectory, "dim-agent"),
  bunHome,
  path.join(toolStateDirectory, `${selectedTool}.json`),
].join("\n"))
NODE
)"

mapfile -t setup_paths <<<"$preflight_output"
(( ${#setup_paths[@]} == 12 )) || fail 'internal path preflight returned an invalid result'
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
bun_home="${setup_paths[10]}"
tool_manifest="${setup_paths[11]}"

HOME="$canonical_home"
export HOME
export XDG_CACHE_HOME="$cache_home"
export XDG_DATA_HOME="$data_home"
export XDG_STATE_HOME="$state_home"
export NPM_CONFIG_USERCONFIG="$npm_userconfig"
export npm_config_userconfig="$npm_userconfig"
export NPM_CONFIG_CACHE="$npm_cache"
export npm_config_cache="$npm_cache"

prepare_caveman() {
  caveman_root="$install_prefix/share/dim-agent-tools/caveman-v$CAVEMAN_VERSION"
  [[ ! -L "$caveman_root" ]] || fail "unsafe caveman payload target: $caveman_root"
  if [[ ! -d "$caveman_root" ]] || [[ "$(git -C "$caveman_root" rev-parse HEAD 2>/dev/null)" != "$CAVEMAN_COMMIT" ]]; then
    rm -rf "$caveman_root"
    git clone --quiet --depth 1 --branch "v$CAVEMAN_VERSION" \
      https://github.com/JuliusBrussee/caveman.git "$caveman_root"
    [[ "$(git -C "$caveman_root" rev-parse HEAD)" = "$CAVEMAN_COMMIT" ]] \
      || fail "caveman v$CAVEMAN_VERSION does not match the pinned commit $CAVEMAN_COMMIT"
  fi
}

install_serena() {
  # Serena is a Python MCP server; its pinned install uses a checksum-verified
  # uv release so no unpinned installer script runs.
  case "$(uname -m)" in
    x86_64) uv_target=x86_64-unknown-linux-musl uv_sha256="$UV_SHA256_X86_64" ;;
    aarch64) uv_target=aarch64-unknown-linux-musl uv_sha256="$UV_SHA256_AARCH64" ;;
    *) fail "no pinned uv build for architecture: $(uname -m)" ;;
  esac
  uv_binary="$install_prefix/bin/uv"
  [[ ! -L "$uv_binary" ]] || fail "unsafe uv target: $uv_binary"
  if [[ "$("$uv_binary" --version 2>/dev/null)" != "uv $UV_VERSION"* ]]; then
    uv_work="$(mktemp -d "${TMPDIR:-/tmp}/dim-uv.XXXXXX")"
    curl -fsSL --proto '=https' --tlsv1.2 \
      "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_target.tar.gz" \
      -o "$uv_work/uv.tar.gz"
    printf '%s  %s\n' "$uv_sha256" "$uv_work/uv.tar.gz" | sha256sum -c --quiet - \
      || { rm -rf "$uv_work"; fail "uv $UV_VERSION download failed its pinned checksum"; }
    tar -xzf "$uv_work/uv.tar.gz" -C "$uv_work" "uv-$uv_target/uv"
    install -m 0755 "$uv_work/uv-$uv_target/uv" "$uv_binary"
    rm -rf "$uv_work"
    [[ "$("$uv_binary" --version)" = "uv $UV_VERSION"* ]] || fail 'installed uv reports an unexpected version'
  fi
  serena_binary="$install_prefix/bin/serena"
  if ! "$uv_binary" tool list 2>/dev/null | grep -q "^serena-agent v$SERENA_AGENT_VERSION\$"; then
    (
      python_args=()
      if command -v apk >/dev/null 2>&1 && apk info --exists musl >/dev/null 2>&1; then
        # Serena pins psutil 7.0.0, which has no musllinux wheel. Match
        # Alpine's Python headers and remove the temporary build dependencies.
        apk_command=(apk)
        [[ "$(id -u)" = 0 ]] || apk_command=(sudo -n apk)
        build_deps=".dim-serena-build-$BASHPID"
        trap '"${apk_command[@]}" del "$build_deps" >&2' EXIT
        "${apk_command[@]}" add --no-cache --virtual "$build_deps" gcc musl-dev python3-dev linux-headers >&2
        python_args=(--python /usr/bin/python3)
      fi
      "$uv_binary" tool install --quiet --force "${python_args[@]}" "serena-agent==$SERENA_AGENT_VERSION"
    )
    "$uv_binary" tool list | grep -q "^serena-agent v$SERENA_AGENT_VERSION\$" \
      || fail "serena-agent $SERENA_AGENT_VERSION is not the installed version after installation"
  fi
  [[ -x "$serena_binary" ]] || fail "serena executable missing after installation: $serena_binary"
}

install_omp() (
  cd "$bun_home"
  export PATH="$install_prefix/bin:$PATH"
  export BUN_INSTALL_GLOBAL_DIR="$bun_home/global"
  export BUN_INSTALL_BIN="$install_prefix/bin"
  # The mirrors integration configures /etc/npmrc, which Bun does not read.
  if [[ -z "${BUN_CONFIG_REGISTRY:-}" && -z "${NPM_CONFIG_REGISTRY:-}" ]]; then
    npm_registry="$(npm config get registry)"
    if [[ "$npm_registry" = http://npm.cache.dim.internal:8053/ ]]; then
      export BUN_CONFIG_REGISTRY="$npm_registry"
    fi
  fi

  local_libc="$(node -p 'process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl"')"
  architecture="$(uname -m)"
  bun_binary="$install_prefix/bin/bun"
  [[ ! -L "$bun_binary" && (! -e "$bun_binary" || -f "$bun_binary") ]] || fail 'unsafe Bun executable target'
  if [[ "$("$bun_binary" --version 2>/dev/null)" != "$BUN_VERSION" ]]; then
    case "$architecture:$local_libc" in
      x86_64:glibc) target=linux-x64-baseline checksum=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76 ;;
      x86_64:musl) target=linux-x64-musl-baseline checksum=6e9c37098b293920aed28bfb51ab240e26d23bfdd9bbfecb3ad428ac166549bc ;;
      aarch64:glibc) target=linux-aarch64 checksum=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
      aarch64:musl) target=linux-aarch64-musl checksum=57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009 ;;
      *) fail "no pinned Bun build for architecture and libc: $architecture:$local_libc" ;;
    esac
    work="$(mktemp -d "${TMPDIR:-/tmp}/dim-bun.XXXXXX")"
    trap 'rm -rf -- "$work"' EXIT
    curl -fsSL --proto '=https' --tlsv1.2 \
      "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$target.zip" -o "$work/bun.zip"
    printf '%s  %s\n' "$checksum" "$work/bun.zip" | sha256sum -c --quiet - \
      || fail "Bun $BUN_VERSION download failed its pinned checksum"
    python3 -m zipfile -e "$work/bun.zip" "$work"
    install -m 0755 "$work/bun-$target/bun" "$bun_binary"
    [[ "$("$bun_binary" --version)" = "$BUN_VERSION" ]] || fail 'installed Bun reports an unexpected version'
  fi
  omp="$install_prefix/bin/omp"
  if [[ "$local_libc" = musl ]]; then
    # The npm distribution only ships glibc native addons. The standalone
    # musl executable embeds its platform addon and Bun for plugin installs.
    case "$architecture" in
      x86_64) target=linux-musl-x64 checksum=79ec62c929e1b341c14a5dff35c480dc2db5bbd3740b31c4f1b854c075ae4806 ;;
      aarch64) target=linux-musl-arm64 checksum=6292b4f1be508599a415f98c960d3ea52835a6b103967b316b8708263b283d8b ;;
      *) fail "no pinned OMP build for architecture: $architecture" ;;
    esac
    [[ ! -L "$omp" && (! -e "$omp" || -f "$omp") ]] || fail 'unsafe OMP executable target'
    if ! printf '%s  %s\n' "$checksum" "$omp" | sha256sum -c --quiet - 2>/dev/null; then
      if [[ -z "${work:-}" ]]; then
        work="$(mktemp -d "${TMPDIR:-/tmp}/dim-omp.XXXXXX")"
        trap 'rm -rf -- "$work"' EXIT
      fi
      curl -fsSL --proto '=https' --tlsv1.2 \
        "https://github.com/can1357/oh-my-pi/releases/download/v$OMP_VERSION/omp-$target" -o "$work/omp"
      printf '%s  %s\n' "$checksum" "$work/omp" | sha256sum -c --quiet - \
        || fail "OMP $OMP_VERSION download failed its pinned checksum"
      install -m 0755 "$work/omp" "$omp"
    fi
  else
    "$bun_binary" add --global --exact --ignore-scripts --no-env-file "@oh-my-pi/pi-coding-agent@$OMP_VERSION"
    node -e 'if (require(process.argv[1]).version !== process.argv[2]) throw new Error("unexpected OMP package version")' \
      "$BUN_INSTALL_GLOBAL_DIR/node_modules/@oh-my-pi/pi-coding-agent/package.json" "$OMP_VERSION"
  fi
  [[ "$("$omp" --version)" = "omp/$OMP_VERSION" ]] || fail 'installed OMP reports an unexpected version'
  prepare_caveman
  "$omp" plugin install "context-mode@$CONTEXT_MODE_VERSION"
  node "$caveman_root/installer/install.js" --non-interactive --only omp \
    || fail 'caveman OMP payload installation failed'
  "$omp" plugin list --json | node -e '
    const { npm } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const [contextVersion, cavemanVersion] = process.argv.slice(1);
    for (const [name, version] of [["context-mode", contextVersion], ["caveman", cavemanVersion]]) {
      if (!npm.some((plugin) => plugin.name === name && plugin.version === version && plugin.enabled)) {
        throw new Error(`expected enabled OMP plugin ${name}@${version}`);
      }
    }
  ' "$CONTEXT_MODE_VERSION" "$CAVEMAN_VERSION"
  install_serena
  omp_config_dir="$("$omp" config path)"
  node --input-type=module - "$canonical_home" "$omp_config_dir" "$serena_binary" <<'NODE'
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [home, directory, command] = process.argv.slice(2);
const relative = path.relative(home, directory);
if (!path.isAbsolute(directory) || !relative || relative === ".." ||
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error("OMP configuration directory must be inside HOME");
}
let current = home;
for (const component of relative.split(path.sep)) {
  current = path.join(current, component);
  await fs.mkdir(current, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await fs.lstat(current)).isDirectory()) throw new Error(`unsafe OMP configuration directory: ${current}`);
}
const file = path.join(directory, "mcp.json");
async function readConfig() {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error(`OMP MCP configuration must be a regular file: ${file}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
const original = await readConfig();
const config = JSON.parse(original ?? "{}");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
  throw new Error(`invalid OMP MCP configuration: ${file}`);
}
const serena = {
  type: "stdio",
  command,
  args: ["start-mcp-server", "--context", "ide-assistant", "--project-from-cwd"],
  enabled: true,
};
config.mcpServers = { ...config.mcpServers, serena };
const output = JSON.stringify(config, null, 2) + "\n";
if (output !== original) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, output, { flag: "wx", mode: 0o600 });
    if (await readConfig() !== original) throw new Error(`OMP MCP configuration changed concurrently: ${file}`);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
NODE
)

if [[ "$selected_tool" = opencode ]]; then
  runtime_helper="$HOME/.local/share/dim-agent-tools/opencode-runtime.bash"
  [[ -f "$runtime_helper" ]] || runtime_helper="$(dirname -- "${BASH_SOURCE[0]}")/opencode-runtime.bash"
  bash "$runtime_helper" >/dev/null
  CI=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_YES=true \
  npm install --global --prefix "$install_prefix" --no-progress --loglevel=error \
    "opencode-ai@1.18.31" \
    "oh-my-openagent@4.19.4" \
    "jsonc-parser@3.3.1" \
    "context-mode@2.2.0"
elif [[ "$selected_tool" = codex ]]; then
  CI=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_YES=true \
  npm install --global --prefix "$install_prefix" --no-progress --loglevel=error \
    "@openai/codex@0.156.1"
else
  install_omp
fi

if [[ "$selected_tool" = opencode ]]; then
  availability_helper="$HOME/.local/share/dim-agent-tools/omo-model-availability.mjs"
  [[ -f "$availability_helper" ]] || availability_helper="$(dirname -- "${BASH_SOURCE[0]}")/omo-model-availability.mjs"
  node "$availability_helper" "$install_prefix/lib/node_modules/oh-my-openagent"

  prepare_caveman
  PATH="$install_prefix/bin:$PATH" XDG_CONFIG_HOME="$(dirname -- "$config_dir")" \
    node "$caveman_root/installer/install.js" --non-interactive --only opencode \
    || fail 'caveman OpenCode payload installation failed'
  install_serena

  parser_path="$install_prefix/lib/node_modules/jsonc-parser"
  [[ -d "$parser_path" ]] || fail "JSONC parser installation is missing: $parser_path"

  node - "$parser_path" "$config_dir" "$omo_dir/omo.jsonc" "$install_prefix/lib/node_modules/oh-my-openagent/dist/index.js" "$install_prefix/lib/node_modules/context-mode/opencode/plugin.js" "$serena_binary" <<'NODE'
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const parserPath = process.argv[2]
const configDir = process.argv[3]
const omoPath = process.argv[4]
const { applyEdits, modify, parse, printParseErrorCode } = require(parserPath)
const exactPlugin = require("node:url").pathToFileURL(process.argv[5]).href
const contextModeEntry = process.argv[6]
if (!fs.statSync(contextModeEntry).isFile()) throw new Error(`context-mode plugin entry is missing: ${contextModeEntry}`)
const exactContextModePlugin = require("node:url").pathToFileURL(contextModeEntry).href
const serenaExecutable = process.argv[7]

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
  return typeof value === "string" && (/^(oh-my-openagent|oh-my-opencode)(@.*)?$/.test(value) || value === exactPlugin)
}

function isContextModePlugin(value) {
  return typeof value === "string" && (/^context-mode(@.*)?$/.test(value) || value === exactContextModePlugin)
}

function normalizeOnePlugin(source, plugins, filePath, matchesManaged, exactEntry) {
  if (plugins === undefined) return setValue(source, ["plugin"], [exactEntry])
  if (!Array.isArray(plugins)) throw new Error(`OpenCode plugin must be an array: ${filePath}`)
  const matches = plugins
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => matchesManaged(entry) || (Array.isArray(entry) && matchesManaged(entry[0])))
  if (matches.length === 0) return setValue(source, ["plugin", -1], exactEntry)
  let output = Array.isArray(matches[0].entry)
    ? setValue(source, ["plugin", matches[0].index, 0], exactEntry)
    : setValue(source, ["plugin", matches[0].index], exactEntry)
  for (const { index } of matches.slice(1).reverse()) {
    output = setValue(output, ["plugin", index], undefined)
  }
  return output
}

function reparse(source, filePath) {
  const errors = []
  const value = parse(source ?? "{}", errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !isObject(value)) throw new Error(`configuration normalization produced malformed JSON: ${filePath}`)
  return value
}

function normalizePluginSource(source, plugins, filePath) {
  let output = normalizeOnePlugin(source, plugins, filePath, isOmoPlugin, exactPlugin)
  output = normalizeOnePlugin(output, reparse(output, filePath).plugin, filePath, isContextModePlugin, exactContextModePlugin)
  const serenaServer = {
    type: "local",
    command: [serenaExecutable, "start-mcp-server", "--context", "ide-assistant"],
    enabled: true,
  }
  const mcp = reparse(output, filePath).mcp
  if (mcp !== undefined && !isObject(mcp)) throw new Error(`OpenCode mcp must be an object: ${filePath}`)
  return mcp === undefined
    ? setValue(output, ["mcp"], { serena: serenaServer })
    : setValue(output, ["mcp", "serena"], serenaServer)
}

const openCodeCandidates = ["opencode.jsonc", "opencode.json"]
const existingOpenCode = openCodeCandidates.filter((name) => fs.existsSync(path.join(configDir, name)))
const openCodeFiles = existingOpenCode.length > 0 ? existingOpenCode : ["opencode.json"]
const plans = []

for (const name of openCodeFiles) {
  const loaded = loadConfig(path.join(configDir, name))
  let output = normalizePluginSource(loaded.source, loaded.value.plugin, loaded.filePath)
  // The pinned OpenCode loader adds this on first read. Seed it before a
  // launch snapshot so that ordinary loader normalization cannot change it.
  if (loaded.value.$schema === undefined) output = setValue(output, ["$schema"], "https://opencode.ai/config.json")
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

if [[ "$selected_tool" != omp ]]; then
node - "$install_prefix" "$selected_tool" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const prefix = process.argv[2]
const selectedTool = process.argv[3]
const expected = selectedTool === "opencode"
  ? { "opencode-ai": "1.18.31", "oh-my-openagent": "4.19.4", "jsonc-parser": "3.3.1", "context-mode": "2.2.0" }
  : { "@openai/codex": "0.156.1" }
for (const [name, version] of Object.entries(expected)) {
  const installed = JSON.parse(fs.readFileSync(path.join(prefix, "lib", "node_modules", name, "package.json"), "utf8")).version
  if (installed !== version) throw new Error(`expected ${name}@${version}, found ${installed}`)
}
NODE
fi

asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$selected_tool" = opencode ]]; then
  node "$asset_dir/git-ignore.mjs" '.omo/' '.serena/'
elif [[ "$selected_tool" = omp ]]; then
  node "$asset_dir/git-ignore.mjs" '.serena/'
fi
[[ ! -L "$install_prefix/bin/dim-git-ignore" ]] || fail 'unsafe Git ignore helper target'
install -m 0700 "$asset_dir/git-ignore.mjs" "$install_prefix/bin/dim-git-ignore"
[[ -f "$asset_dir/agent.mjs" ]] || fail 'agent launcher asset is missing'
[[ ! -L "$tool_launcher" && (! -e "$tool_launcher" || -f "$tool_launcher") ]] || fail 'unsafe agent launcher target'
install -m 0700 "$asset_dir/agent.mjs" "$tool_launcher"
mkdir -p "$install_prefix/share/dim-agent-tools"
for helper in opencode-runtime.bash omo-model-availability.mjs opencode-team-metadata.mjs; do
  [[ ! -L "$install_prefix/share/dim-agent-tools/$helper" ]] || fail "unsafe tool helper target: $helper"
  if [[ "$(realpath -m "$asset_dir/$helper")" != "$(realpath -m "$install_prefix/share/dim-agent-tools/$helper")" ]]; then
    install -m 0700 "$asset_dir/$helper" "$install_prefix/share/dim-agent-tools/$helper"
  fi
done
if [[ "$selected_tool" = opencode ]]; then
  [[ ! -L "$install_prefix/bin/dim-opencode-server" ]] || fail 'unsafe server launcher target'
  [[ ! -L "$install_prefix/bin/opencode-service.bash" ]] || fail 'unsafe managed server helper target'
  install -m 0700 "$asset_dir/opencode-service.bash" "$install_prefix/bin/opencode-service.bash"
  install -m 0700 "$asset_dir/opencode-server.bash" "$install_prefix/bin/dim-opencode-server"
fi
node - "$tool_manifest" "$install_prefix/bin/$selected_executable_name" "$selected_tool" "$selected_version" <<'NODE'
const fs = require("node:fs"), crypto = require("node:crypto");
const [file, executable, tool, version] = process.argv.slice(2);
try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("tool manifest must be a regular file"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const temporary = `${file}.${crypto.randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, JSON.stringify({ tool, version, executable }) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
} finally { fs.rmSync(temporary, { force: true }); }
NODE

if [[ "$selected_tool" = opencode ]]; then
  printf '%s\n' \
    "Installed opencode-ai@$OPENCODE_VERSION and oh-my-openagent@$OMO_VERSION under $install_prefix." \
    "Installed context-mode@$CONTEXT_MODE_VERSION (plugin), caveman v$CAVEMAN_VERSION (plugin + AGENTS.md ruleset) and serena-agent $SERENA_AGENT_VERSION (MCP server via uv $UV_VERSION)." \
    "OpenCode configuration updated under $config_dir; OMO configuration updated at $omo_dir/omo.jsonc." \
    "Start a new login shell so $install_prefix/bin is on PATH; OpenCode was not started."
elif [[ "$selected_tool" = codex ]]; then
  printf '%s\n' \
    "Installed @openai/codex@$CODEX_VERSION under $install_prefix." \
    "Start a new login shell so $install_prefix/bin is on PATH; Codex was not started."
else
  printf '%s\n' \
    "Installed @oh-my-pi/pi-coding-agent@$OMP_VERSION with Bun $BUN_VERSION under $install_prefix." \
    "Installed context-mode@$CONTEXT_MODE_VERSION, caveman v$CAVEMAN_VERSION and serena-agent $SERENA_AGENT_VERSION for OMP."
fi
