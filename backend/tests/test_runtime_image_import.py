"""管理员从浏览器导入网络设备 qcow2 的 API 验证。"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings

from apps.experiments.models import ExternalRuntimeCommand, RuntimeImage


@unittest.skipUnless(shutil.which("qemu-img"), "qemu-img 未安装")
class RuntimeImageImportTests(TestCase):
    """上传必须经过管理员授权、镜像格式检查和命令记录。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.image_root = Path(self.temporary.name) / "imported"
        self.vendor_root = Path(self.temporary.name) / "vendor"
        settings_override = override_settings(
            RUNTIME_MODE="runtime_real", DESKTOP_RUNTIME_BRIDGE_ENABLED=True,
            DESKTOP_EXTERNAL_DOMAINS=(), NETWORK_EXTERNAL_DOMAINS=(),
            RUNTIME_IMAGE_IMPORT_ROOT=self.image_root,
            RUNTIME_VENDOR_IMAGE_ROOT=self.vendor_root,
        )
        settings_override.enable()
        self.addCleanup(settings_override.disable)
        self.admin = get_user_model().objects.create_user(
            username="image-admin", password="test-pass", is_staff=True,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def _image_bytes(self) -> bytes:
        image = Path(self.temporary.name) / "test.qcow2"
        subprocess.run(["qemu-img", "create", "-f", "qcow2", str(image), "4G"], check=True,
                       capture_output=True)
        return image.read_bytes()

    def test_admin_imports_image_and_inventory_offers_it(self) -> None:
        data = self._image_bytes()
        response = self.client.post(
            "/api/v1/runtime/images/import/",
            {"image": SimpleUploadedFile("lab-router.qcow2", data),
             "display_name": "实验路由器", "appliance_role": "router", "vendor_id": "ruijie"},
            REMOTE_ADDR="198.51.100.8",
        )
        self.assertEqual(response.status_code, 201, response.content)
        release = response.json()["image_release"]
        self.assertEqual(release, "uploaded-" + hashlib.sha256(data).hexdigest())
        self.assertEqual(RuntimeImage.objects.get(image_release=release).appliance_role, "router")
        stored = self.image_root / release.removeprefix("uploaded-") / "base.qcow2"
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.stat().st_mode & 0o222, 0)
        self.assertTrue(ExternalRuntimeCommand.objects.filter(type="runtime.image.import").exists())
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        self.assertTrue(any(row["image_release"] == release for row in inventory["profiles"]))

    def test_non_admin_cannot_import_image(self) -> None:
        ordinary = get_user_model().objects.create_user(username="image-user", password="pass")
        self.client.force_login(ordinary)
        response = self.client.post(
            "/api/v1/runtime/images/import/",
            {"image": SimpleUploadedFile("router.qcow2", b"QFI\xfb"),
             "display_name": "路由", "appliance_role": "router"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "IMAGE_IMPORT_FORBIDDEN")

    def test_backing_chain_image_is_rejected(self) -> None:
        """不能登记依赖管理员机器其他路径的 qcow2 差异盘。"""
        self._image_bytes()
        overlay = Path(self.temporary.name) / "overlay.qcow2"
        subprocess.run(
            ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b",
             str(Path(self.temporary.name) / "test.qcow2"), str(overlay), "4G"],
            check=True, capture_output=True,
        )
        response = self.client.post(
            "/api/v1/runtime/images/import/",
            {"image": SimpleUploadedFile("overlay.qcow2", overlay.read_bytes()),
             "display_name": "不完整镜像", "appliance_role": "switch", "vendor_id": "ruijie"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "IMAGE_FORMAT_INVALID")
        self.assertFalse(RuntimeImage.objects.exists())

    def test_ruijie_directory_is_discovered_and_registered_for_vendor_role(self) -> None:
        """只按锐捷交换机目录前缀匹配，详细型号留给用户手动选。"""
        folder = self.vendor_root / "Ruijie" / "ruijie-switch-rg-s2910-v1"
        folder.mkdir(parents=True)
        subprocess.run(
            ["qemu-img", "create", "-f", "qcow2", str(folder / "virtioa.qcow2"), "4G"],
            check=True, capture_output=True,
        )
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        candidate = next(item for item in inventory["vendor_image_candidates"]
                         if item["appliance_role"] == "switch")
        self.assertEqual(candidate["status"], "READY_TO_REGISTER")
        self.assertFalse(candidate["registered"])
        self.assertFalse(any(item.get("vendor_id") == "ruijie"
                             for item in inventory["profiles"]))
        registered = self.client.post(
            "/api/v1/runtime/images/register-directory/",
            data='{"folder":"Ruijie/ruijie-switch-rg-s2910-v1"}',
            content_type="application/json",
        )
        self.assertEqual(registered.status_code, 201, registered.content)
        image = RuntimeImage.objects.get(image_release=registered.json()["image_release"])
        self.assertEqual(image.vendor_id, "ruijie")
        self.assertEqual(image.model_id, "")
        self.assertEqual(image.appliance_role, "switch")
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        self.assertTrue(next(item for item in inventory["vendor_image_candidates"]
                             if item["folder"] == candidate["folder"])["registered"])
        self.assertTrue(any(item.get("vendor_id") == image.vendor_id and
                            item["image_release"] == image.image_release
                            for item in inventory["profiles"]))

    def test_directory_traversal_and_missing_qcow2_are_rejected(self) -> None:
        folder = self.vendor_root / "Ruijie" / "ruijie-switch-rg-s2910-v1"
        folder.mkdir(parents=True)
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        self.assertEqual(inventory["vendor_image_candidates"][0]["status"],
                         "IMAGE_MISSING")
        for name in ("../etc", "Ruijie/ruijie-switch-rg-s2910-v1"):
            response = self.client.post(
                "/api/v1/runtime/images/register-directory/",
                data='{"folder":"' + name + '"}', content_type="application/json",
            )
            self.assertEqual(response.json()["error"]["code"], "IMAGE_DIRECTORY_NOT_READY")
