#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )) || [[ "$1" != /* ]]; then
  printf 'usage: install-just.bash ABSOLUTE_BIN_DIRECTORY [amd64|arm64]\n' >&2
  exit 2
fi
destination="$1"
case "${2:-$(uname -m)}" in
  amd64|x86_64) target=x86_64; checksum=6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc ;;
  arm64|aarch64) target=aarch64; checksum=e28e1f18cecd45d35f9fb39ef3651dd79c0623cb29a2f375ea7a1a185ac32dc9 ;;
  *) printf 'unsupported Just architecture\n' >&2; exit 2 ;;
esac
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  --output "$temporary/just.tar.gz" \
  "https://github.com/casey/just/releases/download/1.43.1/just-1.43.1-${target}-unknown-linux-musl.tar.gz"
printf '%s  %s\n' "$checksum" "$temporary/just.tar.gz" | sha256sum --check --status
tar --extract --gzip --file "$temporary/just.tar.gz" --directory "$temporary" just
mkdir -p -- "$destination"
install -m 0755 "$temporary/just" "$destination/just"
test "$("$destination/just" --version)" = 'just 1.43.1'
