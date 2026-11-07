#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
repository="$1" BOOTSTRAP_BASELINE_DIRECTORY="$2" BOOTSTRAP_EVIDENCE_ROOT="$3"
source "$repository/scripts/checks/lib/bootstrap-ubuntu-vm-guest.bash"
BOOTSTRAP_WORK_ROOT="$(mktemp -d "${TMPDIR:-/var/tmp}/dim-baseline-clones.XXXXXXXX")"
BOOTSTRAP_BASE_IMAGE=unused
BOOTSTRAP_CLOUD_PACKAGE_UPDATE=false
BOOTSTRAP_CLOUD_PACKAGES='[]'
cleanup() {
  status=$?; trap - EXIT
  if ! bootstrap_guest_stop; then echo "baseline clone cleanup uncertain; preserved=$BOOTSTRAP_WORK_ROOT" >&2; exit 125; fi
  rm -rf -- "$BOOTSTRAP_WORK_ROOT"; exit "$status"
}
trap cleanup EXIT
for role in control-plane host; do
  started=$SECONDS
  boot_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  name=examples-control-plane; [[ "$role" != host ]] || name=examples-workspace-host
  # Identity/empty-state qualification needs one 3-GiB guest at a time; the full
  # cached acceptance separately runs the simultaneous CP/host workload.
  bootstrap_guest_start "$name" 3072
  machine="$("${BOOTSTRAP_SSH[@]}" cat /etc/machine-id)"
  instance="$("${BOOTSTRAP_SSH[@]}" cloud-init query v1.instance_id)"
  key="$("${BOOTSTRAP_SSH[@]}" 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256' | awk '{print $2}')"
  "${BOOTSTRAP_SSH[@]}" bash -s -- "$role" <<'REMOTE'
set -euo pipefail
for path in "$HOME/.config/dim" "$HOME/.local/state/dim" "$HOME/.local/state/dim-bootstrap" "$HOME/.local/share/dim" /home/dim/dim /tmp/dim-baseline-inputs; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo 'baseline contains source, credentials or DIM state' >&2; exit 2; }
done
if [[ "$1" == host ]]; then
  [[ -z "$(sudo docker ps -aq)" && -z "$(sudo docker image ls -q)" && -z "$(sudo docker volume ls -q)" ]]
else
  ! command -v docker
fi
REMOTE
  node --input-type=module - "$BOOTSTRAP_EVIDENCE_ROOT/clone-observations.jsonl" "$role" "$machine" "$instance" "$key" "$boot_utc" "$((SECONDS - started))" <<'RECORD'
import {appendFileSync} from 'node:fs';
const [file,role,machine,instanceId,sshHostKey,startedAt,elapsed]=process.argv.slice(2);
if(!/^[a-f0-9]{32}$/.test(machine)||!instanceId||!/^SHA256:/.test(sshHostKey))throw Error('invalid observed clone identity');
appendFileSync(file,JSON.stringify({role,machine,instanceId,sshHostKey,startedAt,bootSeconds:Number(elapsed)})+'\n',{mode:0o600});
RECORD
  bootstrap_guest_stop
done
node --input-type=module - "$BOOTSTRAP_EVIDENCE_ROOT/clone-observations.jsonl" "$BOOTSTRAP_EVIDENCE_ROOT/clone-qualification.json" <<'VERIFY'
import {readFileSync,writeFileSync} from 'node:fs';
const [input,output]=process.argv.slice(2),observations=readFileSync(input,'utf8').trim().split('\n').map(JSON.parse);
if(observations.length!==2||observations[0].role!=='control-plane'||observations[1].role!=='host')throw Error('incomplete cloned pair');
for(const field of ['machine','instanceId','sshHostKey'])if(observations[0][field]===observations[1][field])throw Error('reused clone identity');
const receipt={schemaVersion:1,status:'PASS',qualification:'dependency-clone-identities-and-empty-state-only',observations};
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify(receipt));
VERIFY
