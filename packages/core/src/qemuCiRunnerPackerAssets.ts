import {
  QEMU_CI_DISK_SIZE,
  QEMU_CI_QEMU_PLUGIN_SOURCE,
  QEMU_CI_QEMU_PLUGIN_VERSION,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM,
  QEMU_CI_UBUNTU_IMAGE_URL
} from "./qemuCiRunnerImageAssets.js";

const pluginBlock = `packer {
  required_plugins {
    qemu = {
      version = "= ${QEMU_CI_QEMU_PLUGIN_VERSION}"
      source  = "${QEMU_CI_QEMU_PLUGIN_SOURCE}"
    }
  }
}`;

export const QEMU_CI_COMMON_PACKER_TEMPLATE = `${pluginBlock}

variable "output_directory" { type = string }
variable "ssh_private_key_file" { type = string }
variable "ssh_public_key_file" { type = string }

source "qemu" "runner_common" {
  accelerator          = "kvm"
  cd_label             = "cidata"
  cd_content = {
    "meta-data" = "instance-id: dim-qemu-ci-common-build\\nlocal-hostname: dim-qemu-ci-common-build\\n"
    "user-data" = <<-EOF
      #cloud-config
      users:
        - name: dim
          uid: 1001
          sudo: ALL=(ALL) NOPASSWD:ALL
          shell: /bin/bash
          ssh_authorized_keys:
            - \${trimspace(file(var.ssh_public_key_file))}
      EOF
  }
  disk_compression     = true
  disk_image           = true
  disk_interface       = "virtio"
  disk_size            = "${QEMU_CI_DISK_SIZE}"
  format               = "qcow2"
  headless             = true
  iso_checksum         = "sha256:${QEMU_CI_UBUNTU_IMAGE_CHECKSUM}"
  iso_url              = "${QEMU_CI_UBUNTU_IMAGE_URL}"
  net_device           = "virtio-net"
  output_directory     = var.output_directory
  qemuargs             = [["-cpu", "host"]]
  shutdown_command     = "sudo shutdown -P now"
  ssh_clear_authorized_keys = true
  ssh_private_key_file = var.ssh_private_key_file
  ssh_timeout          = "10m"
  ssh_username         = "dim"
  vm_name              = "runner-common.qcow2"
}

build {
  sources = ["source.qemu.runner_common"]
  provisioner "file" {
    source      = "/usr/local/share/dim-qemu-ci/ubuntu.sources"
    destination = "/tmp/dim-ubuntu.sources"
  }
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Vars }} {{ .Path }}"
    script          = "/usr/local/share/dim-qemu-ci/provision-common.bash"
  }
}
`;

export const QEMU_CI_PROJECT_PACKER_TEMPLATE = `${pluginBlock}

variable "common_image" { type = string }
variable "common_image_checksum" { type = string }
variable "hook_script_file" { type = string }
variable "output_directory" { type = string }
variable "ssh_private_key_file" { type = string }
variable "ssh_public_key_file" { type = string }

source "qemu" "runner_project" {
  accelerator          = "kvm"
  cd_label             = "cidata"
  cd_content = {
    "meta-data" = "instance-id: dim-qemu-ci-project-build\\nlocal-hostname: dim-qemu-ci-project-build\\n"
    "user-data" = <<-EOF
      #cloud-config
      users:
        - name: dim
          uid: 1001
          sudo: ALL=(ALL) NOPASSWD:ALL
          shell: /bin/bash
          ssh_authorized_keys:
            - \${trimspace(file(var.ssh_public_key_file))}
      EOF
  }
  disk_image           = true
  disk_interface       = "virtio"
  disk_size            = "${QEMU_CI_DISK_SIZE}"
  format               = "qcow2"
  headless             = true
  iso_checksum         = "sha256:\${var.common_image_checksum}"
  iso_target_path      = var.common_image
  iso_url              = var.common_image
  net_device           = "virtio-net"
  output_directory     = var.output_directory
  qemuargs             = [["-cpu", "host"]]
  shutdown_command     = "sudo shutdown -P now"
  skip_compaction       = true
  ssh_clear_authorized_keys = true
  ssh_private_key_file = var.ssh_private_key_file
  ssh_timeout          = "10m"
  ssh_username         = "dim"
  use_backing_file      = true
  vm_name              = "runner-project.qcow2"
}

build {
  sources = ["source.qemu.runner_project"]
  provisioner "file" {
    source      = var.hook_script_file
    destination = "/tmp/dim-project-cache.bash"
  }
  provisioner "shell" {
    inline = [
      "chmod 0700 /tmp/dim-project-cache.bash",
      "sudo /tmp/dim-project-cache.bash /var/lib/dim-kvm-cache",
      "sudo rm -f /tmp/dim-project-cache.bash /home/dim/.ssh/authorized_keys /etc/ssh/ssh_host_* /var/lib/cloud/instance/obj.pkl",
      "sudo cloud-init clean --logs --seed",
      "sudo truncate -s 0 /etc/machine-id",
      "sudo rm -f /var/lib/dbus/machine-id"
    ]
  }
}
`;
