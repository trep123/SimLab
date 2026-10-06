#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执行 SimLab G0：两台真实 KVM VM、OVS 链路、载波变化与 noVNC。

此脚本只管理固定名称 ``simlab-g0-*`` 和 ``simlab-g0``，不会按通配符清理
宿主机上的其他 libvirt/OVS 资源。它要求管理员先提供已校验的只读 QCOW2
基础镜像。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import pwd
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import pexpect


LIBVIRT_URI = "qemu:///system"
BRIDGE = "simlab-g0"
RUNTIME_ROOT = Path("/var/lib/simlab/runtime-data/g0")
NOVNC_UNIT = Path("/etc/systemd/system/simlab-g0-novnc.service")
NOVNC_PORT = 6080
NOVNC_PASSWORD = os.environ.get("SIMLAB_G0_NOVNC_PASSWORD", "")
GUEST_USER = "simlab"
GUEST_PASSWORD = os.environ.get("SIMLAB_G0_GUEST_PASSWORD", "")
NETWORK_CIDR = "10.77.0.0/24"


@dataclass(frozen=True)
class Guest:
    name: str
    hostname: str
    address: str
    mac: str
    tap: str
    vnc_port: int


GUESTS = (
    Guest(
        "simlab-g0-pc1", "g0-pc1", "10.77.0.11", "52:54:00:77:00:11", "g0pc1p0", 5905
    ),
    Guest(
        "simlab-g0-pc2", "g0-pc2", "10.77.0.12", "52:54:00:77:00:12", "g0pc2p0", 5906
    ),
)


class GateFailure(RuntimeError):
    """G0 验收未达到预期。"""


def run(
    argv: list[str],
    *,
    check: bool = True,
    timeout: int = 120,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """以 argv 执行固定工具，不经过 shell。"""
    completed = subprocess.run(
        argv,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise GateFailure(
            f"命令失败 ({completed.returncode}): {' '.join(argv)}\n{detail}"
        )
    return completed


def command_output(argv: list[str], *, timeout: int = 120) -> str:
    return run(argv, timeout=timeout).stdout.strip()


def require_environment(image: Path) -> None:
    if os.geteuid() != 0:
        raise GateFailure("G0 脚本必须由 root 运行")
    for command in (
        "virsh",
        "qemu-img",
        "ovs-vsctl",
        "ovs-ofctl",
        "cloud-localds",
        "ssh-keygen",
        "openssl",
        "websockify",
    ):
        if shutil.which(command) is None:
            raise GateFailure(f"缺少命令：{command}")
    if not image.is_file():
        raise GateFailure(f"基础镜像不存在：{image}")
    if not Path("/dev/kvm").exists() or not os.access("/dev/kvm", os.R_OK | os.W_OK):
        raise GateFailure("/dev/kvm 不可读写")
    for port in (NOVNC_PORT, *(guest.vnc_port for guest in GUESTS)):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise GateFailure(f"本机端口已占用：{port}")


def domain_exists(name: str) -> bool:
    return (
        run(["virsh", "-c", LIBVIRT_URI, "dominfo", name], check=False).returncode == 0
    )


def cleanup_managed_resources(remove_unit: bool = True) -> dict[str, Any]:
    """只清理本脚本拥有的精确资源名称。"""
    actions: list[str] = []
    run(["systemctl", "stop", "simlab-g0-novnc.service"], check=False)
    for guest in GUESTS:
        if not domain_exists(guest.name):
            continue
        state = command_output(["virsh", "-c", LIBVIRT_URI, "domstate", guest.name])
        if state != "shut off":
            run(["virsh", "-c", LIBVIRT_URI, "destroy", guest.name], check=False)
            actions.append(f"destroy:{guest.name}")
        run(["virsh", "-c", LIBVIRT_URI, "undefine", guest.name, "--nvram"])
        actions.append(f"undefine:{guest.name}")
    run(["ovs-vsctl", "--if-exists", "del-br", BRIDGE])
    actions.append(f"del-br:{BRIDGE}")
    if RUNTIME_ROOT.exists():
        shutil.rmtree(RUNTIME_ROOT)
        actions.append(f"remove:{RUNTIME_ROOT}")
    if remove_unit and NOVNC_UNIT.exists():
        NOVNC_UNIT.unlink()
        run(["systemctl", "daemon-reload"])
        actions.append(f"remove:{NOVNC_UNIT}")
    leftovers = {
        "domains": [guest.name for guest in GUESTS if domain_exists(guest.name)],
        "bridge": run(["ovs-vsctl", "br-exists", BRIDGE], check=False).returncode == 0,
        "runtime_root": RUNTIME_ROOT.exists(),
    }
    if leftovers["domains"] or leftovers["bridge"] or leftovers["runtime_root"]:
        raise GateFailure(f"受管资源清理不完整：{leftovers}")
    return {"ok": True, "actions": actions, "leftovers": leftovers}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_text(path: Path, content: str, mode: int = 0o600) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def qemu_owner() -> tuple[int, int]:
    account = pwd.getpwnam("libvirt-qemu")
    return account.pw_uid, account.pw_gid


def build_cloud_init(
    guest: Guest, public_key: str, password_hash: str, directory: Path
) -> Path:
    user_data = f"""#cloud-config
hostname: {guest.hostname}
manage_etc_hosts: true
ssh_pwauth: false
disable_root: true
users:
  - name: {GUEST_USER}
    gecos: SimLab G0 User
    groups: [adm, sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    passwd: {password_hash}
    ssh_authorized_keys:
      - {public_key}
chpasswd:
  expire: false
write_files:
  - path: /etc/motd
    permissions: '0644'
    content: 'SimLab G0 isolated runtime guest\n'
runcmd:
  - [sh, -c, 'printf ready > /var/lib/simlab-g0-ready']
final_message: 'SIMLAB_G0_CLOUD_INIT_DONE'
"""
    meta_data = f"instance-id: {guest.name}\nlocal-hostname: {guest.hostname}\n"
    network_config = f"""version: 2
ethernets:
  eth0:
    match:
      macaddress: "{guest.mac}"
    set-name: eth0
    dhcp4: false
    dhcp6: false
    accept-ra: false
    optional: true
    addresses:
      - {guest.address}/24
"""
    user_path = directory / "user-data"
    meta_path = directory / "meta-data"
    network_path = directory / "network-config"
    seed_path = directory / "seed.iso"
    write_text(user_path, user_data)
    write_text(meta_path, meta_data)
    write_text(network_path, network_config)
    run(
        [
            "cloud-localds",
            "--network-config",
            str(network_path),
            str(seed_path),
            str(user_path),
            str(meta_path),
        ]
    )
    return seed_path


def domain_xml(guest: Guest, overlay: Path, seed: Path, nvram: Path) -> str:
    domain_uuid = uuid.uuid5(
        uuid.NAMESPACE_URL, f"https://simlab.local/g0/{guest.name}"
    )
    return f"""<domain type='kvm'>
  <name>{escape(guest.name)}</name>
  <uuid>{domain_uuid}</uuid>
  <title>SimLab G0 Runtime Gate</title>
  <description>Managed by ops/linux/g0_runtime_gate.py</description>
  <memory unit='MiB'>1024</memory>
  <currentMemory unit='MiB'>1024</currentMemory>
  <vcpu placement='static'>1</vcpu>
  <resource><partition>/machine</partition></resource>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <loader readonly='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.fd</loader>
    <nvram template='/usr/share/OVMF/OVMF_VARS_4M.fd'>{escape(str(nvram))}</nvram>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-model' check='partial'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='none' discard='unmap'/>
      <source file='{escape(str(overlay))}'/>
      <target dev='vda' bus='virtio'/>
      <alias name='simlab-disk0'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='{escape(str(seed))}'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
      <alias name='simlab-seed'/>
    </disk>
    <controller type='sata' index='0'/>
    <controller type='usb' index='0' model='qemu-xhci'/>
    <interface type='bridge'>
      <mac address='{guest.mac}'/>
      <source bridge='{BRIDGE}'/>
      <virtualport type='openvswitch'/>
      <target dev='{guest.tap}'/>
      <model type='virtio'/>
      <link state='down'/>
      <alias name='simlab-eth0'/>
    </interface>
    <serial type='pty'><target type='isa-serial' port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
      <alias name='simlab-qga'/>
    </channel>
    <input type='tablet' bus='usb'/>
    <graphics type='vnc' port='{guest.vnc_port}' autoport='no' listen='127.0.0.1' passwd='{NOVNC_PASSWORD}'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
    <video><model type='virtio' heads='1' primary='yes'/></video>
    <memballoon model='virtio'/>
  </devices>
</domain>
"""


def prepare_resources(image: Path) -> dict[str, Any]:
    RUNTIME_ROOT.mkdir(parents=True, mode=0o770)
    uid, gid = qemu_owner()
    os.chown(RUNTIME_ROOT, 0, gid)
    RUNTIME_ROOT.chmod(0o770)
    key_path = RUNTIME_ROOT / "g0_ed25519"
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)])
    public_key = key_path.with_suffix(".pub").read_text(encoding="utf-8").strip()
    password_hash = run(
        ["openssl", "passwd", "-6", "-stdin"], input_text=GUEST_PASSWORD + "\n"
    ).stdout.strip()

    run(["ovs-vsctl", "--may-exist", "add-br", BRIDGE])
    run(["ovs-vsctl", "set", "bridge", BRIDGE, "other-config:disable-in-band=true"])
    run(["ip", "link", "set", BRIDGE, "up"])
    run(["ip", "addr", "flush", "dev", BRIDGE])
    run(["sysctl", "-q", "-w", f"net.ipv6.conf.{BRIDGE}.disable_ipv6=1"])
    run(
        [
            "ovs-ofctl",
            "-O",
            "OpenFlow13",
            "add-flow",
            BRIDGE,
            "priority=0,actions=NORMAL",
        ]
    )

    artifacts: list[dict[str, str]] = []
    for guest in GUESTS:
        directory = RUNTIME_ROOT / guest.name
        directory.mkdir(mode=0o770)
        os.chown(directory, 0, gid)
        overlay = directory / "disk01.qcow2"
        seed = build_cloud_init(guest, public_key, password_hash, directory)
        nvram = directory / "nvram.fd"
        shutil.copyfile("/usr/share/OVMF/OVMF_VARS_4M.fd", nvram)
        run(
            [
                "qemu-img",
                "create",
                "-f",
                "qcow2",
                "-F",
                "qcow2",
                "-b",
                str(image),
                str(overlay),
                "8G",
            ]
        )
        for path in (overlay, seed, nvram):
            os.chown(path, uid, gid)
            path.chmod(0o660)
        xml_path = directory / "domain.xml"
        write_text(xml_path, domain_xml(guest, overlay, seed, nvram), mode=0o640)
        run(["virsh", "-c", LIBVIRT_URI, "define", str(xml_path)])
        artifacts.append(
            {
                "name": guest.name,
                "overlay": str(overlay),
                "seed": str(seed),
                "nvram": str(nvram),
                "mac": guest.mac,
                "tap": guest.tap,
                "address": guest.address,
            }
        )
    return {"bridge": BRIDGE, "network": NETWORK_CIDR, "guests": artifacts}


def wait_for_console_login(name: str, timeout: int = 360) -> pexpect.spawn:
    child = pexpect.spawn(
        "virsh",
        ["-c", LIBVIRT_URI, "console", name, "--force"],
        encoding="utf-8",
        timeout=20,
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        child.sendline("")
        try:
            index = child.expect(
                [r"login:\s*$", r"Password:\s*$", pexpect.EOF, pexpect.TIMEOUT]
            )
        except pexpect.ExceptionPexpect as error:
            raise GateFailure(f"等待 {name} 串口失败：{error}") from error
        if index == 0:
            child.sendline(GUEST_USER)
            child.expect(r"Password:\s*$", timeout=30)
            child.sendline(GUEST_PASSWORD)
            child.expect([r"\$\s*$", r"#\s*$"], timeout=30)
            return child
        if index == 1:
            child.sendline(GUEST_PASSWORD)
        if index == 2:
            raise GateFailure(f"{name} 串口提前关闭")
        time.sleep(2)
    child.close(force=True)
    raise GateFailure(f"{name} 在 {timeout} 秒内未出现登录提示")


def guest_command(
    console: pexpect.spawn, command: str, timeout: int = 90
) -> dict[str, Any]:
    marker = f"__SIMLAB_DONE_{uuid.uuid4().hex}__"
    console.sendline(f"{command}; rc=$?; printf '\\n{marker}:%s\\n' \"$rc\"")
    console.expect(re.escape(marker) + r":([0-9]+)", timeout=timeout)
    output = console.before.replace("\r", "").strip()
    return {
        "command": command,
        "exit_code": int(console.match.group(1)),
        "output": output,
    }


def close_console(console: pexpect.spawn) -> None:
    console.sendcontrol("]")
    console.expect(pexpect.EOF, timeout=20)
    console.close()


def start_domains() -> None:
    for guest in GUESTS:
        run(["virsh", "-c", LIBVIRT_URI, "start", guest.name])
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        states = [
            command_output(["virsh", "-c", LIBVIRT_URI, "domstate", guest.name])
            for guest in GUESTS
        ]
        if all(state == "running" for state in states):
            return
        time.sleep(1)
    raise GateFailure("VM 未全部进入 running")


def set_links(state: str) -> None:
    for guest in GUESTS:
        run(["virsh", "-c", LIBVIRT_URI, "domif-setlink", guest.name, guest.tap, state])


def install_novnc_service() -> None:
    unit = f"""[Unit]
Description=SimLab G0 local-only noVNC gateway
After=libvirtd.service network.target
Requires=libvirtd.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:{NOVNC_PORT} 127.0.0.1:{GUESTS[0].vnc_port}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
"""
    NOVNC_UNIT.write_text(unit, encoding="utf-8")
    NOVNC_UNIT.chmod(0o644)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", NOVNC_UNIT.name])
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", NOVNC_PORT)) == 0:
                return
        time.sleep(0.5)
    raise GateFailure("noVNC/websockify 未监听")


def websocket_vnc_probe() -> dict[str, Any]:
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:{NOVNC_PORT}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: binary\r\n\r\n"
    ).encode()
    with socket.create_connection(("127.0.0.1", NOVNC_PORT), timeout=10) as connection:
        connection.sendall(request)
        response = b""
        while b"\r\n\r\n" not in response:
            response += connection.recv(4096)
        header, _, frame = response.partition(b"\r\n\r\n")
        while len(frame) < 2:
            frame += connection.recv(4096)
        length = frame[1] & 0x7F
        offset = 2
        if length == 126:
            while len(frame) < 4:
                frame += connection.recv(4096)
            length = int.from_bytes(frame[2:4], "big")
            offset = 4
        elif length == 127:
            while len(frame) < 10:
                frame += connection.recv(4096)
            length = int.from_bytes(frame[2:10], "big")
            offset = 10
        while len(frame) < offset + length:
            frame += connection.recv(4096)
    payload = frame[offset : offset + length]
    status = header.splitlines()[0].decode(errors="replace") if header else ""
    if "101" not in status:
        raise GateFailure(f"WebSocket 升级失败：{status}")
    if not payload.startswith(b"RFB "):
        raise GateFailure(f"WebSocket 未转发 RFB 握手：{payload[:32]!r}")
    return {
        "status": status,
        "subprotocol": "binary",
        "rfb_banner": payload.decode(errors="replace").strip(),
    }


def source_revision() -> str:
    completed = run(["git", "rev-parse", "HEAD"], check=False, timeout=10)
    return completed.stdout.strip() or "uncommitted-worktree"


def collect_versions() -> dict[str, str]:
    commands = {
        "qemu": ["qemu-system-x86_64", "--version"],
        "qemu_img": ["qemu-img", "--version"],
        "libvirt": ["virsh", "--version"],
        "ovs": ["ovs-vsctl", "--version"],
        "novnc": ["dpkg-query", "-W", "-f=${Version}", "novnc"],
        "websockify": ["dpkg-query", "-W", "-f=${Version}", "websockify"],
    }
    versions: dict[str, str] = {}
    for key, argv in commands.items():
        output = command_output(argv)
        versions[key] = output.splitlines()[0] if output else "unknown"
    return versions


def host_identity() -> dict[str, Any]:
    os_release: dict[str, str] = {}
    for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    cpu_model = "unknown"
    for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("model name"):
            cpu_model = line.split(":", 1)[1].strip()
            break
    return {
        "os": os_release.get("PRETTY_NAME", platform.platform()),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "cpu": cpu_model,
        "kvm": True,
    }


def run_gate(
    image: Path, expected_sha256: str, evidence_path: Path, keep: bool
) -> None:
    started_at = datetime.now(UTC)
    run_id = str(uuid.uuid4())
    image_sha256 = sha256_file(image)
    if image_sha256 != expected_sha256:
        raise GateFailure(f"镜像 SHA256 不匹配：{image_sha256}")
    image_info = json.loads(
        command_output(["qemu-img", "info", "--output=json", str(image)])
    )
    if image_info.get("format") != "qcow2":
        raise GateFailure(f"镜像实际格式不是 qcow2：{image_info.get('format')}")
    image_check = json.loads(
        command_output(["qemu-img", "check", "--output=json", str(image)])
    )
    if image_check.get("check-errors") != 0:
        raise GateFailure(f"镜像检查失败：{image_check}")

    pre_run_cleanup = cleanup_managed_resources()
    require_environment(image)
    resources = prepare_resources(image)
    start_domains()
    observations: dict[str, Any] = {
        "initial_host_links": {
            guest.name: command_output(
                ["virsh", "-c", LIBVIRT_URI, "domif-getlink", guest.name, guest.tap]
            )
            for guest in GUESTS
        }
    }

    pc1_console = wait_for_console_login(GUESTS[0].name)
    observations["guest_initial"] = guest_command(
        pc1_console,
        "printf 'carrier='; cat /sys/class/net/eth0/carrier; ip -br link show eth0; ip -br addr show eth0",
    )
    if "carrier=0" not in observations["guest_initial"]["output"]:
        raise GateFailure("Guest 初始 NO-CARRIER 验证失败")

    set_links("up")
    time.sleep(4)
    observations["connected_ping"] = guest_command(
        pc1_console,
        "printf 'carrier='; cat /sys/class/net/eth0/carrier; ip -br addr show eth0; ping -c 3 -W 3 10.77.0.12",
        timeout=40,
    )
    if (
        observations["connected_ping"]["exit_code"] != 0
        or "carrier=1" not in observations["connected_ping"]["output"]
    ):
        raise GateFailure("接线后的 Guest ping/carrier 验证失败")

    run(
        [
            "virsh",
            "-c",
            LIBVIRT_URI,
            "domif-setlink",
            GUESTS[0].name,
            GUESTS[0].tap,
            "down",
        ]
    )
    time.sleep(2)
    observations["disconnected"] = guest_command(
        pc1_console,
        "printf 'carrier='; cat /sys/class/net/eth0/carrier; ping -c 1 -W 2 10.77.0.12",
        timeout=20,
    )
    if (
        observations["disconnected"]["exit_code"] == 0
        or "carrier=0" not in observations["disconnected"]["output"]
    ):
        raise GateFailure("拔线后的 NO-CARRIER/通信中断验证失败")

    run(
        [
            "virsh",
            "-c",
            LIBVIRT_URI,
            "domif-setlink",
            GUESTS[0].name,
            GUESTS[0].tap,
            "up",
        ]
    )
    time.sleep(2)
    observations["reconnected_ping"] = guest_command(
        pc1_console,
        "printf 'carrier='; cat /sys/class/net/eth0/carrier; ping -c 3 -W 3 10.77.0.12",
        timeout=40,
    )
    if (
        observations["reconnected_ping"]["exit_code"] != 0
        or "carrier=1" not in observations["reconnected_ping"]["output"]
    ):
        raise GateFailure("重连后的 Guest ping/carrier 验证失败")
    observations["stable_mac"] = guest_command(
        pc1_console, "cat /sys/class/net/eth0/address"
    )
    if GUESTS[0].mac not in observations["stable_mac"]["output"]:
        raise GateFailure("Guest MAC 稳定性验证失败")
    close_console(pc1_console)

    install_novnc_service()
    with urllib.request.urlopen(
        f"http://127.0.0.1:{NOVNC_PORT}/vnc.html", timeout=10
    ) as response:
        novnc_http = {
            "status": response.status,
            "content_type": response.headers.get("Content-Type"),
        }
    observations["novnc"] = {
        "listen": f"127.0.0.1:{NOVNC_PORT}",
        "target": f"127.0.0.1:{GUESTS[0].vnc_port}",
        "http": novnc_http,
        "websocket": websocket_vnc_probe(),
    }
    observations["ovs"] = {
        "show": command_output(["ovs-vsctl", "show"]),
        "ports": command_output(
            ["ovs-ofctl", "-O", "OpenFlow13", "dump-ports", BRIDGE]
        ),
        "flows": command_output(
            ["ovs-ofctl", "-O", "OpenFlow13", "dump-flows", BRIDGE]
        ),
    }
    observations["domains"] = {
        guest.name: {
            "state": command_output(
                ["virsh", "-c", LIBVIRT_URI, "domstate", guest.name]
            ),
            "uuid": command_output(["virsh", "-c", LIBVIRT_URI, "domuuid", guest.name]),
            "interfaces": command_output(
                ["virsh", "-c", LIBVIRT_URI, "domiflist", guest.name]
            ),
            "vnc_display": command_output(
                ["virsh", "-c", LIBVIRT_URI, "vncdisplay", guest.name]
            ),
        }
        for guest in GUESTS
    }

    cleanup_result: dict[str, Any] | None = None
    if not keep:
        cleanup_result = cleanup_managed_resources()
    evidence = {
        "schema_version": "1.0",
        "gate": "G0",
        "passed": True,
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "source_revision": source_revision(),
        "host": host_identity(),
        "versions": collect_versions(),
        "image": {
            "path": str(image),
            "source": "https://cloud-images.ubuntu.com/releases/noble/release-20260725/ubuntu-24.04-server-cloudimg-amd64.img",
            "release": "Ubuntu 24.04 LTS release-20260725",
            "sha256": image_sha256,
            "expected_sha256": expected_sha256,
            "read_only": not bool(image.stat().st_mode & 0o222),
            "qemu_img_info": image_info,
            "qemu_img_check": image_check,
        },
        "pre_run_cleanup": pre_run_cleanup,
        "resources": resources,
        "observations": observations,
        "cleanup": cleanup_result,
        "resources_kept": keep,
        "limitations": [
            "noVNC 网关仅监听 127.0.0.1，是 G0 本机诊断入口，不是生产鉴权网关。",
            "本 Gate 验证真实 Ethernet、VM 生命周期、载波与 VNC；不声明 G1/G2/G3 已通过。",
        ],
    }
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "passed": True,
                "run_id": run_id,
                "evidence": str(evidence_path),
                "resources_kept": keep,
            },
            ensure_ascii=False,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, help="已校验且只读的 QCOW2 基础镜像")
    parser.add_argument("--sha256", help="管理员登记的基础镜像 SHA256")
    parser.add_argument(
        "--evidence", type=Path, default=Path("docs/poc/g0-evidence.json")
    )
    parser.add_argument(
        "--keep", action="store_true", help="通过后保留 VM、OVS 和本机 noVNC 服务"
    )
    parser.add_argument(
        "--cleanup-only", action="store_true", help="只清理本脚本的固定名称资源"
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.cleanup_only:
            print(json.dumps(cleanup_managed_resources(), ensure_ascii=False, indent=2))
            return 0
        if arguments.image is None or arguments.sha256 is None:
            raise GateFailure("执行 Gate 时必须同时提供 --image 与 --sha256")
        if not NOVNC_PASSWORD or not GUEST_PASSWORD:
            raise GateFailure(
                "G0_CREDENTIALS_MISSING：请设置 SIMLAB_G0_NOVNC_PASSWORD 和 "
                "SIMLAB_G0_GUEST_PASSWORD 后重试"
            )
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,8}", NOVNC_PASSWORD):
            raise GateFailure(
                "G0_VNC_PASSWORD_INVALID：VNC 密码须为 1–8 位字母、数字、下划线或连字符"
            )
        run_gate(
            arguments.image.resolve(),
            arguments.sha256.lower(),
            arguments.evidence,
            arguments.keep,
        )
        return 0
    except (
        GateFailure,
        OSError,
        subprocess.SubprocessError,
        pexpect.ExceptionPexpect,
    ) as error:
        print(
            json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
