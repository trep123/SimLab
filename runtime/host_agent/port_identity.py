# -*- coding: utf-8 -*-
"""从 libvirt XML 精确解析前端 ethN 对应的网卡。"""

from __future__ import annotations

import xml.etree.ElementTree as element_tree

from runtime.host_agent.errors import HostAgentError
from runtime.host_agent.policy import ALLOWED_PORT_ALIASES


def find_port_interface(
    root: element_tree.Element, alias: str, *, external: bool,
    expected_mac: str = "", expected_tap: str = "",
) -> element_tree.Element:
    """libvirt 会把自定义别名改成 netN；受管网卡再以稳定 MAC/TAP 验证。"""
    if alias not in ALLOWED_PORT_ALIASES:
        raise HostAgentError("PORT_NOT_FOUND", "虚拟网卡别名无效")
    index = int(alias[3:])
    interfaces = root.findall("./devices/interface")
    if index >= len(interfaces):
        raise HostAgentError("PORT_NOT_FOUND", "虚拟机中没有对应的网卡")
    interface = interfaces[index]
    if not external:
        mac_node, tap_node = interface.find("mac"), interface.find("target")
        actual_mac = mac_node.get("address", "").lower() if mac_node is not None else ""
        actual_tap = tap_node.get("dev", "") if tap_node is not None else ""
        if actual_mac != expected_mac.lower() or actual_tap != expected_tap:
            raise HostAgentError(
                "PORT_IDENTITY_MISMATCH", "虚拟网卡 MAC/TAP 与受管 ethN 身份不符"
            )
    return interface
