bootstrap_guest_inputs_normalize() {
  local root=/mnt/dim-inputs/bootstrap-source path metadata uid gid
  local -a inputs=("$root" "$root/root.bundle" "$root/manifest.json")
  uid="$(/usr/bin/id -u)"
  gid="$(/usr/bin/id -g)"
  [[ "$uid" == 1001 ]] || return 2
  for path in "${inputs[@]}"; do
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%F:%a:%h:%u:%g' -- "$path")" || return 2
    printf 'bootstrap guest input path=%s metadata=%s\n' "$path" "$metadata"
    if [[ "$path" == "$root" ]]; then
      [[ "$metadata" == directory:500:* ]] || return 2
    else
      [[ "$metadata" == 'regular file:400:1:'* ]] || return 2
    fi
  done
  /usr/bin/sudo -n /usr/bin/chown --no-dereference "$uid:$gid" -- "${inputs[@]}" || return 2
  for path in "${inputs[@]}"; do
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%u:%g' -- "$path")" || return 2
    [[ "$metadata" == "$uid:$gid" ]] || return 2
  done
}
