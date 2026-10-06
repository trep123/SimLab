# -*- coding: utf-8 -*-
"""设备 Manifest 语义与不可变发布测试。"""

from copy import deepcopy

from django.core.exceptions import ValidationError
from django.test import TestCase

from apps.experiments.registry import publish_manifest, validate_manifest
from apps.experiments.services import SimlabError

VALID_MANIFEST: dict[str, object] = {
    "schema_version": "1.1",
    "model_id": "test-device",
    "release_version": "1.0.0",
    "device_type": "pc",
    "name": "测试设备",
    "visual": {"units": "meter", "anchors": {"eth0": "PORT_ETH_0"}},
    "ports": [
        {
            "port_key": "eth0",
            "connector_type": "RJ45",
            "role": "bidirectional",
            "protocol": "ethernet",
        }
    ],
    "runtime_profiles": [
        {"role": "guest_os", "backend": "qemu", "profile_release_id": "profile-v1"}
    ],
    "fidelity": {"network": "real_runtime"},
}


class ManifestRegistryTests(TestCase):
    """验证非法定义无法发布且发布内容不可原地修改。"""

    def test_valid_manifest_can_be_published(self) -> None:
        release = publish_manifest(deepcopy(VALID_MANIFEST))
        self.assertEqual(release.publication_status, "PUBLISHED")
        self.assertEqual(len(release.manifest_hash), 64)

    def test_missing_anchor_is_rejected(self) -> None:
        manifest = deepcopy(VALID_MANIFEST)
        manifest["visual"]["anchors"] = {}  # type: ignore[index]
        with self.assertRaisesMessage(SimlabError, "端口缺少视觉锚点"):
            validate_manifest(manifest)

    def test_duplicate_port_is_rejected(self) -> None:
        manifest = deepcopy(VALID_MANIFEST)
        manifest["ports"].append(deepcopy(manifest["ports"][0]))  # type: ignore[union-attr,index]
        with self.assertRaisesMessage(SimlabError, "port_key 不得重复"):
            validate_manifest(manifest)

    def test_published_release_is_immutable(self) -> None:
        release = publish_manifest(deepcopy(VALID_MANIFEST))
        release.name = "被修改的名称"
        with self.assertRaises(ValidationError):
            release.save()
