# -*- coding: utf-8 -*-
"""宿主机结构化动作白名单与资源名称生成。"""

from __future__ import annotations

import re
from enum import Enum
from uuid import UUID


LINUX_INTERFACE_MAX_LENGTH = 15
PORT_ALIAS_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
MAX_RUNTIME_NICS = 32
ALLOWED_PORT_ALIASES = frozenset(f"eth{index}" for index in range(MAX_RUNTIME_NICS))


class HostAction(str, Enum):
    """host-agent 允许的动作。"""

    DEFINE_DOMAIN = "DEFINE_DOMAIN"
    START_DOMAIN = "START_DOMAIN"
    SHUTDOWN_DOMAIN = "SHUTDOWN_DOMAIN"
    FORCE_OFF_DOMAIN = "FORCE_OFF_DOMAIN"
    SET_LINK = "SET_LINK"
    WIRE_PORT = "WIRE_PORT"
    OBSERVE = "OBSERVE"


class PolicyError(ValueError):
    """host-agent 请求违反白名单策略。"""


def resource_name(prefix: str, resource_id: UUID) -> str:
    """从受信 UUID 生成满足 Linux 长度限制的名称。"""
    if not prefix.isalpha() or len(prefix) > 3:
        raise PolicyError("prefix 必须是 1 到 3 个字母")
    return f"{prefix.lower()}{resource_id.hex[: LINUX_INTERFACE_MAX_LENGTH - len(prefix)]}"


def bridge_name(experiment_id: UUID) -> str:
    """生成实验专属 OVS bridge 名称。"""
    return resource_name("slb", experiment_id)


def tap_name(unit_id: UUID, index: int = 0) -> str:
    """生成运行单元的稳定 TAP 名称。"""
    if index == 0:
        return resource_name("slt", unit_id)
    if not 1 <= index < MAX_RUNTIME_NICS:
        raise PolicyError("网卡序号必须是 0 到 31")
    # eth0 历史名称以 slt 开头；其余端口改用 sln，避免 UUID 前缀末尾刚好是端口序号时碰撞。
    return f"sln{unit_id.hex[:10]}{index:02d}"


def domain_name(unit_id: UUID, generation: int) -> str:
    """生成带代次的 libvirt domain 名称。"""
    if generation < 1:
        raise PolicyError("generation 必须大于零")
    return f"simlab-{unit_id.hex[:12]}-g{generation}"


def validate_link_request(port_alias: str, generation: int) -> None:
    """拒绝 shell/OVS 参数形式和无效代次。"""
    if generation < 1:
        raise PolicyError("generation 必须大于零")
    if not PORT_ALIAS_PATTERN.fullmatch(port_alias) or port_alias.startswith("--"):
        raise PolicyError("port_alias 不符合白名单")
    if port_alias not in ALLOWED_PORT_ALIASES:
        raise PolicyError("port_alias 未由当前 Runtime Profile 声明")
