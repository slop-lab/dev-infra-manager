bootstrap_guest_inputs_normalize() {
  local root=/mnt/dim-inputs/bootstrap-source path metadata uid gid normalize_mode=0
  local -a inputs=("$root" "$root/root.bundle" "$root/manifest.json")
  uid="$(/usr/bin/id -u)"
  gid="$(/usr/bin/id -g)"
  [[ "$uid" == 1001 ]] || return 2
  for path in "${inputs[@]}"; do
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%F:%a:%h:%u:%g' -- "$path")" || return 2
    printf 'bootstrap guest input path=%s metadata=%s\n' "$path" "$metadata"
    if [[ "$path" == "$root" ]]; then
      case "$metadata" in
        directory:500:*) ;;
        directory:755:2:0:0) normalize_mode=1 ;;
        *) return 2 ;;
      esac
    else
      [[ "$metadata" == 'regular file:400:1:'* ]] || return 2
    fi
  done
  /usr/bin/sudo -n /usr/bin/chown --no-dereference "$uid:$gid" -- "${inputs[@]}" || return 2
  if [[ "$normalize_mode" -eq 1 ]]; then
    /usr/bin/sudo -n /usr/bin/chmod 0500 -- "$root" || return 2
  fi
  for path in "${inputs[@]}"; do
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%u:%g' -- "$path")" || return 2
    [[ "$metadata" == "$uid:$gid" ]] || return 2
  done
}
