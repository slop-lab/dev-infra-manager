#!/usr/bin/env bash
set -euo pipefail
umask 077
fail() { printf 'opencode-web: %s\n' "$*" >&2; exit 1; }
operation="${1:-start}"
json_output=false
[[ $# -le 2 && ( $# -lt 2 || "$2" = --json ) ]] || fail 'invalid managed OpenCode operation'
[[ $# -lt 2 ]] || json_output=true
case "$operation" in start|stop|status|credentials|password|__run|__resume) ;; *) fail 'invalid managed OpenCode operation' ;; esac
server="$(dirname -- "${BASH_SOURCE[0]}")/opencode-server.bash"
[[ -f "$server" ]] || server="$(dirname -- "${BASH_SOURCE[0]}")/dim-opencode-server"
service_helper="$(dirname -- "${BASH_SOURCE[0]}")/opencode-service.bash"
service_name=dim-agent-tools-opencode
configuration="$HOME/.local/state/dim-agent-tools/opencode-service.json"

# Only public launch settings are persisted here. Passwords stay in the existing
# private launcher state and never enter the registry argv or environment file.
configuration_action() {
  node - "$configuration" "$1" 2>/dev/null <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [file,action]=process.argv.slice(2),home=process.env.HOME;
function validate(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='corsOrigins,port,stateHome')throw Error('invalid OpenCode service settings');
 if(typeof v.port!=='string'||!/^\d+$/.test(v.port)||BigInt(v.port)<1n||BigInt(v.port)>65535n)throw Error('invalid OpenCode port');
 if(!Array.isArray(v.corsOrigins)||v.corsOrigins.length>64)throw Error('invalid OpenCode CORS origins');
 for(const origin of v.corsOrigins){if(typeof origin!=='string'||origin.includes('*')||/[\r\n]/.test(origin))throw Error('invalid OpenCode CORS origin');const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.origin!==origin.replace(/\/$/,''))throw Error('invalid OpenCode CORS origin');}
 if(typeof v.stateHome!=='string'||!path.isAbsolute(v.stateHome)||/[\r\n]/.test(v.stateHome))throw Error('invalid OpenCode state root');
 const relative=path.relative(home,v.stateHome);if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw Error('OpenCode state must remain beneath HOME');
 return{port:BigInt(v.port).toString(),corsOrigins:[...new Set(v.corsOrigins)].sort(),stateHome:path.resolve(v.stateHome)};
}
function read(){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384||s.nlink!==1||s.size>32768)throw Error('unsafe OpenCode service settings');return validate(JSON.parse(fs.readFileSync(fd,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function directory(create){let current=home;for(const part of path.relative(home,path.dirname(file)).split(path.sep)){current=path.join(current,part);let s;try{s=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;if(!create)return false;fs.mkdirSync(current,{mode:448});s=fs.lstatSync(current);}if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('unsafe settings directory');}return true;}
if(action==='prepare'){directory(true);process.exit(0);}
const existing=directory(false)?read():null;
if(action==='read'){if(existing)process.stdout.write(JSON.stringify(existing));process.exit(0);}
const desired=validate({port:process.env.OPENCODE_WEB_PORT||'4096',corsOrigins:JSON.parse(process.env.OPENCODE_WEB_CORS_ORIGINS||'[]'),stateHome:process.env.XDG_STATE_HOME||path.join(home,'.local/state')});
if(action==='equal'){process.stdout.write(String(JSON.stringify(existing)===JSON.stringify(desired)));process.exit(0);}
if(action!=='write')throw Error('invalid settings action');
let current=home;for(const part of path.relative(home,path.dirname(file)).split(path.sep)){current=path.join(current,part);try{fs.mkdirSync(current,{mode:448});}catch(e){if(e.code!=='EEXIST')throw e;}const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('unsafe settings directory');}
const temporary=file+'.'+crypto.randomUUID();try{fs.writeFileSync(temporary,JSON.stringify(desired)+'\n',{flag:'wx',mode:384});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
NODE
}
load_settings() {
  local value
  value="$(configuration_action read)" || fail 'invalid private OpenCode service settings'
  [[ -n "$value" ]] || return 0
  export OPENCODE_WEB_PORT="$(jq -r .port <<<"$value")"
  export OPENCODE_WEB_CORS_ORIGINS="$(jq -c .corsOrigins <<<"$value")"
  export XDG_STATE_HOME="$(jq -r .stateHome <<<"$value")"
}
# Refuse to replace/remove a same-named user service. The registry remains the
# sole desired-state owner; this file only carries its non-secret launch inputs.
owned_registration() {
  node - "$HOME/.local/state/dim/services/$service_name.json" "$service_helper" <<'NODE'
const fs=require('node:fs');const[file,helper]=process.argv.slice(2);let fd;
try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384||s.nlink!==1||s.size>65536)throw Error('unsafe service record');const v=JSON.parse(fs.readFileSync(fd,'utf8'));if(v.schemaVersion!==1||typeof v.cwd!=='string'||!v.cwd.startsWith('/')||JSON.stringify(v.argv)!==JSON.stringify(['bash',helper,'__run']))throw Error('service name belongs to another command');process.stdout.write('present');}catch(e){if(e.code==='ENOENT')process.stdout.write('absent');else{console.error('opencode-web: managed service name is occupied or unsafe');process.exitCode=1;}}finally{if(fd!==undefined)fs.closeSync(fd);}
NODE
}
direct() { bash "$server" --direct "$@"; }
if [[ "$operation" = __run ]]; then
  [[ -n "$(configuration_action read)" ]] || fail 'OpenCode service settings are missing'
  load_settings
  exec bash "$server" __serve
fi
resume_only=false
if [[ "$operation" = __resume ]]; then resume_only=true; operation=start; fi
if [[ "$operation" = status || "$operation" = credentials ]]; then
  load_settings
  arguments=("$operation"); [[ "$json_output" = false ]] || arguments+=(--json)
  exec bash "$server" --direct "${arguments[@]}"
fi
# The control lock serializes intent changes; the foreground worker uses the
# existing independent launch lock, released at the direct exec handoff.
configuration_action prepare || fail 'unsafe OpenCode service directory'
control="$HOME/.local/state/dim-agent-tools/opencode-service.lock"
[[ ! -L "$control" && ( ! -e "$control" || ( -f "$control" && -O "$control" ) ) ]] || fail 'unsafe OpenCode service lock'
exec {control_fd}>"$control"
flock -x "$control_fd"
registered="$(owned_registration)" || exit 1
if [[ "$resume_only" = true ]]; then
  [[ "$registered" = present ]] || exit 0
  load_settings
fi
if [[ "$operation" = stop ]]; then
  load_settings
  [[ "$registered" = absent ]] || dim-workspace service remove "$service_name"
  arguments=(stop); [[ "$json_output" = false ]] || arguments+=(--json)
  exec bash "$server" --direct "${arguments[@]}"
fi
if [[ "$operation" = password ]]; then
  load_settings
  was_running="$(direct status --json | jq -r .state)"
  # Existing validation completes before this can stop any process or alter intent.
  direct __password --json >/dev/null
  if [[ "$was_running" != running ]]; then
    arguments=(status); [[ "$json_output" = false ]] || arguments+=(--json)
    exec bash "$server" --direct "${arguments[@]}"
  fi
  [[ "$registered" = absent ]] || dim-workspace service remove "$service_name"
  # Rotation and restart are one serialized intent change. Do not unlock and
  # recursively start: a completed stop in that gap must never be resurrected.
  operation=start
  registered=absent
fi
same_settings="$(configuration_action equal)" || fail 'invalid OpenCode launch settings'
if [[ "$same_settings" = true && "$registered" = present ]]; then
  current="$(load_settings; direct status --json)"
  if [[ "$(jq -r .state <<<"$current")" = running ]]; then
    if [[ "$json_output" = true ]]; then printf '%s\n' "$current"; else load_settings; direct status; fi
    exit 0
  fi
fi
[[ "$registered" = absent ]] || dim-workspace service remove "$service_name"
# Stop only an existing helper-owned listener before transferring to supervision.
(load_settings; direct stop --json) >/dev/null
configuration_action write || fail 'could not persist OpenCode launch settings'
load_settings
dim-workspace service register --name "$service_name" -- bash "$service_helper" __run >/dev/null
dim-workspace service resume "$service_name"
ready_deadline=$((SECONDS + 60))
while (( SECONDS < ready_deadline )); do
  current="$(direct status --json)"
  if [[ "$(jq -r .state <<<"$current")" = running ]]; then
    if [[ "$json_output" = true ]]; then printf '%s\n' "$current"; else direct status; fi
    exit 0
  fi
  if ! dim-workspace service list | jq -e --arg name "$service_name" '.[] | select(.name == $name and .running == true)' >/dev/null; then
    fail 'OpenCode service exited before readiness; inspect ~/.local/state/dim/services/dim-agent-tools-opencode.log'
  fi
  sleep 0.1
done
fail 'OpenCode service did not become ready; inspect ~/.local/state/dim/services/dim-agent-tools-opencode.log'
