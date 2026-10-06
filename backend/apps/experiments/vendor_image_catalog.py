# -*- coding: utf-8 -*-
"""只读发现 Vendor/vendor-role-version 目录；详细型号由用户选镜像时决定。"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings

from apps.experiments.services import SimlabError

MAX_DISCOVERY_DIRS = 256
ROLES = ("switch", "router", "firewall")


def model_catalog() -> dict[str, dict[str, str]]:
    """使用前端同一份内置型号清单作为厂商/型号匹配依据。"""
    catalog: dict[str, dict[str, str]] = {}
    for path in sorted((settings.BASE_DIR.parent / "assets" / "catalog").glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        model_id = payload.get("model_id")
        vendor_id = payload.get("vendor_id")
        device_type = payload.get("device_type")
        if all(isinstance(value, str) for value in (model_id, vendor_id, device_type)):
            catalog[model_id] = {"vendor_id": vendor_id, "device_type": device_type,
                                 "display_name": str(payload.get("display_name", model_id))}
    return catalog


def require_image_model(model_id: str, role: str) -> dict[str, str]:
    """拒绝前端伪造厂商或把路由镜像登记为交换机。"""
    info = model_catalog().get(model_id)
    expected_role = "switch" if info and info["device_type"] == "l3switch" else (
        info["device_type"] if info else None
    )
    if info is None or expected_role != role:
        raise SimlabError(
            "IMAGE_MODEL_INVALID", "镜像型号与设备类型不匹配；请从当前设备的型号目录重新导入。"
        )
    return info


def require_vendor_role(vendor_id: str, role: str) -> None:
    """厂商/角色须在当前内置设备目录中存在。"""
    if role not in ROLES or not any(
        item["vendor_id"] == vendor_id and
        ("switch" if item["device_type"] == "l3switch" else item["device_type"]) == role
        for item in model_catalog().values()
    ):
        raise SimlabError(
            "IMAGE_VENDOR_ROLE_INVALID", "厂商与设备类型不匹配；请从当前设备的厂商类型目录导入。"
        )


def discover_vendor_images() -> list[dict[str, object]]:
    """按 Vendor/vendor-role[-版本] 扫描候选，资源池刷新时检查 qcow2 是否存在。"""
    root = Path(settings.RUNTIME_VENDOR_IMAGE_ROOT)
    if not root.is_dir() or root.is_symlink():
        return []
    catalog = model_catalog()
    candidates: list[dict[str, object]] = []
    for vendor_dir in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
        if vendor_dir.is_symlink() or not vendor_dir.is_dir():
            continue
        vendor_id = vendor_dir.name.casefold()
        known_roles = {
            "switch" if value["device_type"] == "l3switch" else value["device_type"]
            for value in catalog.values() if value["vendor_id"] == vendor_id
        } & set(ROLES)
        if not known_roles:
            continue
        for image_dir in sorted(vendor_dir.iterdir(), key=lambda item: item.name):
            if len(candidates) >= MAX_DISCOVERY_DIRS:
                return candidates
            if image_dir.is_symlink() or not image_dir.is_dir():
                continue
            folder_name = image_dir.name.casefold()
            role = next((item for item in ROLES if
                         folder_name == f"{vendor_id}-{item}" or
                         folder_name.startswith(f"{vendor_id}-{item}-")), None)
            if role not in known_roles:
                continue
            disks = sorted((item for item in image_dir.iterdir() if
                            item.suffix.lower() == ".qcow2" and item.is_file() and
                            not item.is_symlink()), key=lambda item: item.name)
            status = "READY_TO_REGISTER" if len(disks) == 1 else (
                "MULTIPLE_DISKS" if disks else "IMAGE_MISSING"
            )
            candidates.append({
                "folder": f"{vendor_dir.name}/{image_dir.name}",
                "vendor_id": vendor_id,
                "model_id": "",
                "appliance_role": role,
                "display_name": image_dir.name,
                "device_type": role,
                "file_name": disks[0].name if len(disks) == 1 else None,
                "status": status,
            })
    return candidates


def resolve_vendor_candidate(folder: str) -> tuple[dict[str, object], Path]:
    """只接受当前发现清单中的精确目录，绝不接受任意宿主绝对路径。"""
    try:
        candidate = next((item for item in discover_vendor_images() if item["folder"] == folder), None)
    except OSError as error:
        raise SimlabError(
            "IMAGE_DIRECTORY_UNREADABLE", "无法读取厂商镜像目录；请检查 API 用户的目录权限。",
            status_code=503,
        ) from error
    if candidate is None or candidate["status"] != "READY_TO_REGISTER":
        raise SimlabError(
            "IMAGE_DIRECTORY_NOT_READY", "目录须包含且仅包含一个 .qcow2 文件；请检查厂商-类型目录。"
        )
    path = Path(settings.RUNTIME_VENDOR_IMAGE_ROOT) / folder / str(candidate["file_name"])
    if path.is_symlink() or not path.is_file():
        raise SimlabError("IMAGE_DIRECTORY_NOT_READY", "镜像文件已变化；请刷新目录清单。")
    return candidate, path
