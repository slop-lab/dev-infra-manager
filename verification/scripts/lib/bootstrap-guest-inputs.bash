bootstrap_guest_inputs_normalize() {
  local root=/mnt/dim-inputs/bootstrap-source path metadata uid gid groups
  local kind mode links owner_uid owner_gid expected_mode
  local -a inputs=("$root" "$root/root.bundle" "$root/manifest.json")
  uid="$(/usr/bin/id -u)"
  gid="$(/usr/bin/id -g)"
  [[ "$uid" == 1001 ]] || return 2
  groups=" $(/usr/bin/id -G) "
  for path in "${inputs[@]}"; do
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%F:%a:%h:%u:%g' -- "$path")" || return 2
    printf 'bootstrap guest input path=%s metadata=%s\n' "$path" "$metadata"
    IFS=: read -r kind mode links owner_uid owner_gid <<<"$metadata"
    [[ "$mode" =~ ^[0-7]{3}$ ]] || return 2
    if [[ "$path" == "$root" ]]; then
      [[ "$kind" == directory ]] || return 2
      expected_mode=500
    else
      [[ "$kind" == 'regular file' && "$links" == 1 ]] || return 2
      expected_mode=400
    fi
    if [[ "$owner_uid:$owner_gid" == "$uid:$gid" ]]; then
      [[ "$mode" == "$expected_mode" ]] || return 2
    elif [[ "$owner_uid:$owner_gid" == 0:0 ]]; then
      if [[ "$path" == "$root" ]]; then
        (( (8#$mode & 8#500) == 8#500 && (8#$mode & 8#022) == 0 )) || return 2
      else
        (( (8#$mode & 8#400) != 0 && (8#$mode & 8#113) == 0 )) || return 2
        if (( (8#$mode & 8#020) != 0 )); then [[ "$groups" != *' 0 '* ]] || return 2; fi
      fi
    else
      return 2
    fi
  done
  /usr/bin/sudo -n /usr/bin/chmod 0400 -- "$root/root.bundle" "$root/manifest.json" || return 2
  /usr/bin/sudo -n /usr/bin/chown --no-dereference "$uid:$gid" -- "$root/root.bundle" "$root/manifest.json" || return 2
  /usr/bin/sudo -n /usr/bin/chmod 0500 -- "$root" || return 2
  /usr/bin/sudo -n /usr/bin/chown --no-dereference "$uid:$gid" -- "$root" || return 2
  for path in "${inputs[@]}"; do
    expected_mode=400
    [[ "$path" != "$root" ]] || expected_mode=500
    metadata="$(/usr/bin/sudo -n /usr/bin/stat -c '%a:%u:%g' -- "$path")" || return 2
    [[ "$metadata" == "$expected_mode:$uid:$gid" ]] || return 2
  done
}
