#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 Runtime Host 安装脚本" >&2
  exit 1
fi

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  qemu-system-x86 \
  qemu-utils \
  qemu-guest-agent \
  libvirt-daemon-system \
  libvirt-clients \
  libvirt-dev \
  python3-libvirt \
  virtinst \
  ovmf \
  cloud-image-utils \
  openvswitch-switch \
  openvswitch-common \
  iproute2 \
  iptables \
  nftables \
  tcpdump \
  bridge-utils \
  novnc \
  websockify \
  socat \
  netcat-openbsd \
  jq \
  curl \
  wget

systemctl enable --now libvirtd openvswitch-switch
install -d -m 0750 /var/lib/simlab
python3 "${REPO_ROOT}/ops/linux/preflight.py" --json /var/lib/simlab/preflight-result.json
