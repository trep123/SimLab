# -*- coding: utf-8 -*-
"""只读列出可供管理员评估直通的宿主 USB Wi-Fi 设备。"""

from __future__ import annotations

import json
from pathlib import Path

NETWORK_ROOT = Path("/sys/class/net")


def usb_identity(interface: Path) -> dict[str, str] | None:
    """沿无线接口的 sysfs 父节点查找 USB 设备标识。"""
    if not (interface / "wireless").exists():
        return None
    resolved = (interface / "device").resolve()
    for parent in (resolved, *resolved.parents):
        vendor_file = parent / "idVendor"
        product_file = parent / "idProduct"
        if vendor_file.is_file() and product_file.is_file():
            return {
                "interface": interface.name,
                "vendor_id": vendor_file.read_text(encoding="ascii").strip().lower(),
                "product_id": product_file.read_text(encoding="ascii").strip().lower(),
                "sysfs_device": parent.name,
            }
        if parent == Path("/sys"):
            break
    return None


def main() -> None:
    """输出非破坏性的候选清单与下一步建议。"""
    candidates = [
        identity for interface in sorted(NETWORK_ROOT.iterdir())
        if (identity := usb_identity(interface)) is not None
    ] if NETWORK_ROOT.is_dir() else []
    result = {
        "schema_version": "1.0",
        "quality": "host_observation",
        "candidates": candidates,
        "code": "OK" if candidates else "WIFI_USB_NOT_FOUND",
        "message": (
            "发现 USB 无线网卡；请确认它不是宿主当前联网设备，并核对客体驱动。"
            if candidates else "未发现可识别的 USB 无线网卡；请插入专用适配器后重试。"
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
