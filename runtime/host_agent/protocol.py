# -*- coding: utf-8 -*-
"""Host Agent JSON Lines 协议与严格请求校验。"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Final
from uuid import UUID

from runtime.host_agent.errors import HostAgentError
from runtime.host_agent.policy import MAX_RUNTIME_NICS, PolicyError, validate_link_request

SCHEMA_VERSION: Final = "1.0"
MAX_REQUEST_BYTES: Final = 65_536
MAX_MEMORY_MIB: Final = 16_384
MIN_MEMORY_MIB: Final = 512
MAX_VCPU_COUNT: Final = 8
MAX_DISK_GIB: Final = 64
MIN_DISK_GIB: Final = 4
DESKTOP_PROFILE: Final = "linux-cloud-profile-v1"
APPLIANCE_PROFILES: Final = {
    "linux-switch-profile-v1": "switch",
    "linux-router-profile-v1": "router",
    "linux-firewall-profile-v1": "firewall",
}
ALLOWED_PROFILE_RELEASES: Final = frozenset({DESKTOP_PROFILE, *APPLIANCE_PROFILES})
RUNTIME_NETWORK: Final = ipaddress.IPv4Network("10.88.0.0/24")
HOSTNAME_PATTERN: Final = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
DOMAIN_NAME_PATTERN: Final = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$")


class HostAction(StrEnum):
    """Host Agent 唯一允许执行的动作。"""

    PREFLIGHT = "PREFLIGHT"
    BIND_EXTERNAL = "BIND_EXTERNAL"
    ENSURE_DEFINED = "ENSURE_DEFINED"
    START = "START"
    SHUTDOWN = "SHUTDOWN"
    FORCE_OFF = "FORCE_OFF"
    RESET = "RESET"
    OBSERVE = "OBSERVE"
    CONSOLE_ATTACH = "CONSOLE_ATTACH"
    SET_LINK = "SET_LINK"
    WIRE_PORT = "WIRE_PORT"
    CLOUD_WIRE = "CLOUD_WIRE"
    DELETE_UNIT = "DELETE_UNIT"
    DELETE_FABRIC = "DELETE_FABRIC"


COMMON_KEYS: Final = frozenset(
    {
        "schema_version",
        "operation_id",
        "action",
        "experiment_id",
        "unit_id",
        "generation",
        "payload",
    }
)
SPEC_KEYS: Final = frozenset(
    {
        "profile_release_id",
        "memory_mib",
        "vcpu_count",
        "disk_gib",
        "ipv4_address",
        "hostname",
        "link_up",
        "nic_model",
        "nic_aliases",
        "radio_nic_alias",
        "gpu_model",
        "appliance_role",
        "image_release",
    }
)


@dataclass(frozen=True)
class AgentRequest:
    """经过严格验证的 Host Agent 请求。"""

    operation_id: UUID
    action: HostAction
    experiment_id: UUID | None
    unit_id: UUID | None
    generation: int | None
    payload: dict[str, object]

    def request_hash(self) -> str:
        """计算操作防重使用的规范哈希。"""
        encoded = json.dumps(
            self.as_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        return hashlib.sha256(encoded).hexdigest()

    def as_dict(self) -> dict[str, object]:
        """返回规范请求对象。"""
        return {
            "schema_version": SCHEMA_VERSION,
            "operation_id": str(self.operation_id),
            "action": self.action.value,
            "experiment_id": str(self.experiment_id) if self.experiment_id else None,
            "unit_id": str(self.unit_id) if self.unit_id else None,
            "generation": self.generation,
            "payload": self.payload,
        }


def _uuid_value(value: object, field_name: str, *, required: bool = True) -> UUID | None:
    """读取一个 UUID 字段。"""
    if value is None and not required:
        return None
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as error:
        raise HostAgentError("REQUEST_INVALID", f"{field_name} 必须是 UUID") from error


def _integer_value(payload: dict[str, object], key: str, minimum: int, maximum: int) -> int:
    """读取并限制整数参数。"""
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise HostAgentError("SPEC_INVALID", f"{key} 必须是 {minimum} 到 {maximum} 之间的整数")
    return value


def _validate_spec(payload: dict[str, object]) -> None:
    """验证由控制平面编译的有限 VM 规格。"""
    payload.setdefault("nic_aliases", ["eth0"])
    payload.setdefault("radio_nic_alias", "")
    payload.setdefault("image_release", "ubuntu-noble-20260725")
    unknown_keys = set(payload) - SPEC_KEYS
    if unknown_keys:
        raise HostAgentError("SPEC_UNKNOWN_FIELD", f"规格包含未知字段：{sorted(unknown_keys)}")
    if set(payload) - {"appliance_role"} != SPEC_KEYS - {"appliance_role"}:
        raise HostAgentError("SPEC_MISSING_FIELD", "规格字段不完整")
    if payload["profile_release_id"] not in ALLOWED_PROFILE_RELEASES:
        raise HostAgentError("PROFILE_NOT_ALLOWED", "Runtime Profile 未经当前节点批准")
    is_appliance = payload["profile_release_id"] in APPLIANCE_PROFILES
    _integer_value(payload, "memory_mib", MIN_MEMORY_MIB, MAX_MEMORY_MIB if is_appliance else 4_096)
    _integer_value(payload, "vcpu_count", 1, MAX_VCPU_COUNT if is_appliance else 4)
    _integer_value(payload, "disk_gib", MIN_DISK_GIB, MAX_DISK_GIB if is_appliance else 32)
    role = payload.get("appliance_role", "desktop")
    expected_role = APPLIANCE_PROFILES.get(payload["profile_release_id"], "desktop")
    if role != expected_role:
        raise HostAgentError("APPLIANCE_ROLE_INVALID", "设备角色与 Runtime Profile 不匹配")
    image_release = payload["image_release"]
    if not isinstance(image_release, str) or not (
        image_release == "ubuntu-noble-20260725"
        or (is_appliance and re.fullmatch(r"uploaded-[0-9a-f]{64}", image_release))
    ):
        raise HostAgentError("IMAGE_NOT_ALLOWED", "镜像未登记为受控网络设备 qcow2；请重新导入或选择已批准镜像")
    hostname = payload["hostname"]
    if not isinstance(hostname, str) or not HOSTNAME_PATTERN.fullmatch(hostname):
        raise HostAgentError("SPEC_INVALID", "hostname 不符合受控主机名格式")
    if not isinstance(payload["ipv4_address"], str):
        raise HostAgentError("SPEC_INVALID", "ipv4_address 必须是字符串")
    try:
        address = ipaddress.IPv4Address(payload["ipv4_address"])
    except ipaddress.AddressValueError as error:
        raise HostAgentError("SPEC_INVALID", "ipv4_address 不是有效 IPv4 地址") from error
    if address not in RUNTIME_NETWORK or address in {
        RUNTIME_NETWORK.network_address,
        RUNTIME_NETWORK.broadcast_address,
    }:
        raise HostAgentError("SPEC_INVALID", "ipv4_address 不属于受控实验网段")
    if not isinstance(payload["link_up"], bool):
        raise HostAgentError("SPEC_INVALID", "link_up 必须是布尔值")
    if payload["nic_model"] not in {"virtio", "e1000"}:
        raise HostAgentError("SPEC_INVALID", "nic_model 必须是 virtio 或 e1000")
    aliases = payload["nic_aliases"]
    if (
        not isinstance(aliases, list)
        or not 1 <= len(aliases) <= (MAX_RUNTIME_NICS if is_appliance else 8)
        or aliases != [f"eth{index}" for index in range(len(aliases))]
    ):
        raise HostAgentError("SPEC_INVALID", "nic_aliases 必须从 eth0 连续编号，数量不超过当前 Profile 限额")
    radio_alias = payload["radio_nic_alias"]
    if not isinstance(radio_alias, str) or (radio_alias and (
        radio_alias not in aliases or radio_alias == "eth0" or is_appliance
    )):
        raise HostAgentError(
            "RADIO_NIC_INVALID", "射频虚拟网卡必须是桌面 VM 的独立 eth1..eth7 接口"
        )
    if payload["gpu_model"] != "virtio":
        raise HostAgentError("SPEC_INVALID", "gpu_model 未经当前 Runtime Profile 批准")


def parse_request(raw_request: bytes) -> AgentRequest:
    """解析一条有限长度的 JSON 请求。"""
    if not raw_request or len(raw_request) > MAX_REQUEST_BYTES:
        raise HostAgentError("REQUEST_SIZE_INVALID", "请求为空或超过大小限制")
    try:
        decoded = json.loads(raw_request)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HostAgentError("REQUEST_JSON_INVALID", "请求不是有效 JSON") from error
    if not isinstance(decoded, dict):
        raise HostAgentError("REQUEST_INVALID", "请求根节点必须是对象")
    unknown_keys = set(decoded) - COMMON_KEYS
    if unknown_keys:
        raise HostAgentError("REQUEST_UNKNOWN_FIELD", f"请求包含未知字段：{sorted(unknown_keys)}")
    if decoded.get("schema_version") != SCHEMA_VERSION:
        raise HostAgentError("SCHEMA_VERSION_UNSUPPORTED", "不支持的协议版本")
    operation_id = _uuid_value(decoded.get("operation_id"), "operation_id")
    try:
        action = HostAction(str(decoded.get("action")))
    except ValueError as error:
        raise HostAgentError("ACTION_NOT_ALLOWED", "Host Agent 动作不在白名单") from error
    payload = decoded.get("payload", {})
    if not isinstance(payload, dict):
        raise HostAgentError("REQUEST_INVALID", "payload 必须是对象")

    if action is HostAction.PREFLIGHT:
        if (
            payload
            or decoded.get("experiment_id")
            or decoded.get("unit_id")
            or decoded.get("generation") is not None
        ):
            raise HostAgentError("REQUEST_INVALID", "PREFLIGHT 不接受资源参数")
        return AgentRequest(operation_id, action, None, None, None, {})

    experiment_id = _uuid_value(decoded.get("experiment_id"), "experiment_id")
    unit_required = action not in {HostAction.DELETE_FABRIC, HostAction.CLOUD_WIRE}
    unit_id = _uuid_value(decoded.get("unit_id"), "unit_id", required=unit_required)
    generation_value = decoded.get("generation")
    if unit_required:
        if isinstance(generation_value, bool) or not isinstance(generation_value, int):
            raise HostAgentError("REQUEST_INVALID", "generation 必须是正整数")
        if generation_value < 1:
            raise HostAgentError("REQUEST_INVALID", "generation 必须是正整数")
        generation = generation_value
    else:
        if generation_value is not None or unit_id is not None or (payload and action is HostAction.DELETE_FABRIC):
            raise HostAgentError("REQUEST_INVALID", "DELETE_FABRIC 不接受 unit 或 payload")
        generation = None

    if action is HostAction.ENSURE_DEFINED:
        _validate_spec(payload)
    elif action is HostAction.BIND_EXTERNAL:
        if set(payload) != {"domain_name"}:
            raise HostAgentError("REQUEST_INVALID", "BIND_EXTERNAL 仅接受 domain_name")
        domain_value = payload["domain_name"]
        if not isinstance(domain_value, str) or not DOMAIN_NAME_PATTERN.fullmatch(domain_value):
            raise HostAgentError("REQUEST_INVALID", "domain_name 格式无效")
    elif action is HostAction.SET_LINK:
        if set(payload) not in ({"port_alias", "up"}, {"port_alias", "up", "domain_name"}):
            raise HostAgentError(
                "REQUEST_INVALID", "SET_LINK 仅接受 port_alias、up 和可选 domain_name"
            )
        port_alias = payload["port_alias"]
        if not isinstance(port_alias, str) or not isinstance(payload["up"], bool):
            raise HostAgentError("REQUEST_INVALID", "链路参数类型无效")
        domain_value = payload.get("domain_name")
        if domain_value is not None and (
            not isinstance(domain_value, str) or not DOMAIN_NAME_PATTERN.fullmatch(domain_value)
        ):
            raise HostAgentError("REQUEST_INVALID", "domain_name 格式无效")
        try:
            validate_link_request(port_alias, generation)
        except PolicyError as error:
            raise HostAgentError("PORT_NOT_ALLOWED", str(error)) from error
    elif action is HostAction.WIRE_PORT:
        if set(payload) not in (
            {"port_alias", "network_id", "up"},
            {"port_alias", "network_id", "up", "domain_name"},
        ):
            raise HostAgentError("REQUEST_INVALID", "WIRE_PORT 参数必须为端口、网络 ID 和链路状态")
        if not isinstance(payload["up"], bool):
            raise HostAgentError("REQUEST_INVALID", "链路状态必须是布尔值")
        try:
            validate_link_request(payload["port_alias"], generation)
            _uuid_value(payload["network_id"], "network_id")
        except (PolicyError, TypeError) as error:
            raise HostAgentError("PORT_NOT_ALLOWED", "虚拟网卡别名无效") from error
        domain_value = payload.get("domain_name")
        if domain_value is not None and (
            not isinstance(domain_value, str) or not DOMAIN_NAME_PATTERN.fullmatch(domain_value)
        ):
            raise HostAgentError("REQUEST_INVALID", "domain_name 格式无效")
    elif action is HostAction.CLOUD_WIRE:
        if set(payload) != {"cloud_id", "network_id", "uplink_bridge", "up"}:
            raise HostAgentError("REQUEST_INVALID", "CLOUD_WIRE 参数必须包含 Cloud、网段、上联桥和状态")
        _uuid_value(payload["cloud_id"], "cloud_id")
        _uuid_value(payload["network_id"], "network_id")
        bridge = payload["uplink_bridge"]
        if not isinstance(payload["up"], bool) or not isinstance(bridge, str) or (
            bridge and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,14}", bridge)
        ) or (payload["up"] and not bridge):
            raise HostAgentError("CLOUD_UPLINK_INVALID", "上联桥名称或接线状态无效，请重新选择桥接网卡")
    elif (
        action
        in {
            HostAction.START,
            HostAction.SHUTDOWN,
            HostAction.FORCE_OFF,
            HostAction.RESET,
            HostAction.OBSERVE,
            HostAction.CONSOLE_ATTACH,
        }
        and payload
    ):
        if set(payload) != {"domain_name"}:
            raise HostAgentError("REQUEST_INVALID", f"{action.value} 仅接受可选 domain_name")
        domain_value = payload["domain_name"]
        if not isinstance(domain_value, str) or not DOMAIN_NAME_PATTERN.fullmatch(domain_value):
            raise HostAgentError("REQUEST_INVALID", "domain_name 格式无效")
    elif payload:
        raise HostAgentError("REQUEST_INVALID", f"{action.value} 不接受 payload")
    return AgentRequest(operation_id, action, experiment_id, unit_id, generation, payload)


def success_response(operation_id: UUID, result: dict[str, object]) -> dict[str, object]:
    """生成成功响应。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "operation_id": str(operation_id),
        "ok": True,
        "result": result,
    }


def error_response(operation_id: UUID | None, error: HostAgentError) -> dict[str, object]:
    """生成安全的失败响应。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "operation_id": str(operation_id) if operation_id else None,
        "ok": False,
        "error": error.as_dict(),
    }
