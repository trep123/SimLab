#!/usr/bin/env bash
# 安装并启动本机受限 SimLab Host Agent。
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 Host Agent 安装脚本" >&2
  exit 1
fi

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly BASE_IMAGE="/var/lib/simlab/image-store/ubuntu-noble-20260725/base.qcow2"
readonly BASE_IMAGE_SHA256="d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac"
readonly AGENT_GROUP="simlab"
readonly OVS_GROUP="simlab-ovs"
readonly AGENT_USER="simlab-runtime"
readonly ENV_DIRECTORY="/etc/simlab"
readonly ENV_FILE="${ENV_DIRECTORY}/host-agent.env"
readonly UNIT_FILE="/etc/systemd/system/simlab-host-agent.service"

if [[ ! -f "${BASE_IMAGE}" ]]; then
  echo "基础镜像不存在，请先运行 ops/linux/fetch_g0_image.sh" >&2
  exit 1
fi
printf '%s  %s\n' "${BASE_IMAGE_SHA256}" "${BASE_IMAGE}" | sha256sum --check --strict

getent group "${AGENT_GROUP}" >/dev/null || groupadd --system "${AGENT_GROUP}"
getent group "${OVS_GROUP}" >/dev/null || groupadd --system "${OVS_GROUP}"
if ! getent passwd "${AGENT_USER}" >/dev/null; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin \
    --gid libvirt-qemu "${AGENT_USER}"
fi
usermod -a -G "${AGENT_GROUP},${OVS_GROUP},libvirt,kvm" "${AGENT_USER}"
install -d -o "${AGENT_USER}" -g libvirt-qemu -m 0770 /run/simlab
install -d -o "${AGENT_USER}" -g libvirt-qemu -m 0750 /var/lib/simlab/host-agent
install -d -o "${AGENT_USER}" -g libvirt-qemu -m 0750 /var/lib/simlab/experiments
chown -R "${AGENT_USER}":libvirt-qemu /var/lib/simlab/host-agent
install -d -o root -g root -m 0750 "${ENV_DIRECTORY}"

cloud_uplink_bridges="${SIMLAB_CLOUD_UPLINK_BRIDGES:-}"
if [[ -z "$cloud_uplink_bridges" && -f "$ENV_FILE" ]]; then
  cloud_uplink_bridges="$(sed -n 's/^SIMLAB_CLOUD_UPLINK_BRIDGES=//p' "$ENV_FILE" | head -n 1)"
fi
cat >"${ENV_FILE}" <<EOF
SIMLAB_BASE_IMAGE_SHA256=${BASE_IMAGE_SHA256}
SIMLAB_IMAGE_IMPORT_ROOT=/var/lib/simlab/image-store/imported
SIMLAB_SOCKET_GROUP=${AGENT_GROUP}
SIMLAB_CLOUD_UPLINK_BRIDGES=${cloud_uplink_bridges}
EOF
chmod 0640 "${ENV_FILE}"

cat >"${UNIT_FILE}" <<EOF
[Unit]
Description=SimLab restricted host agent
After=libvirtd.service openvswitch-switch.service
Requires=libvirtd.service openvswitch-switch.service

[Service]
Type=simple
User=${AGENT_USER}
Group=libvirt-qemu
SupplementaryGroups=${AGENT_GROUP} ${OVS_GROUP} libvirt kvm
WorkingDirectory=${PROJECT_ROOT}
Environment=PYTHONPATH=${PROJECT_ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/python3 -m runtime.host_agent.server --socket /run/simlab/host-agent.sock --console-socket /run/simlab/console.sock --journal /var/lib/simlab/host-agent/journal.sqlite3 --runtime-root /var/lib/simlab/experiments --base-image ${BASE_IMAGE}
ExecStartPre=+/usr/bin/chgrp ${OVS_GROUP} /run/openvswitch/db.sock
ExecStartPre=+/usr/bin/chmod 0770 /run/openvswitch/db.sock
Restart=on-failure
RestartSec=2
RuntimeDirectory=simlab
RuntimeDirectoryMode=0770
UMask=0007
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_ADMIN
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ReadWritePaths=/var/lib/simlab /run/simlab
RestrictAddressFamilies=AF_UNIX AF_NETLINK
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "${UNIT_FILE}"

systemctl daemon-reload
systemctl enable simlab-host-agent.service
systemctl restart simlab-host-agent.service

for attempt in $(seq 1 40); do
  if [[ -S /run/simlab/host-agent.sock ]] && systemctl is-active --quiet simlab-host-agent; then
    break
  fi
  if [[ ${attempt} -eq 40 ]]; then
    systemctl status simlab-host-agent --no-pager >&2 || true
    exit 1
  fi
  sleep 0.25
done

stat -c 'Host Agent Socket: %U %G %a %n' /run/simlab/host-agent.sock
systemctl is-enabled simlab-host-agent.service
systemctl is-active simlab-host-agent.service
