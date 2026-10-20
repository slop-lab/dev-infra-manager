#!/usr/bin/env bash

dim_node_version=24.19.0
dim_pnpm_version=10.13.1
dim_just_version=1.43.1
dim_docker_engine_version=29.1.4
dim_docker_package_version='5:29.1.4-1~ubuntu.24.04~noble'
dim_containerd_package_version='2.2.1-1~ubuntu.24.04~noble'
dim_buildx_package_version='0.31.1-1~ubuntu.24.04~noble'
dim_compose_version=2.40.3
dim_compose_package_version='2.40.3-1~ubuntu.24.04~noble'
dim_sysbox_version=0.7.0
dim_sysbox_package_version='0.7.0.linux'
dim_node_root=/usr/local/lib/dim-qemu-node-24.19.0
dim_source_tools_root=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1

# Immutable downloads used by both fresh-VM bootstrap and its outer cache seed.
dim_bootstrap_artifact() {
  local kind="$1" architecture="$2" node_arch
  case "$kind:$architecture" in
    node:amd64|node:x64)
      node_arch=x64; dim_artifact_sha256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;;
    node:arm64)
      node_arch=arm64; dim_artifact_sha256=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;;
    pnpm:amd64|pnpm:x64)
      dim_artifact_url="https://github.com/pnpm/pnpm/releases/download/v${dim_pnpm_version}/pnpm-linux-x64"
      dim_artifact_sha256=e1cab530ea8252eb90e4add71d95838fd6f2656e6977f120df5ecb6f5b2822e0; return ;;
    just:amd64|just:x64)
      dim_artifact_url="https://github.com/casey/just/releases/download/${dim_just_version}/just-${dim_just_version}-x86_64-unknown-linux-musl.tar.gz"
      dim_artifact_sha256=6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc; return ;;
    sysbox:amd64)
      dim_artifact_sha256=eeff273671467b8fa351ab3d40709759462dc03d9f7b50a1b207b37982ce40a9 ;;
    sysbox:arm64)
      dim_artifact_sha256=eae9c0e91ddd39bd1826d6a7a313a73d42a8449ef5113e9d6d118b559cb809ba ;;
    *) printf 'unsupported bootstrap artifact: %s/%s\n' "$kind" "$architecture" >&2; return 2 ;;
  esac
  if [[ "$kind" == node ]]; then
    dim_artifact_url="https://nodejs.org/dist/v${dim_node_version}/node-v${dim_node_version}-linux-${node_arch}.tar.xz"
  else
    dim_artifact_url="https://downloads.nestybox.com/sysbox/releases/v${dim_sysbox_version}/sysbox-ce_${dim_sysbox_version}-0.linux_${architecture}.deb"
  fi
}
