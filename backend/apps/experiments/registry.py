# -*- coding: utf-8 -*-
"""设备 Manifest 的语义校验与不可变发布服务。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from django.db import transaction

from apps.experiments.models import DeviceModelRelease
from apps.experiments.services import SimlabError

SUPPORTED_SCHEMA_VERSION = "1.1"
SUPPORTED_RUNTIME_BACKENDS = frozenset({"qemu", "container", "logical"})


@dataclass(frozen=True)
class ValidatedManifest:
    """规范化后的 Manifest 与内容哈希。"""

    content: dict[str, object]
    sha256: str


def validate_manifest(manifest: dict[str, object]) -> ValidatedManifest:
    """验证发布所需的结构、端口、锚点与 Runtime 引用。"""
    required_strings = ("model_id", "release_version", "device_type", "name")
    if manifest.get("schema_version") != SUPPORTED_SCHEMA_VERSION:
        raise SimlabError("MANIFEST_SCHEMA_UNSUPPORTED", "仅支持 Manifest schema 1.1")
    if any(not isinstance(manifest.get(key), str) or not manifest[key] for key in required_strings):
        raise SimlabError("MANIFEST_INVALID", "Manifest 缺少必要的字符串字段")
    visual = manifest.get("visual")
    ports = manifest.get("ports")
    profiles = manifest.get("runtime_profiles")
    if (
        not isinstance(visual, dict)
        or not isinstance(ports, list)
        or not isinstance(profiles, list)
    ):
        raise SimlabError("MANIFEST_INVALID", "visual、ports 或 runtime_profiles 类型错误")
    anchors = visual.get("anchors")
    if not isinstance(anchors, dict):
        raise SimlabError("MANIFEST_INVALID", "visual.anchors 必须是对象")
    port_keys: list[str] = []
    for port in ports:
        if not isinstance(port, dict) or not isinstance(port.get("port_key"), str):
            raise SimlabError("MANIFEST_INVALID", "每个端口必须包含 port_key")
        port_keys.append(port["port_key"])
    if len(port_keys) != len(set(port_keys)):
        raise SimlabError("MANIFEST_DUPLICATE_PORT", "port_key 不得重复")
    missing_anchors = sorted(set(port_keys) - set(anchors))
    if missing_anchors:
        raise SimlabError(
            "MANIFEST_ANCHOR_MISSING", f"端口缺少视觉锚点：{', '.join(missing_anchors)}"
        )
    anchor_values = [str(anchors[key]) for key in port_keys]
    if len(anchor_values) != len(set(anchor_values)):
        raise SimlabError("MANIFEST_DUPLICATE_ANCHOR", "端口视觉锚点必须一一对应")
    for profile in profiles:
        if (
            not isinstance(profile, dict)
            or profile.get("backend") not in SUPPORTED_RUNTIME_BACKENDS
        ):
            raise SimlabError("RUNTIME_BACKEND_UNSUPPORTED", "Runtime backend 未获批准")
        if not profile.get("profile_release_id"):
            raise SimlabError("RUNTIME_PROFILE_MISSING", "Runtime profile 必须绑定具体发布版本")
    normalized = json.loads(json.dumps(manifest, ensure_ascii=False, sort_keys=True))
    digest = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return ValidatedManifest(normalized, digest)


@transaction.atomic
def publish_manifest(manifest: dict[str, object]) -> DeviceModelRelease:
    """校验并创建不可变的已发布设备版本。"""
    validated = validate_manifest(manifest)
    return DeviceModelRelease.objects.create(
        model_id=str(validated.content["model_id"]),
        release_version=str(validated.content["release_version"]),
        schema_version=str(validated.content["schema_version"]),
        name=str(validated.content["name"]),
        device_type=str(validated.content["device_type"]),
        manifest_hash=validated.sha256,
        manifest_json=validated.content,
        publication_status="PUBLISHED",
    )
