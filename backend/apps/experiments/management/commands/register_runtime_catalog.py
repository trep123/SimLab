# -*- coding: utf-8 -*-
"""登记当前节点已批准的真实 Runtime 设备版本。"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.experiments.models import DeviceModelRelease
from apps.experiments.registry import publish_manifest, validate_manifest


class Command(BaseCommand):
    """幂等登记受版本控制的通用 PC Runtime Manifest。"""

    help = "登记当前 Host Agent 支持的真实 Runtime 设备目录"

    def handle(self, *args: object, **options: object) -> None:
        """验证 runtime_real 与 Profile allowlist 后发布。"""
        if settings.RUNTIME_MODE != "runtime_real":
            raise CommandError("仅允许在 SIMLAB_RUNTIME_MODE=runtime_real 时登记真实目录")
        manifest_path = Path(settings.BASE_DIR).parent / "assets/profiles/generic-pc.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validated = validate_manifest(manifest)
        profile_ids = {
            str(profile.get("profile_release_id"))
            for profile in validated.content["runtime_profiles"]
            if isinstance(profile, dict) and profile.get("backend") == "qemu"
        }
        if not profile_ids or not profile_ids.issubset(settings.APPROVED_RUNTIME_PROFILE_RELEASES):
            raise CommandError("Manifest 引用了当前节点未批准的 Runtime Profile")
        existing = DeviceModelRelease.objects.filter(
            model_id=validated.content["model_id"],
            release_version=validated.content["release_version"],
        ).first()
        if existing is not None:
            if existing.manifest_hash != validated.sha256:
                raise CommandError("同版本 Manifest 已存在但内容哈希不同")
            self.stdout.write(f"真实 Runtime 目录已存在：{existing}")
            return
        release = publish_manifest(validated.content)
        self.stdout.write(self.style.SUCCESS(f"已登记真实 Runtime 目录：{release}"))
