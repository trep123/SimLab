# -*- coding: utf-8 -*-
"""网络设备镜像导入服务；视图只调用此服务，不接触 Runtime 文件。"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

from django.conf import settings
from django.db import IntegrityError, transaction
from django.core.files import File

from apps.experiments.desktop_runtime import _complete_command, _fail_command, _start_command
from apps.experiments.models import RuntimeImage
from apps.experiments.services import SimlabError
from apps.experiments.vendor_image_catalog import (
    require_image_model, require_vendor_role, resolve_vendor_candidate,
)

MAX_IMPORT_BYTES = 8 * 1024**3
MAX_VIRTUAL_BYTES = 64 * 1024**3
ROLES = frozenset({"switch", "router", "firewall"})


def _inspect_image(path: Path) -> int:
    """只接受可独立启动、没有外部引用的 qcow2。"""
    try:
        result = subprocess.run(
            ["qemu-img", "info", "--output=json", str(path)],
            capture_output=True, text=True, check=False, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SimlabError(
            "IMAGE_INSPECTION_UNAVAILABLE", "镜像检查工具不可用；请检查服务器 qemu-img。",
            status_code=503,
        ) from error
    if result.returncode:
        raise SimlabError(
            "IMAGE_FORMAT_INVALID", "镜像无法读取；请上传独立的 qcow2 文件。"
        )
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SimlabError("IMAGE_FORMAT_INVALID", "镜像元数据无效；请重新导出 qcow2 文件。") from error
    format_specific = info.get("format-specific") or {}
    format_data = format_specific.get("data", {}) if isinstance(format_specific, dict) else {}
    if not isinstance(format_data, dict):
        format_data = {}
    if (
        info.get("format") != "qcow2" or info.get("backing-filename")
        or info.get("encrypted") or format_data.get("data-file")
    ):
        raise SimlabError(
            "IMAGE_FORMAT_INVALID", "仅支持无 backing、无加密、无外部数据文件的独立 qcow2；请先转换镜像。"
        )
    virtual_size = info.get("virtual-size")
    if not isinstance(virtual_size, int) or not 4 * 1024**3 <= virtual_size <= MAX_VIRTUAL_BYTES:
        raise SimlabError(
            "IMAGE_CAPACITY_INVALID", "镜像虚拟容量须为 4–64 GiB；请调整镜像容量后重试。"
        )
    return virtual_size


def import_runtime_image(
    upload: object, display_name: str, role: str, user: object,
    *, model_id: str = "", vendor_id: str = "", source_folder: str = "",
) -> RuntimeImage:
    """将管理员上传的 qcow2 流式写入内容寻址仓库并登记命令。"""
    if role not in ROLES:
        raise SimlabError("IMAGE_ROLE_INVALID", "请选择交换机、路由器或防火墙镜像类型。")
    if not model_id and not vendor_id:
        raise SimlabError("IMAGE_VENDOR_REQUIRED", "请选择设备厂商后再导入网络镜像。")
    if model_id:
        model_vendor = require_image_model(model_id, role)["vendor_id"]
        if vendor_id and vendor_id != model_vendor:
            raise SimlabError("IMAGE_VENDOR_ROLE_INVALID", "镜像厂商与设备型号不匹配；请重新选择。")
        vendor_id = model_vendor
    elif vendor_id:
        require_vendor_role(vendor_id, role)
    display_name = display_name.strip()
    if not 1 <= len(display_name) <= 120:
        raise SimlabError("IMAGE_NAME_INVALID", "镜像名称须为 1–120 个字符；请修改后重试。")
    if not getattr(upload, "name", "").lower().endswith(".qcow2"):
        raise SimlabError("IMAGE_FORMAT_INVALID", "请选择 .qcow2 镜像文件。")
    declared_size = getattr(upload, "size", 0)
    if not 0 < declared_size <= MAX_IMPORT_BYTES:
        raise SimlabError("IMAGE_SIZE_INVALID", "镜像大小须为 1 字节至 8 GiB；请检查文件。")
    root = Path(settings.RUNTIME_IMAGE_IMPORT_ROOT)
    temporary = root / f".upload-{uuid.uuid4().hex}.qcow2"
    command = _start_command("runtime.image.import", {
        "display_name": display_name, "role": role, "model_id": model_id,
        "vendor_id": vendor_id, "source_folder": source_folder,
    })
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o755)
        digest = hashlib.sha256()
        total = 0
        with temporary.open("xb") as output:
            for chunk in upload.chunks(chunk_size=4 * 1024 * 1024):
                total += len(chunk)
                if total > MAX_IMPORT_BYTES:
                    raise SimlabError("IMAGE_SIZE_INVALID", "镜像超过 8 GiB；请使用较小的 qcow2 文件。")
                digest.update(chunk)
                output.write(chunk)
        if total != declared_size:
            raise SimlabError("IMAGE_UPLOAD_INCOMPLETE", "镜像上传不完整；请重新上传。")
        with temporary.open("rb") as stream:
            if stream.read(4) != b"QFI\xfb":
                raise SimlabError("IMAGE_FORMAT_INVALID", "文件不是 qcow2；请先转换镜像。")
        virtual_size = _inspect_image(temporary)
        sha256 = digest.hexdigest()
        release = f"uploaded-{sha256}"
        destination = root / sha256 / "base.qcow2"
        destination.parent.mkdir(mode=0o755, exist_ok=True)
        if destination.exists():
            if destination.is_symlink() or destination.stat().st_size != total:
                raise SimlabError("IMAGE_STORE_CONFLICT", "镜像仓库已有不同文件；请联系管理员检查。", status_code=409)
            with destination.open("rb") as existing_file:
                existing_digest = hashlib.file_digest(existing_file, "sha256").hexdigest()
            if existing_digest != sha256:
                raise SimlabError("IMAGE_STORE_CONFLICT", "镜像仓库校验冲突；请联系管理员检查。", status_code=409)
        else:
            temporary.chmod(0o444)
            os.replace(temporary, destination)
        existing = RuntimeImage.objects.filter(image_release=release).first()
        if existing is not None:
            if (existing.appliance_role != role or existing.model_id != model_id or
                    existing.vendor_id != vendor_id):
                raise SimlabError(
                    "IMAGE_ALREADY_REGISTERED", "相同镜像已登记为其他设备型号；请选用原型号或提供独立镜像版本。",
                    status_code=409,
                )
            if source_folder and existing.source_folder and existing.source_folder != source_folder:
                raise SimlabError(
                    "IMAGE_ALREADY_REGISTERED",
                    "相同镜像内容已从另一目录登记；请在已登记镜像清单中选择。",
                    status_code=409,
                )
            if source_folder and not existing.source_folder:
                existing.source_folder = source_folder
                existing.save(update_fields=("source_folder",))
            _complete_command(command, {"image_release": release, "reused": True})
            return existing
        with transaction.atomic():
            image = RuntimeImage.objects.create(
                image_release=release, display_name=display_name, appliance_role=role,
                vendor_id=vendor_id, model_id=model_id, source_folder=source_folder,
                sha256=sha256, size_bytes=total, virtual_size_bytes=virtual_size,
                uploaded_by=user,
            )
        _complete_command(command, {"image_release": release, "reused": False})
        return image
    except SimlabError as error:
        _fail_command(command, error.code, error.message)
        raise
    except IntegrityError as error:
        _fail_command(command, "IMAGE_IMPORT_CONFLICT", "镜像已被同时登记；请刷新镜像清单。")
        raise SimlabError(
            "IMAGE_IMPORT_CONFLICT", "镜像已被同时登记；请刷新镜像清单。", status_code=409,
        ) from error
    except (OSError, ValueError) as error:
        _fail_command(command, "IMAGE_IMPORT_FAILED", "镜像登记失败；请检查仓库权限与磁盘空间。")
        raise SimlabError(
            "IMAGE_IMPORT_FAILED", "镜像登记失败；请检查仓库权限与磁盘空间。", status_code=503,
        ) from error
    finally:
        temporary.unlink(missing_ok=True)


def register_vendor_image(folder: str, user: object) -> RuntimeImage:
    """管理员将 Vendor/model-version 候选经同一审计/校验流程登记到不可变仓库。"""
    candidate, path = resolve_vendor_candidate(folder)
    role = str(candidate["appliance_role"])
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with File(os.fdopen(descriptor, "rb"), name=path.name) as upload:
            return import_runtime_image(
                upload, path.parent.name, role, user,
                vendor_id=str(candidate["vendor_id"]), source_folder=folder,
            )
    except OSError as error:
        raise SimlabError(
            "IMAGE_DIRECTORY_UNREADABLE", "无法读取厂商镜像目录；请检查目录权限与符号链接。",
            status_code=503,
        ) from error
