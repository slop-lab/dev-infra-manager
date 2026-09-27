export const QEMU_CI_ARCHITECTURE = "amd64";
export const QEMU_CI_QEMU_ARCHITECTURE = "x86_64";
export const QEMU_CI_DISK_SIZE = "64G";
export const QEMU_CI_UBUNTU_RELEASE = "20260911";
export const QEMU_CI_UBUNTU_IMAGE_NAME = "ubuntu-24.04-server-cloudimg-amd64.img";
export const QEMU_CI_UBUNTU_RELEASE_URL = `https://cloud-images.ubuntu.com/releases/24.04/release-${QEMU_CI_UBUNTU_RELEASE}`;
export const QEMU_CI_UBUNTU_IMAGE_URL = `${QEMU_CI_UBUNTU_RELEASE_URL}/${QEMU_CI_UBUNTU_IMAGE_NAME}`;
export const QEMU_CI_UBUNTU_IMAGE_CHECKSUM = "612b2c0cc1bc413a6cb8c38fd611794caf0f2b436c50013d8b3794db12ad7354";
export const QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL = `${QEMU_CI_UBUNTU_RELEASE_URL}/SHA256SUMS`;
export const QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SHA256 = "89be81c6f31ffcd63e9df433e868fc2a651475a45aeb993c0dbd2707747b0185";
export const QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_URL = `${QEMU_CI_UBUNTU_RELEASE_URL}/SHA256SUMS.gpg`;
export const QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_SHA256 = "6157c3d73e35044f21308b3daea9619e0f44895289911f004b291bfb3541e1b5";
export const QEMU_CI_UBUNTU_CLOUD_IMAGE_KEYRING_SHA256 = "c2d40d925557dbe9a0745c12ca0dc98bed593ce9a6652f1b2faa1ff0858dbf2f";
export const QEMU_CI_UBUNTU_CLOUD_IMAGE_SIGNING_FINGERPRINTS = [
  "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
  "D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81"
] as const;
export const QEMU_CI_APT_SNAPSHOT = "20260911T120000Z";
export const QEMU_CI_APT_TLS_CA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
`;
export const QEMU_CI_APT_SOURCES = `Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/${QEMU_CI_APT_SNAPSHOT}/
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
export const QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS = [
  "cloud-image-utils=0.33-1",
  "curl=8.5.0-2ubuntu10.13",
  "docker.io=29.1.3-0ubuntu3~24.04.2",
  "git=1:2.43.0-1ubuntu7.3",
  "jq=1.7.1-3ubuntu0.24.04.2",
  "just=1.21.0-1",
  "openssh-client=1:9.6p1-3ubuntu13.19",
  "qemu-system-x86=1:8.2.2+ds-0ubuntu1.18",
  "qemu-utils=1:8.2.2+ds-0ubuntu1.18",
  "socat=1.8.0.0-4ubuntu0.1",
  "xz-utils=5.6.1+really5.4.5-1ubuntu0.3"
] as const;
export const QEMU_CI_SUPERVISOR_APT_PACKAGE_SPECIFICATIONS = [
  "ca-certificates=20260601~24.04.1",
  "cloud-image-utils=0.33-1",
  "curl=8.5.0-2ubuntu10.13",
  "gpgv=2.4.4-2ubuntu17.6",
  "openssh-client=1:9.6p1-3ubuntu13.19",
  "python3=3.12.3-0ubuntu2.1",
  "qemu-system-x86=1:8.2.2+ds-0ubuntu1.18",
  "qemu-utils=1:8.2.2+ds-0ubuntu1.18",
  "socat=1.8.0.0-4ubuntu0.1",
  "ubuntu-cloudimage-keyring=2023.11.28.1",
  "unzip=6.0-28ubuntu4.1",
  "util-linux=2.39.3-9ubuntu6.6",
  "xz-utils=5.6.1+really5.4.5-1ubuntu0.3"
] as const;
export const QEMU_CI_PACKER_VERSION = "1.16.0";
export const QEMU_CI_PACKER_URL = "https://releases.hashicorp.com/packer/1.16.0/packer_1.16.0_linux_amd64.zip";
export const QEMU_CI_PACKER_ARCHIVE_CHECKSUM = "5edcd14ab59b535040c512dbecd6ec9ef976a000b073c19d93e4c431c948581e";
export const QEMU_CI_QEMU_PLUGIN_SOURCE = "github.com/hashicorp/qemu";
export const QEMU_CI_QEMU_PLUGIN_VERSION = "1.1.6";
export const QEMU_CI_QEMU_PLUGIN_URL = "https://releases.hashicorp.com/packer-plugin-qemu/1.1.6/packer-plugin-qemu_1.1.6_linux_amd64.zip";
export const QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM = "3f735539fbdd0368785babda272b85738866f736415dce59d04b4cb550c4db87";
export const QEMU_CI_GITEA_RUNNER_VERSION = "3.2.0";
export const QEMU_CI_GITEA_RUNNER_URL = "https://gitea.com/gitea/runner/releases/download/v3.2.0/gitea-runner-3.2.0-linux-amd64.xz";
export const QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM = "335d0f12e4fdf2cdc2310e9ce8ad33303d0f6889fe2efa2e1999d2f5614d440f";

export const QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
test "$1" = /var/lib/dim-kvm-cache
`;

export const QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

destination="\${1:?verification directory is required}"
curl -fsSLo "$destination/SHA256SUMS" "${QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL}"
curl -fsSLo "$destination/SHA256SUMS.gpg" "${QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_URL}"
printf '%s  %s\n' "${QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SHA256}" "$destination/SHA256SUMS" | sha256sum --check
printf '%s  %s\n' "${QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_SHA256}" "$destination/SHA256SUMS.gpg" | sha256sum --check
printf '%s  %s\n' "${QEMU_CI_UBUNTU_CLOUD_IMAGE_KEYRING_SHA256}" /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg | sha256sum --check
signature_status="$(gpgv --status-fd 1 --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg "$destination/SHA256SUMS.gpg" "$destination/SHA256SUMS" 2>/dev/null)"
grep -Eq '^\\[GNUPG:\\] VALIDSIG (${QEMU_CI_UBUNTU_CLOUD_IMAGE_SIGNING_FINGERPRINTS.join("|")}) ' <<<"$signature_status"
grep -Fqx '${QEMU_CI_UBUNTU_IMAGE_CHECKSUM} *${QEMU_CI_UBUNTU_IMAGE_NAME}' "$destination/SHA256SUMS"
`;

export const QEMU_CI_COMMON_PROVISION_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

install -m 0644 /tmp/dim-ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources.curtin.orig
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ${QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS.join(" \\\n  ")}
rm -rf /var/lib/apt/lists/*
curl -fsSLo /usr/local/bin/gitea-runner.xz \
  "${QEMU_CI_GITEA_RUNNER_URL}"
echo "${QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM}  /usr/local/bin/gitea-runner.xz" | sha256sum --check
xz -d /usr/local/bin/gitea-runner.xz
chmod 0755 /usr/local/bin/gitea-runner
install -d -o dim -g dim /var/lib/gitea-runner /var/lib/dim-kvm-cache
rm -f /home/dim/.ssh/authorized_keys /etc/ssh/ssh_host_* /var/lib/cloud/instance/obj.pkl
cloud-init clean --logs --seed
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
`;
