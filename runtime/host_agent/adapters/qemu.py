# -*- coding: utf-8 -*-
"""受限 libvirt/QEMU 与 OVS adapter。"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import pwd
import re
import shutil
import subprocess
import time
import uuid
import xml.etree.ElementTree as element_tree
from dataclasses import replace
from pathlib import Path
from typing import Final
from uuid import UUID
from xml.sax.saxutils import escape

import libvirt

from runtime.host_agent.errors import HostAgentError
from runtime.host_agent.policy import bridge_name, domain_name, tap_name
from runtime.host_agent.port_identity import find_port_interface
from runtime.host_agent.protocol import AgentRequest, HostAction

LIBVIRT_URI: Final = "qemu:///system"
OVMF_CODE: Final = Path("/usr/share/OVMF/OVMF_CODE_4M.fd")
OVMF_VARS: Final = Path("/usr/share/OVMF/OVMF_VARS_4M.fd")
NETWORK_PREFIX: Final = 24
RUNTIME_NAMESPACE: Final = "urn:simlab:runtime:1"
COMMAND_TIMEOUT_SECONDS: Final = 120
SHUTDOWN_TIMEOUT_SECONDS: Final = 90
QEMU_USER: Final = "libvirt-qemu"


class QemuOvsAdapter:
    """只管理带 SimLab ownership metadata 的本机资源。"""

    def __init__(self, base_image: Path, expected_sha256: str, runtime_root: Path) -> None:
        self._base_image = base_image.resolve()
        self._image_import_root = Path(
            os.environ.get("SIMLAB_IMAGE_IMPORT_ROOT", "/var/lib/simlab/image-store/imported")
        ).resolve()
        self._expected_sha256 = expected_sha256.lower()
        self._runtime_root = runtime_root.resolve()
        self._external_domains = frozenset(
            item.strip()
            for item in os.environ.get(
                "SIMLAB_EXTERNAL_DOMAINS", "simlab-g0-pc1,simlab-g0-pc2"
            ).split(",")
            if item.strip()
        )
        self._validate_host_assets()

    def _run(self, arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        """使用固定 argv 执行受信宿主工具。"""
        completed = subprocess.run(
            arguments,
            capture_output=True,
            check=False,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
        )
        if check and completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()[:2_000]
            raise HostAgentError(
                "HOST_COMMAND_FAILED",
                f"受控宿主操作失败：{Path(arguments[0]).name}: {detail}",
                retryable=True,
            )
        return completed

    @staticmethod
    def _sha256_file(path: Path) -> str:
        """流式计算文件 SHA-256。"""
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _validate_host_assets(self) -> None:
        """在服务启动时验证固定镜像和宿主依赖。"""
        for command in ("qemu-img", "cloud-localds", "ovs-vsctl", "ip"):
            if shutil.which(command) is None:
                raise HostAgentError("HOST_DEPENDENCY_MISSING", f"缺少宿主工具：{command}")
        if not Path("/dev/kvm").exists():
            raise HostAgentError("KVM_UNAVAILABLE", "/dev/kvm 不存在")
        if not self._base_image.is_file():
            raise HostAgentError("BASE_IMAGE_MISSING", "登记的基础镜像不存在")
        if self._base_image.stat().st_mode & 0o222:
            raise HostAgentError("BASE_IMAGE_WRITABLE", "基础镜像必须为只读")
        if self._sha256_file(self._base_image) != self._expected_sha256:
            raise HostAgentError("BASE_IMAGE_HASH_MISMATCH", "基础镜像 SHA-256 不匹配")
        image_info = json.loads(
            self._run(["qemu-img", "info", "--output=json", str(self._base_image)]).stdout
        )
        if image_info.get("format") != "qcow2":
            raise HostAgentError("BASE_IMAGE_FORMAT_INVALID", "基础镜像实际格式不是 qcow2")
        for firmware in (OVMF_CODE, OVMF_VARS):
            if not firmware.is_file():
                raise HostAgentError("FIRMWARE_MISSING", f"缺少 UEFI 固件：{firmware.name}")
        self._runtime_root.mkdir(parents=True, exist_ok=True)
        qemu_account = pwd.getpwnam(QEMU_USER)
        os.chown(self._runtime_root, -1, qemu_account.pw_gid)
        self._runtime_root.chmod(0o750)

    def _image_for_request(self, request: AgentRequest) -> Path:
        """仅按已校验镜像 ID 找到只读文件，禁止客户端提交宿主路径。"""
        release = str(request.payload.get("image_release", "ubuntu-noble-20260725"))
        if release == "ubuntu-noble-20260725":
            return self._base_image
        digest = release.removeprefix("uploaded-")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HostAgentError("IMAGE_NOT_ALLOWED", "镜像 ID 无效；请从镜像清单选择")
        image = self._image_import_root / digest / "base.qcow2"
        if not image.is_file() or image.is_symlink():
            raise HostAgentError("IMAGE_MISSING", "导入镜像不存在；请联系管理员重新导入")
        if image.stat().st_mode & 0o222:
            raise HostAgentError("IMAGE_WRITABLE", "导入镜像必须只读；请联系管理员修复权限")
        if self._sha256_file(image) != digest:
            raise HostAgentError("IMAGE_HASH_MISMATCH", "导入镜像校验失败；请联系管理员重新导入")
        info = json.loads(self._run(["qemu-img", "info", "--output=json", str(image)]).stdout)
        if info.get("format") != "qcow2" or info.get("backing-filename"):
            raise HostAgentError("IMAGE_FORMAT_INVALID", "导入镜像格式无效；请重新导入独立 qcow2")
        return image

    @staticmethod
    def _connect() -> libvirt.virConnect:
        """连接系统 libvirt。"""
        connection = libvirt.open(LIBVIRT_URI)
        if connection is None:
            raise HostAgentError("LIBVIRT_UNAVAILABLE", "无法连接系统 libvirt", retryable=True)
        return connection

    @staticmethod
    def _mac_address(unit_id: UUID) -> str:
        """从 UUID 生成稳定的本地虚拟 MAC。"""
        octets = unit_id.bytes[-4:]
        return "52:54:" + ":".join(f"{value:02x}" for value in octets)

    @staticmethod
    def _mac_address_for_port(unit_id: UUID, index: int) -> str:
        """为 eth1..eth7 生成稳定的本地 MAC。"""
        digest = hashlib.sha256(f"{unit_id}:eth{index}".encode()).digest()
        return "52:54:" + ":".join(f"{value:02x}" for value in digest[:4])

    @staticmethod
    def _tap_name_for_port(unit_id: UUID, index: int) -> str:
        return tap_name(unit_id, index)

    def _resource_directory(self, request: AgentRequest) -> Path:
        """生成不可由请求覆盖的运行目录。"""
        assert request.experiment_id is not None
        assert request.unit_id is not None
        assert request.generation is not None
        return (
            self._runtime_root
            / str(request.experiment_id)
            / str(request.unit_id)
            / str(request.generation)
        )

    @staticmethod
    def _domain_metadata(request: AgentRequest) -> str:
        """生成 ownership metadata。"""
        assert request.experiment_id is not None
        assert request.unit_id is not None
        assert request.generation is not None
        return f"""<metadata>
    <simlab:resource xmlns:simlab='{RUNTIME_NAMESPACE}'>
      <simlab:experiment_id>{request.experiment_id}</simlab:experiment_id>
      <simlab:unit_id>{request.unit_id}</simlab:unit_id>
      <simlab:generation>{request.generation}</simlab:generation>
    </simlab:resource>
  </metadata>"""

    @staticmethod
    def _read_metadata(domain: libvirt.virDomain) -> tuple[UUID, UUID, int]:
        """读取并验证 domain ownership metadata。"""
        try:
            root = element_tree.fromstring(domain.XMLDesc(0))
            resource = root.find(f"./metadata/{{{RUNTIME_NAMESPACE}}}resource")
            if resource is None:
                raise ValueError("missing metadata")
            experiment_text = resource.findtext(f"{{{RUNTIME_NAMESPACE}}}experiment_id")
            unit_text = resource.findtext(f"{{{RUNTIME_NAMESPACE}}}unit_id")
            generation_text = resource.findtext(f"{{{RUNTIME_NAMESPACE}}}generation")
            return UUID(str(experiment_text)), UUID(str(unit_text)), int(str(generation_text))
        except (ValueError, TypeError, element_tree.ParseError) as error:
            raise HostAgentError(
                "RESOURCE_NOT_MANAGED", "目标 domain 缺少有效的 SimLab ownership metadata"
            ) from error

    def _lookup_owned_domain(
        self, connection: libvirt.virConnect, request: AgentRequest
    ) -> libvirt.virDomain:
        """按推导名称查找并核对归属。"""
        assert request.unit_id is not None
        assert request.generation is not None
        expected_name = domain_name(request.unit_id, request.generation)
        try:
            domain = connection.lookupByName(expected_name)
        except libvirt.libvirtError as error:
            raise HostAgentError("RUNTIME_UNIT_NOT_DEFINED", "运行单元尚未定义") from error
        metadata = self._read_metadata(domain)
        expected = (request.experiment_id, request.unit_id, request.generation)
        if metadata != expected:
            raise HostAgentError("RESOURCE_OWNERSHIP_MISMATCH", "运行资源归属不匹配")
        return domain

    def _lookup_request_domain(
        self, connection: libvirt.virConnect, request: AgentRequest
    ) -> tuple[libvirt.virDomain, bool]:
        """按请求选择受管运行单元或显式白名单外部 domain。"""
        external_name = request.payload.get("domain_name")
        if external_name is None:
            return self._lookup_owned_domain(connection, request), False
        if not isinstance(external_name, str) or external_name not in self._external_domains:
            raise HostAgentError("EXTERNAL_DOMAIN_NOT_ALLOWED", "外部 domain 不在宿主白名单中")
        try:
            return connection.lookupByName(external_name), True
        except libvirt.libvirtError as error:
            raise HostAgentError("EXTERNAL_DOMAIN_NOT_FOUND", "白名单外部 domain 不存在") from error

    def console_domain_name(self, request: AgentRequest) -> str:
        """串口接入前核对运行状态、受管资源归属或外部域白名单。"""
        connection = self._connect()
        try:
            domain, _external = self._lookup_request_domain(connection, request)
            if not domain.isActive():
                raise HostAgentError("CONSOLE_POWER_OFF", "设备未开机；请先在实验中开机。")
            root = element_tree.fromstring(domain.XMLDesc(0))
            if root.find("./devices/console") is None:
                raise HostAgentError(
                    "CONSOLE_UNAVAILABLE", "虚拟机未配置串口；请检查镜像模板或使用 VNC 控制台。"
                )
            return domain.name()
        finally:
            connection.close()

    def _ensure_bridge(self, experiment_id: UUID) -> str:
        """创建或核对实验专属的无宿主地址 OVS bridge。"""
        name = bridge_name(experiment_id)
        exists = self._run(["ovs-vsctl", "br-exists", name], check=False).returncode == 0
        if exists:
            owner = (
                self._run(["ovs-vsctl", "get", "bridge", name, "external_ids:simlab-owner"])
                .stdout.strip()
                .strip('"')
            )
            if owner != str(experiment_id):
                raise HostAgentError("RESOURCE_OWNERSHIP_MISMATCH", "OVS bridge 归属不匹配")
        else:
            self._run(["ovs-vsctl", "add-br", name])
            self._run(
                ["ovs-vsctl", "set", "bridge", name, f"external_ids:simlab-owner={experiment_id}"]
            )
        self._run(["ovs-vsctl", "set", "bridge", name, "other-config:disable-in-band=true"])
        self._run(["ovs-vsctl", "set-fail-mode", name, "standalone"])
        self._run(["ip", "link", "set", name, "up"])
        self._run(["ip", "addr", "flush", "dev", name])
        return name

    @staticmethod
    def _write_cloud_init(
        directory: Path, hostname: str, unit_id: UUID, ipv4_address: str,
        nic_aliases: list[str], appliance_role: str, *, radio_nic_alias: str = "",
        imported_image: bool = False,
    ) -> tuple[Path, Path, Path]:
        """写入无明文凭证的 cloud-init 配置。"""
        user_path = directory / "user-data"
        meta_path = directory / "meta-data"
        network_path = directory / "network-config"
        if imported_image:
            # 厂商 NOS 的配置必须在客体内完成；不能注入通用 Linux 桥接或账号。
            user_path.write_text("#cloud-config\n", encoding="utf-8")
            meta_path.write_text(
                f"instance-id: {directory.parent.name}-{directory.name}\n"
                f"local-hostname: {hostname}\n", encoding="utf-8",
            )
            network_path.write_text("version: 2\nethernets: {}\n", encoding="utf-8")
            for path in (user_path, meta_path, network_path):
                path.chmod(0o600)
            return user_path, meta_path, network_path
        password_hash = os.environ.get("SIMLAB_APPLIANCE_PASSWORD_HASH", "")
        if password_hash and not re.fullmatch(r"\$6\$[A-Za-z0-9./$]{20,256}", password_hash):
            raise HostAgentError(
                "APPLIANCE_PASSWORD_HASH_INVALID",
                "SIMLAB_APPLIANCE_PASSWORD_HASH 必须是有效 SHA-512 crypt 哈希",
            )
        appliance_user = (
            "    lock_passwd: false\n"
            f"    passwd: '{password_hash}'\n"
            if appliance_role != "desktop" and password_hash else "    lock_passwd: true\n"
        )
        appliance_files = ""
        appliance_commands = ""
        if appliance_role == "switch":
            interfaces = " ".join(nic_aliases)
            appliance_files = (
                "write_files:\n"
                "  - path: /usr/local/sbin/simlab-switch-bridge\n"
                "    permissions: '0755'\n"
                "    content: |\n"
                "      #!/bin/sh\n"
                "      set -eu\n"
                "      ip link show br0 >/dev/null 2>&1 || ip link add br0 type bridge\n"
                "      ip link set br0 up\n"
                f"      for interface in {interfaces}; do\n"
                "        ip link set \"$interface\" master br0\n"
                "        ip link set \"$interface\" up\n"
                "      done\n"
                "  - path: /etc/systemd/system/simlab-switch-bridge.service\n"
                "    permissions: '0644'\n"
                "    content: |\n"
                "      [Unit]\n"
                "      Description=SimLab Linux bridge for physical switch ports\n"
                "      After=network.target\n"
                "      [Service]\n"
                "      Type=oneshot\n"
                "      RemainAfterExit=yes\n"
                "      ExecStart=/usr/local/sbin/simlab-switch-bridge\n"
                "      [Install]\n"
                "      WantedBy=multi-user.target\n"
            )
            appliance_commands = "  - [systemctl, enable, --now, simlab-switch-bridge.service]\n"
        elif appliance_role in {"router", "firewall"}:
            forward = "1" if appliance_role == "router" else "0"
            appliance_files = (
                "write_files:\n"
                "  - path: /etc/sysctl.d/80-simlab-appliance.conf\n"
                "    permissions: '0644'\n"
                "    content: |\n"
                f"      net.ipv4.ip_forward = {forward}\n"
            )
            appliance_commands = "  - [sysctl, --system]\n"
        user_path.write_text(
            "#cloud-config\n"
            f"hostname: {hostname}\n"
            "manage_etc_hosts: true\n"
            "disable_root: true\n"
            "ssh_pwauth: false\n"
            "users:\n"
            "  - name: simlab\n"
            f"{appliance_user}"
            "    shell: /bin/bash\n"
            f"{appliance_files}"
            "runcmd:\n"
            "  - [systemctl, enable, --now, qemu-guest-agent]\n"
            f"{appliance_commands}"
            "final_message: 'SIMLAB_RUNTIME_READY'\n",
            encoding="utf-8",
        )
        meta_path.write_text(
            f"instance-id: {directory.parent.name}-{directory.name}\nlocal-hostname: {hostname}\n",
            encoding="utf-8",
        )
        network_lines = ["version: 2", "ethernets:"]
        for index, alias in enumerate(nic_aliases):
            mac_address = (
                QemuOvsAdapter._mac_address(unit_id) if index == 0
                else QemuOvsAdapter._mac_address_for_port(unit_id, index)
            )
            network_lines.extend([
                f"  {alias}:",
                "    match:",
                f'      macaddress: "{mac_address}"',
                f"    set-name: {alias}",
                f"    dhcp4: {'true' if alias == radio_nic_alias else 'false'}",
                "    dhcp6: false",
                "    accept-ra: false",
                "    optional: true",
            ])
            if index == 0 and appliance_role != "switch":
                network_lines.append(f"    addresses: [{ipv4_address}/{NETWORK_PREFIX}]")
        network_path.write_text("\n".join(network_lines) + "\n", encoding="utf-8")
        for path in (user_path, meta_path, network_path):
            path.chmod(0o600)
        return user_path, meta_path, network_path

    def _prepare_artifacts(self, request: AgentRequest) -> tuple[Path, Path, Path]:
        """幂等创建独立 overlay、seed 和 NVRAM。"""
        assert request.unit_id is not None
        base_image = self._image_for_request(request)
        directory = self._resource_directory(request)
        directory.mkdir(parents=True, exist_ok=True, mode=0o750)
        overlay = directory / "disk01.qcow2"
        seed = directory / "seed.iso"
        nvram = directory / "nvram.fd"
        if not overlay.exists():
            self._run(
                [
                    "qemu-img",
                    "create",
                    "-f",
                    "qcow2",
                    "-F",
                    "qcow2",
                    "-b",
                    str(base_image),
                    str(overlay),
                    f"{request.payload['disk_gib']}G",
                ]
            )
        else:
            image_info = json.loads(
                self._run(["qemu-img", "info", "--output=json", "-U", str(overlay)]).stdout
            )
            backing = Path(str(image_info.get("full-backing-filename", ""))).resolve()
            if image_info.get("format") != "qcow2" or backing != base_image:
                raise HostAgentError("OVERLAY_INVALID", "既有差异盘不属于登记的基础镜像")
        if not seed.exists():
            user_path, meta_path, network_path = self._write_cloud_init(
                directory,
                str(request.payload["hostname"]),
                request.unit_id,
                str(request.payload["ipv4_address"]),
                list(request.payload.get("nic_aliases", ["eth0"])),
                str(request.payload.get("appliance_role", "desktop")),
                radio_nic_alias=str(request.payload.get("radio_nic_alias", "")),
                imported_image=request.payload.get("image_release") != "ubuntu-noble-20260725",
            )
            self._run(
                [
                    "cloud-localds",
                    "--network-config",
                    str(network_path),
                    str(seed),
                    str(user_path),
                    str(meta_path),
                ]
            )
        if not nvram.exists():
            shutil.copyfile(OVMF_VARS, nvram)
        qemu_account = pwd.getpwnam(QEMU_USER)
        for managed_directory in (
            directory.parent.parent,
            directory.parent,
            directory,
        ):
            os.chown(managed_directory, -1, qemu_account.pw_gid)
            managed_directory.chmod(0o750)
        for artifact in (overlay, seed, nvram):
            os.chown(artifact, -1, qemu_account.pw_gid)
            artifact.chmod(0o660)
        return overlay, seed, nvram

    def _domain_xml(
        self,
        request: AgentRequest,
        bridge: str,
        overlay: Path,
        seed: Path,
        nvram: Path,
    ) -> str:
        """从白名单规格生成 libvirt XML。"""
        assert request.unit_id is not None
        assert request.generation is not None
        name = domain_name(request.unit_id, request.generation)
        domain_uuid = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"https://simlab.local/runtime/{request.unit_id}/{request.generation}",
        )
        nic_aliases = request.payload.get("nic_aliases", ["eth0"])
        interfaces_xml = "\n".join(
            f"""    <interface type='bridge'>
      <mac address='{self._mac_address(request.unit_id) if index == 0 else self._mac_address_for_port(request.unit_id, index)}'/><source bridge='{bridge}'/>
      <virtualport type='openvswitch'/><target dev='{tap_name(request.unit_id) if index == 0 else self._tap_name_for_port(request.unit_id, index)}'/>
      <model type='{request.payload["nic_model"]}'/><link state='{'up' if request.payload['link_up'] and index == 0 else 'down'}'/><alias name='simlab-{alias}'/>
    </interface>"""
            for index, alias in enumerate(nic_aliases)
        )
        return f"""<domain type='kvm'>
  <name>{name}</name>
  <uuid>{domain_uuid}</uuid>
  <title>SimLab managed runtime unit</title>
  <description>Managed exclusively by simlab-host-agent</description>
  <memory unit='MiB'>{request.payload["memory_mib"]}</memory>
  <currentMemory unit='MiB'>{request.payload["memory_mib"]}</currentMemory>
  <vcpu placement='static'>{request.payload["vcpu_count"]}</vcpu>
  {self._domain_metadata(request)}
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <loader readonly='yes' type='pflash'>{OVMF_CODE}</loader>
    <nvram>{escape(str(nvram))}</nvram>
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
      <target dev='sda' bus='sata'/><readonly/><alias name='simlab-seed'/>
    </disk>
    <controller type='sata' index='0'/>
    <controller type='usb' index='0' model='qemu-xhci'/>
{interfaces_xml}
    <serial type='pty'><target type='isa-serial' port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
    <input type='tablet' bus='usb'/>
    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
    <video><model type='{request.payload["gpu_model"]}' heads='1' primary='yes'/></video>
    <memballoon model='virtio'/>
  </devices>
</domain>"""

    def preflight(self) -> dict[str, object]:
        """返回当前 agent 实际可用能力。"""
        connection = self._connect()
        try:
            return {
                "source": "observed",
                "quality": "real_runtime",
                "libvirt_version": connection.getLibVersion(),
                "kvm_available": os.access("/dev/kvm", os.R_OK | os.W_OK),
                "base_image_sha256": self._expected_sha256,
                "base_image_read_only": not bool(self._base_image.stat().st_mode & 0o222),
                "actions": [
                    "BIND_EXTERNAL",
                    "ENSURE_DEFINED",
                    "START",
                    "SHUTDOWN",
                    "FORCE_OFF",
                    "RESET",
                    "OBSERVE",
                    "SET_LINK",
                    "WIRE_PORT",
                    "DELETE_UNIT",
                ],
            }
        finally:
            connection.close()

    def ensure_defined(self, request: AgentRequest) -> dict[str, object]:
        """幂等确保独立磁盘、网络和 domain 已定义。"""
        assert request.experiment_id is not None
        assert request.unit_id is not None
        assert request.generation is not None
        ipaddress.IPv4Address(str(request.payload["ipv4_address"]))
        bridge = self._ensure_bridge(request.experiment_id)
        connection = self._connect()
        try:
            for domain in connection.listAllDomains(0):
                try:
                    _, existing_unit_id, existing_generation = self._read_metadata(domain)
                except HostAgentError:
                    continue
                if (
                    existing_unit_id == request.unit_id
                    and existing_generation != request.generation
                ):
                    raise HostAgentError("STALE_GENERATION_PRESENT", "该运行单元仍存在其他代次资源")
            try:
                domain = self._lookup_owned_domain(connection, request)
            except HostAgentError as error:
                if error.code != "RUNTIME_UNIT_NOT_DEFINED":
                    raise
                overlay, seed, nvram = self._prepare_artifacts(request)
                xml = self._domain_xml(request, bridge, overlay, seed, nvram)
                domain = connection.defineXML(xml)
                if domain is None:
                    raise HostAgentError("DOMAIN_DEFINE_FAILED", "libvirt 未返回已定义 domain")
                domain.setAutostart(0)
            return self._observe_domain(request, domain)
        finally:
            connection.close()

    def _observe_domain(
        self, request: AgentRequest, domain: libvirt.virDomain, *, external: bool = False
    ) -> dict[str, object]:
        """把 libvirt 状态转换成稳定观测结构。"""
        assert request.experiment_id is not None
        assert request.unit_id is not None
        assert request.generation is not None
        state_code = domain.state(0)[0]
        running_states = {
            libvirt.VIR_DOMAIN_RUNNING,
            libvirt.VIR_DOMAIN_BLOCKED,
            libvirt.VIR_DOMAIN_PAUSED,
            libvirt.VIR_DOMAIN_PMSUSPENDED,
        }
        if state_code in running_states:
            power_state = "RUNNING"
        elif state_code in {libvirt.VIR_DOMAIN_SHUTOFF, libvirt.VIR_DOMAIN_SHUTDOWN}:
            power_state = "STOPPED"
        else:
            power_state = "UNKNOWN"
        xml = element_tree.fromstring(domain.XMLDesc(0))
        graphics = xml.find("./devices/graphics[@type='vnc']")
        vnc_port = int(graphics.get("port", "-1")) if graphics is not None else -1
        interface = xml.find("./devices/interface")
        source = interface.find("source") if interface is not None else None
        target = interface.find("target") if interface is not None else None
        mac = interface.find("mac") if interface is not None else None
        interfaces = []
        for index, candidate in enumerate(xml.findall("./devices/interface")):
            candidate_alias = candidate.find("alias")
            candidate_target = candidate.find("target")
            candidate_mac = candidate.find("mac")
            alias_name = candidate_alias.get("name", "") if candidate_alias is not None else ""
            port_alias = (
                alias_name.removeprefix("simlab-")
                if alias_name.startswith("simlab-")
                else f"eth{index}"
            )
            tap_name_value = candidate_target.get("dev", "") if candidate_target is not None else ""
            ovs_bridge = ""
            if power_state == "RUNNING" and re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", tap_name_value):
                found_bridge = self._run(["ovs-vsctl", "iface-to-br", tap_name_value], check=False)
                if found_bridge.returncode == 0:
                    ovs_bridge = found_bridge.stdout.strip()
            link_node = candidate.find("link")
            interfaces.append({
                "port_alias": port_alias or f"eth{index}",
                "target": tap_name_value,
                "mac_address": candidate_mac.get("address", "") if candidate_mac is not None else "",
                "ovs_bridge": ovs_bridge,
                "link_state": (link_node.get("state", "up") if link_node is not None else "up").upper(),
            })
        return {
            "unit_id": str(request.unit_id),
            "experiment_id": str(request.experiment_id),
            "generation": request.generation,
            "domain_name": domain.name(),
            "domain_uuid": domain.UUIDString(),
            "power_state": power_state,
            "source": "observed",
            "quality": "real_runtime",
            "bridge": (
                str(source.get("bridge", ""))
                if external and source is not None
                else bridge_name(request.experiment_id)
            ),
            "tap": (
                str(target.get("dev", ""))
                if external and target is not None
                else tap_name(request.unit_id)
            ),
            "mac_address": (
                str(mac.get("address", ""))
                if external and mac is not None
                else self._mac_address(request.unit_id)
            ),
            "interfaces": interfaces,
            "vnc": {"listen": "127.0.0.1", "port": vnc_port},
            "external_binding": external,
        }

    def bind_external(self, request: AgentRequest) -> dict[str, object]:
        """核对白名单 G0 domain，并只返回实际观测，不接管其定义。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            if not external:
                raise HostAgentError("EXTERNAL_DOMAIN_REQUIRED", "未指定外部 domain")
            return self._observe_domain(request, domain, external=True)
        finally:
            connection.close()

    def observe(self, request: AgentRequest) -> dict[str, object]:
        """读取实际 domain 状态。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            return self._observe_domain(request, domain, external=external)
        finally:
            connection.close()

    def start(self, request: AgentRequest) -> dict[str, object]:
        """启动已定义 domain。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            if not domain.isActive():
                domain.create()
            return self._observe_domain(request, domain, external=external)
        finally:
            connection.close()

    def shutdown(self, request: AgentRequest) -> dict[str, object]:
        """请求正常关机并等待实际停止。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            if domain.isActive():
                try:
                    domain.shutdownFlags(libvirt.VIR_DOMAIN_SHUTDOWN_GUEST_AGENT)
                except libvirt.libvirtError:
                    domain.shutdown()
                deadline = time.monotonic() + SHUTDOWN_TIMEOUT_SECONDS
                while domain.isActive() and time.monotonic() < deadline:
                    time.sleep(1)
                if domain.isActive():
                    raise HostAgentError(
                        "GUEST_SHUTDOWN_TIMEOUT",
                        "客体未在截止时间内正常关机；未自动强制断电",
                        retryable=True,
                    )
            return self._observe_domain(request, domain, external=external)
        finally:
            connection.close()

    def force_off(self, request: AgentRequest) -> dict[str, object]:
        """强制停止指定且已核对归属的 domain。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            if domain.isActive():
                domain.destroy()
            return self._observe_domain(request, domain, external=external)
        finally:
            connection.close()

    def reset(self, request: AgentRequest) -> dict[str, object]:
        """重置正在运行的 domain。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            if not domain.isActive():
                raise HostAgentError("RUNTIME_NOT_RUNNING", "停止状态的运行单元不能重置")
            domain.reset(0)
            return self._observe_domain(request, domain, external=external)
        finally:
            connection.close()

    def set_link(self, request: AgentRequest) -> dict[str, object]:
        """保留 vNIC 身份，仅改变已声明端口的链路状态。"""
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            root = element_tree.fromstring(domain.XMLDesc(0))
            wanted_alias = str(request.payload["port_alias"])
            interface = self._request_interface(root, request, wanted_alias, external=external)
            link = interface.find("link")
            if link is None:
                link = element_tree.SubElement(interface, "link")
            link.set("state", "up" if request.payload["up"] else "down")
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
            if domain.isActive():
                flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
            domain.updateDeviceFlags(element_tree.tostring(interface, encoding="unicode"), flags)
            observation = self._observe_domain(request, domain, external=external)
            observation["port_alias"] = request.payload["port_alias"]
            observation["link_state"] = "UP" if request.payload["up"] else "DOWN"
            return observation
        finally:
            connection.close()

    def _request_interface(
        self, root: element_tree.Element, request: AgentRequest, alias: str, *, external: bool
    ) -> element_tree.Element:
        """按 ethN 序号定位网卡；受管 VM 再核对稳定 MAC/TAP，避开 libvirt 的 netN 别名。"""
        if external:
            return find_port_interface(root, alias, external=True)
        assert request.unit_id is not None
        index = int(alias[3:])
        expected_mac = (
            self._mac_address(request.unit_id) if index == 0
            else self._mac_address_for_port(request.unit_id, index)
        )
        expected_tap = self._tap_name_for_port(request.unit_id, index)
        if index > 0:
            # 旧版本 eth1..eth7 使用 slt 前缀；只对 MAC 仍匹配的已有 domain 保留兼容。
            legacy_tap = f"slt{request.unit_id.hex[:10]}{index:02d}"
            candidate = root.findall("./devices/interface")
            if index < len(candidate):
                target = candidate[index].find("target")
                if target is not None and target.get("dev") == legacy_tap:
                    expected_tap = legacy_tap
        return find_port_interface(
            root, alias, external=False, expected_mac=expected_mac,
            expected_tap=expected_tap,
        )

    def wire_port(self, request: AgentRequest) -> dict[str, object]:
        """只移动已核对 domain 的真实 TAP 到隔离 OVS 网段。"""
        network_id = UUID(str(request.payload["network_id"]))
        alias = str(request.payload["port_alias"])
        desired_up = bool(request.payload["up"])
        link_payload = {"port_alias": alias, "up": False}
        if "domain_name" in request.payload:
            link_payload["domain_name"] = request.payload["domain_name"]
        connection = self._connect()
        try:
            domain, external = self._lookup_request_domain(connection, request)
            root = element_tree.fromstring(domain.XMLDesc(0))
            interface = self._request_interface(root, request, alias, external=external)
            target = interface.find("target")
            tap = target.get("dev", "") if target is not None else ""
            if not desired_up or not domain.isActive():
                observed = self.set_link(replace(request, action=HostAction.SET_LINK, payload=link_payload))
                observed["network_status"] = "DISCONNECTED" if not desired_up else "PENDING_POWER_ON"
                return observed
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", tap):
                raise HostAgentError("TAP_UNAVAILABLE", "虚拟网卡 TAP 尚未就绪，请刷新后重试")
            if self._run(["ovs-vsctl", "iface-to-br", tap], check=False).returncode != 0:
                raise HostAgentError("TAP_NOT_ON_OVS", "该网卡没有连接到 OVS")
            old_bridge = self._run(["ovs-vsctl", "iface-to-br", tap]).stdout.strip()
            bridge = self._ensure_bridge(network_id)
            self._run(["ovs-vsctl", "set", "bridge", bridge, "external_ids:simlab-network=true"])
            if old_bridge != bridge:
                self._run(["ovs-vsctl", "--if-exists", "del-port", tap])
                self._run(["ovs-vsctl", "--may-exist", "add-port", bridge, tap])
            if self._run(["ovs-vsctl", "iface-to-br", tap]).stdout.strip() != bridge:
                raise HostAgentError("NETWORK_WIRING_FAILED", "TAP 没有进入目标网段")
            link_payload["up"] = True
            observed = self.set_link(replace(request, action=HostAction.SET_LINK, payload=link_payload))
            if self._run(["ovs-vsctl", "iface-to-br", tap]).stdout.strip() != bridge:
                raise HostAgentError("NETWORK_WIRING_FAILED", "libvirt 更新网卡后 TAP 脱离目标网段")
            if old_bridge != bridge and old_bridge.startswith("slb"):
                marker = self._run(
                    ["ovs-vsctl", "get", "bridge", old_bridge, "external_ids:simlab-network"],
                    check=False,
                )
                if marker.returncode == 0 and marker.stdout.strip().strip('"') == "true":
                    ports = self._run(["ovs-vsctl", "list-ports", old_bridge]).stdout.strip()
                    if not ports:
                        self._run(["ovs-vsctl", "del-br", old_bridge])
            observed["network_status"] = "WIRED"
            observed["network_bridge"] = bridge
            return observed
        finally:
            connection.close()

    def wire_cloud(self, request: AgentRequest) -> dict[str, object]:
        """用两端均标记归属的 OVS patch 连接实验网段和批准的宿主上联桥。"""
        assert request.experiment_id is not None
        cloud_id = UUID(str(request.payload["cloud_id"]))
        network_id = UUID(str(request.payload["network_id"]))
        uplink = str(request.payload["uplink_bridge"])
        up = bool(request.payload["up"])
        allowed = frozenset(
            item.strip() for item in os.environ.get("SIMLAB_CLOUD_UPLINK_BRIDGES", "").split(",")
            if item.strip()
        )
        if up and uplink not in allowed:
            raise HostAgentError(
                "CLOUD_UPLINK_NOT_ALLOWED", "上联桥未获管理员批准；请配置 SIMLAB_CLOUD_UPLINK_BRIDGES 后重试"
            )
        if up and (uplink.startswith("slb") or self._run(
            ["ovs-vsctl", "br-exists", uplink], check=False
        ).returncode != 0):
            raise HostAgentError(
                "CLOUD_UPLINK_UNAVAILABLE", "批准的宿主 OVS 桥不存在；请管理员检查桥接网卡"
            )
        inside = f"sci{cloud_id.hex[:12]}"
        outside = f"scu{cloud_id.hex[:12]}"
        marker = str(request.experiment_id)
        existing_bridges: dict[str, str] = {}
        for port in (inside, outside):
            existing = self._run(["ovs-vsctl", "iface-to-br", port], check=False)
            if existing.returncode != 0:
                continue
            existing_bridges[port] = existing.stdout.strip()
            owner = self._run(
                ["ovs-vsctl", "get", "interface", port, "external_ids:simlab-owner"],
                check=False,
            )
            if owner.returncode != 0 or owner.stdout.strip().strip('"') != marker:
                raise HostAgentError("RESOURCE_OWNERSHIP_MISMATCH", "Cloud 接线端口归属不匹配")
        bridge = self._ensure_bridge(network_id) if up else ""
        if up and existing_bridges == {inside: bridge, outside: uplink}:
            return {
                "cloud_id": str(cloud_id), "status": "WIRED",
                "network_bridge": bridge, "uplink_bridge": uplink,
                "quality": "real_runtime",
            }
        for port in (inside, outside):
            if port not in existing_bridges:
                continue
            self._run(["ovs-vsctl", "--if-exists", "del-port", port])
        old_bridge = existing_bridges.get(inside, "")
        if old_bridge.startswith("slb") and old_bridge != bridge_name(network_id):
            owner = self._run(
                ["ovs-vsctl", "get", "bridge", old_bridge, "external_ids:simlab-owner"],
                check=False,
            )
            if owner.returncode == 0 and owner.stdout.strip().strip('"') == marker:
                ports = self._run(["ovs-vsctl", "list-ports", old_bridge]).stdout.strip()
                if not ports:
                    self._run(["ovs-vsctl", "del-br", old_bridge])
        if not up:
            return {"cloud_id": str(cloud_id), "status": "DISCONNECTED", "quality": "real_runtime"}
        if bridge == uplink:
            raise HostAgentError("CLOUD_UPLINK_INVALID", "Cloud 上联不能指向实验自身网段")
        for target, port, peer in ((bridge, inside, outside), (uplink, outside, inside)):
            self._run([
                "ovs-vsctl", "--may-exist", "add-port", target, port, "--",
                "set", "interface", port, "type=patch", f"options:peer={peer}",
                f"external_ids:simlab-owner={marker}", f"external_ids:simlab-cloud={cloud_id}",
            ])
        return {
            "cloud_id": str(cloud_id), "status": "WIRED", "network_bridge": bridge,
            "uplink_bridge": uplink, "quality": "real_runtime",
        }

    def delete_unit(self, request: AgentRequest) -> dict[str, object]:
        """停止并删除一个精确归属的运行单元。"""
        connection = self._connect()
        try:
            domain = self._lookup_owned_domain(connection, request)
            if domain.isActive():
                domain.destroy()
            domain.undefineFlags(libvirt.VIR_DOMAIN_UNDEFINE_NVRAM)
        finally:
            connection.close()
        directory = self._resource_directory(request)
        if directory.exists():
            shutil.rmtree(directory)
        for parent in (directory.parent, directory.parent.parent):
            try:
                parent.rmdir()
            except OSError:
                break
        return {
            "unit_id": str(request.unit_id),
            "generation": request.generation,
            "deleted": True,
            "source": "observed",
            "quality": "real_runtime",
        }

    def delete_fabric(self, request: AgentRequest) -> dict[str, object]:
        """仅在无关联 domain 时删除精确归属的实验 bridge。"""
        assert request.experiment_id is not None
        connection = self._connect()
        try:
            for domain in connection.listAllDomains(0):
                try:
                    experiment_id, _, _ = self._read_metadata(domain)
                except HostAgentError:
                    continue
                if experiment_id == request.experiment_id:
                    raise HostAgentError("FABRIC_IN_USE", "实验仍有已定义运行单元")
        finally:
            connection.close()
        name = bridge_name(request.experiment_id)
        if self._run(["ovs-vsctl", "br-exists", name], check=False).returncode == 0:
            owner = (
                self._run(["ovs-vsctl", "get", "bridge", name, "external_ids:simlab-owner"])
                .stdout.strip()
                .strip('"')
            )
            if owner != str(request.experiment_id):
                raise HostAgentError("RESOURCE_OWNERSHIP_MISMATCH", "OVS bridge 归属不匹配")
            self._run(["ovs-vsctl", "del-br", name])
        return {
            "experiment_id": str(request.experiment_id),
            "bridge": name,
            "deleted": True,
        }
