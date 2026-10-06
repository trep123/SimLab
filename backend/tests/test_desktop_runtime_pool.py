# -*- coding: utf-8 -*-
"""PC/笔记本通用虚拟机资源池 API 测试。"""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from apps.experiments.models import (
    ExternalRuntimeBinding,
    ExternalRuntimeCommand,
    ExperimentMember,
    MemberRole,
    VirtualRuntimeInstance,
    RuntimeImage,
)
from apps.experiments.desktop_runtime import (
    ensure_external_runtime_instances, verify_runtime_console_token,
)
from apps.experiments.services import SimlabError, create_experiment


class NetworkExternalDomainConfigTests(TestCase):
    """白名单拼写错误必须可见，不能默默丢失已有设备。"""

    @override_settings(
        DESKTOP_EXTERNAL_DOMAINS=(),
        NETWORK_EXTERNAL_DOMAINS=("vendor-sw:invalid",),
    )
    def test_invalid_device_type_reports_actionable_error(self) -> None:
        with self.assertRaises(SimlabError) as caught:
            ensure_external_runtime_instances()
        self.assertEqual(caught.exception.code, "EXTERNAL_DOMAIN_CONFIG_INVALID")
        self.assertIn("SIMLAB_NETWORK_EXTERNAL_DOMAINS", caught.exception.message)


class FakeDesktopRuntimeClient:
    """记录资源规格并返回确定性的 Host Agent 观测。"""

    def __init__(self) -> None:
        self.defined_specs: list[dict[str, object]] = []
        self.shutdown_domains: list[str | None] = []
        self.deleted_units: list[object] = []
        self.wired_ports: list[tuple[str, bool, object]] = []

    @staticmethod
    def _observation(domain_name: str, power_state: str = "STOPPED") -> dict[str, object]:
        port = 5906 if domain_name == "simlab-g0-pc2" else 5905
        return {
            "domain_name": domain_name,
            "power_state": power_state,
            "source": "observed",
            "quality": "real_runtime",
            "vnc": {"listen": "127.0.0.1", "port": port},
            "interfaces": [{"port_alias": "eth0", "target": "vnet0",
                            "mac_address": "52:54:00:00:00:01"}],
        }

    def bind_external(
        self, operation_id: object, target: object, domain_name: str
    ) -> dict[str, object]:
        """返回白名单已有域观测。"""
        assert operation_id
        assert target
        return self._observation(domain_name, "RUNNING")

    def ensure_defined(
        self, operation_id: object, target: object, spec: dict[str, object]
    ) -> dict[str, object]:
        """记录前端参数编译后的受控规格。"""
        assert operation_id
        assert target
        self.defined_specs.append(spec)
        observation = self._observation("simlab-managed-test")
        observation["interfaces"] = [
            {"port_alias": alias, "target": f"vnet{index}",
             "mac_address": f"52:54:00:00:00:{index + 1:02x}"}
            for index, alias in enumerate(spec.get("nic_aliases", ["eth0"]))
        ]
        return observation

    def shutdown(
        self, operation_id: object, target: object, domain_name: str | None = None
    ) -> dict[str, object]:
        """记录正常关机并返回停止态。"""
        assert operation_id
        assert target
        self.shutdown_domains.append(domain_name)
        return self._observation(domain_name or "simlab-managed-test", "STOPPED")

    def start(
        self, operation_id: object, target: object, domain_name: str | None = None
    ) -> dict[str, object]:
        """返回启动后的运行态。"""
        assert operation_id
        assert target
        return self._observation(domain_name or "simlab-managed-test", "RUNNING")

    def delete_unit(self, operation_id: object, target: object) -> dict[str, object]:
        """记录受管单元精确删除。"""
        assert operation_id
        self.deleted_units.append(target)
        return {"deleted": True}

    def wire_port(
        self, operation_id: object, target: object, port_alias: str,
        network_id: object, *, up: bool, domain_name: str | None = None
    ) -> dict[str, object]:
        self.wired_ports.append((port_alias, up, network_id))
        instance = VirtualRuntimeInstance.objects.filter(
            experiment_id=target.experiment_id, unit_id=target.unit_id
        ).first()
        power_state = instance.observed_json.get("power_state", "STOPPED") if instance else "STOPPED"
        result = self._observation(domain_name or "simlab-managed-test", power_state)
        result["network_status"] = "WIRED" if up else "DISCONNECTED"
        result["network_bridge"] = "slb-test" if up else ""
        return result


@override_settings(
    G0_PC1_BRIDGE_ENABLED=True,
    DESKTOP_RUNTIME_BRIDGE_ENABLED=True,
    DESKTOP_EXTERNAL_DOMAINS=("simlab-g0-pc1", "simlab-g0-pc2"),
    DESKTOP_NOVNC_BASE_URL="/novnc/vnc.html",
)
class DesktopRuntimePoolApiTests(TestCase):
    """验证已有 VM 绑定、笔记本支持和按参数创建。"""

    def setUp(self) -> None:
        """建立假 Host Agent。"""
        self.user = get_user_model().objects.create_user(
            username="desktop-user", password="desktop-pass"
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.experiment = create_experiment(self.user, "桌面测试")
        self.experiment.document_json = {"devices": [
            {"device_id": device_id} for device_id in (
                "dev-004", "dev-009", "dev-021", "dev-010", "dev-exp-one-001",
                "dev-exp-two-001", "dev-exp-three-001", "dev-exp-four-001",
                "dev-other-001", "dev-stale-001",
            )
        ]}
        self.experiment.save(update_fields=("document_json",))
        self.runtime_client = FakeDesktopRuntimeClient()
        self.client_patch = patch(
            "apps.experiments.desktop_runtime._runtime_client",
            return_value=self.runtime_client,
        )
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)

    def test_inventory_lists_every_allowlisted_existing_vm(self) -> None:
        """两台 G0 已有域都进入可绑定资源池。"""
        response = self.client.get("/api/v1/runtime/desktops/")

        self.assertEqual(response.status_code, 200)
        domains = {item["domain_name"] for item in response.json()["instances"]}
        self.assertEqual(domains, {"simlab-g0-pc1", "simlab-g0-pc2"})
        self.assertEqual(response.json()["profiles"][0]["defaults"]["vcpu_count"], 2)

    @override_settings(NETWORK_EXTERNAL_DOMAINS=("vendor-switch:switch",))
    def test_allowlisted_existing_network_vm_appears_for_switch_only(self) -> None:
        """已有厂商 VM 通过显式白名单进入对应设备类型资源池。"""
        response = self.client.get("/api/v1/runtime/desktops/")
        self.assertEqual(response.status_code, 200)
        external = next(
            item for item in response.json()["instances"]
            if item["domain_name"] == "vendor-switch"
        )
        self.assertEqual(external["compatible_device_types"], ["switch"])

    def test_real_console_ticket_is_bound_to_user_device_and_power(self) -> None:
        """真实串口仅向当前实验可编辑成员的运行中绑定设备签发。"""
        instance = VirtualRuntimeInstance.objects.create(
            source="MANAGED", experiment_id=self.experiment.id,
            unit_id=uuid.uuid4(), generation=1,
            profile_release_id="linux-switch-profile-v1",
            image_release="ubuntu-noble-20260725",
            compatible_device_types=["switch"],
            bound_experiment=self.experiment, owner_user=self.user,
            frontend_device_id="dev-021", model_id="cisco-c2960x-24ts-l",
            display_name="SW-021", observed_json={"power_state": "RUNNING"},
            provision_state="READY",
        )
        endpoint = f"/api/v1/runtime/desktops/{instance.id}/console/"
        issued = self.client.post(
            endpoint, json.dumps({"device_id": "dev-021"}), content_type="application/json"
        )
        self.assertEqual(issued.status_code, 200)
        query = parse_qs(urlparse(issued.json()["console_url"]).query)
        token = query["token"][0]
        self.assertTrue(verify_runtime_console_token(instance.id, self.user.pk, "dev-021", token))
        self.assertFalse(verify_runtime_console_token(instance.id, self.user.pk, "dev-other", token))

        wrong_device = self.client.post(
            endpoint, json.dumps({"device_id": "dev-010"}), content_type="application/json"
        )
        self.assertEqual(wrong_device.json()["error"]["code"], "CONSOLE_DEVICE_MISMATCH")
        viewer = get_user_model().objects.create_user(username="console-viewer", password="pass")
        ExperimentMember.objects.create(experiment=self.experiment, user=viewer, role=MemberRole.VIEWER)
        self.client.force_login(viewer)
        forbidden = self.client.post(
            endpoint, json.dumps({"device_id": "dev-021"}), content_type="application/json"
        )
        self.assertEqual(forbidden.status_code, 403)
        self.client.force_login(self.user)
        instance.observed_json = {"power_state": "STOPPED"}
        instance.save(update_fields=("observed_json",))
        off = self.client.post(
            endpoint, json.dumps({"device_id": "dev-021"}), content_type="application/json"
        )
        self.assertEqual(off.json()["error"]["code"], "CONSOLE_POWER_OFF")

    def test_switch_creates_one_vm_nic_per_frontend_port(self) -> None:
        """26 口实体交换机使用 26 个真实网卡，并保留一一映射。"""
        release = "uploaded-" + "b" * 64
        RuntimeImage.objects.create(
            image_release=release, display_name="Cisco 交换机测试镜像",
            appliance_role="switch", vendor_id="cisco", sha256="b" * 64,
            size_bytes=1024, virtual_size_bytes=8 * 1024**3, uploaded_by=self.user,
        )
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        self.assertFalse(any(
            item["image_release"] == "ubuntu-noble-20260725" and
            "switch" in item["device_types"] for item in inventory["profiles"]
        ))
        port_keys = [f"Gi1/0/{index}" for index in range(1, 27)]
        aliases = [f"eth{index}" for index in range(26)]
        response = self.client.post(
            "/api/v1/runtime/desktops/",
            json.dumps({
                "experiment_id": str(self.experiment.id),
                "device_id": "dev-021",
                "model_id": "cisco-c2960x-24ts-l",
                "display_name": "SW-021",
                "device_type": "switch",
                "nic_aliases": aliases,
                "port_keys": port_keys,
                "spec": {
                    "profile_release_id": "linux-switch-profile-v1",
                    "image_release": release,
                    "vm_name": "simlab-switch",
                    "memory_mib": 2048,
                    "vcpu_count": 2,
                    "disk_gib": 16,
                    "nic_model": "virtio",
                    "nic_aliases": aliases,
                    "gpu_model": "virtio",
                },
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.runtime_client.defined_specs[-1]["appliance_role"], "switch")
        mappings = response.json()["instance"]["port_bindings"]
        self.assertEqual(len(mappings), 26)
        self.assertEqual(mappings[25]["frontend_port_key"], "Gi1/0/26")
        self.assertEqual(mappings[25]["runtime_alias"], "eth25")
        self.assertEqual(self.runtime_client.defined_specs[-1]["image_release"], release)

    def test_network_node_rejects_ubuntu_default_image(self) -> None:
        """网络设备创建不能回退到桌面教学 Ubuntu 镜像。"""
        response = self.client.post(
            "/api/v1/runtime/desktops/",
            json.dumps({
                "experiment_id": str(self.experiment.id), "device_id": "dev-021",
                "model_id": "ruijie-rg-rsr20-x-28", "display_name": "R1",
                "device_type": "router", "nic_aliases": ["eth0"], "port_keys": ["GE0"],
                "spec": {
                    "profile_release_id": "linux-router-profile-v1",
                    "image_release": "ubuntu-noble-20260725", "vm_name": "r1",
                    "memory_mib": 2048, "vcpu_count": 2, "disk_gib": 16,
                    "nic_model": "virtio", "nic_aliases": ["eth0"], "gpu_model": "virtio",
                },
            }), content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "IMAGE_REQUIRED")

    def test_uploaded_firewall_image_is_selectable_and_reaches_host_agent(self) -> None:
        """导入镜像规格进入资源池，创建时传给 Host Agent 且磁盘不能小于镜像。"""
        release = "uploaded-" + "a" * 64
        RuntimeImage.objects.create(
            image_release=release, display_name="实验防火墙", appliance_role="firewall",
            sha256="a" * 64, size_bytes=1024,
            virtual_size_bytes=24 * 1024**3, uploaded_by=self.user,
        )
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        profile = next(item for item in inventory["profiles"] if item["image_release"] == release)
        self.assertEqual(profile["limits"]["disk_gib"][0], 24)
        payload = {
            "experiment_id": str(self.experiment.id), "device_id": "dev-010",
            "model_id": "huawei-usg6300e", "display_name": "FW-010", "device_type": "firewall",
            "nic_aliases": ["eth0"], "port_keys": ["GE1"],
            "spec": {
                "profile_release_id": "linux-firewall-profile-v1", "image_release": release,
                "memory_mib": 2048, "vcpu_count": 2, "disk_gib": 16,
                "vm_name": "firewall-test", "nic_model": "e1000",
                "nic_aliases": ["eth0"], "gpu_model": "virtio",
            },
        }
        rejected = self.client.post(
            "/api/v1/runtime/desktops/", json.dumps(payload), content_type="application/json"
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.json()["error"]["code"], "IMAGE_DISK_TOO_SMALL")
        payload["spec"]["disk_gib"] = 24
        accepted = self.client.post(
            "/api/v1/runtime/desktops/", json.dumps(payload), content_type="application/json"
        )
        self.assertEqual(accepted.status_code, 201)
        self.assertEqual(self.runtime_client.defined_specs[-1]["image_release"], release)

        # 同一镜像若登记为指定厂商型号，不可仅凭设备类型绑定另一台厂商设备。
        image = RuntimeImage.objects.get(image_release=release)
        image.vendor_id = "huawei"
        image.model_id = "huawei-usg6300e"
        image.save(update_fields=("vendor_id", "model_id"))
        payload["model_id"] = "h3c-secpath-f1000-ak735"
        mismatch = self.client.post(
            "/api/v1/runtime/desktops/", json.dumps(payload), content_type="application/json"
        )
        self.assertEqual(mismatch.status_code, 409)
        self.assertEqual(mismatch.json()["error"]["code"], "IMAGE_MODEL_MISMATCH")

    def test_existing_vm_can_bind_to_laptop(self) -> None:
        """已有域不再限定 PC 型号，笔记本可直接绑定。"""
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        runtime_id = next(
            item["id"] for item in inventory["instances"] if item["domain_name"] == "simlab-g0-pc2"
        )
        response = self.client.put(
            f"/api/v1/runtime/desktops/{runtime_id}/binding/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-004",
                    "model_id": "generic-laptop-wifi6",
                    "display_name": "Laptop-004",
                    "device_type": "laptop",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["instance"]["bound_device_id"], "dev-004")
        self.assertEqual(response.json()["instance"]["domain_name"], "simlab-g0-pc2")
        websocket_path = parse_qs(urlparse(response.json()["instance"]["novnc_url"]).query)["path"][
            0
        ]
        self.assertTrue(websocket_path.startswith(f"/ws/runtime-vnc/{runtime_id}/?token="))
        self.assertTrue(
            ExternalRuntimeCommand.objects.filter(type="runtime.bind", status="SUCCEEDED").exists()
        )

    def test_frontend_port_maps_to_observed_virtual_nic(self) -> None:
        """物理模块名可不同于 VM 别名，但必须保存精确一对一关系。"""
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        runtime_id = next(
            item["id"] for item in inventory["instances"] if item["domain_name"] == "simlab-g0-pc1"
        )
        response = self.client.put(
            f"/api/v1/runtime/desktops/{runtime_id}/binding/",
            json.dumps({
                "experiment_id": str(self.experiment.id),
                "device_id": "dev-004",
                "model_id": "generic-atx-pc",
                "display_name": "PC-004",
                "device_type": "pc",
                "nic_aliases": ["eth0"],
                "port_keys": ["LAN1"],
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["instance"]["port_bindings"], [{
            "frontend_port_key": "LAN1", "runtime_alias": "eth0",
            "mac_address": "52:54:00:00:00:01", "tap": "vnet0",
            "network_status": "DISCONNECTED", "network_bridge": "",
        }])

    def test_saved_web_cable_wires_and_unplug_disables_real_vm_nics(self) -> None:
        inventory = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        for domain_name, device_id in (("simlab-g0-pc1", "dev-004"),
                                        ("simlab-g0-pc2", "dev-009")):
            runtime_id = next(item["id"] for item in inventory if item["domain_name"] == domain_name)
            bound = self.client.put(
                f"/api/v1/runtime/desktops/{runtime_id}/binding/",
                json.dumps({"experiment_id": str(self.experiment.id), "device_id": device_id,
                            "model_id": "generic-atx-pc", "display_name": device_id,
                            "device_type": "pc", "nic_aliases": ["eth0"], "port_keys": ["eth0"]}),
                content_type="application/json",
            )
            self.assertEqual(bound.status_code, 200)
        document = {
            "schema_version": "1.0", "experiment_id": str(self.experiment.id),
            "name": "桌面测试", "scene": {},
            "devices": [
                {"device_id": "dev-004", "device_type": "pc"},
                {"device_id": "dev-009", "device_type": "pc"},
            ],
            "cables": [{"cable_type": "ETHERNET_COPPER",
                        "source": {"device_id": "dev-004", "port": "eth0"},
                        "target": {"device_id": "dev-009", "port": "eth0"}}],
        }
        url = f"/api/v1/experiments/{self.experiment.id}/document/"
        connected = self.client.put(
            url, json.dumps({"expected_config_revision": 0, "document": document}),
            content_type="application/json",
        )
        self.assertEqual(connected.status_code, 200)
        wired = [row for row in self.runtime_client.wired_ports if row[1]]
        self.assertEqual(len(wired), 2)
        self.assertEqual(wired[0][2], wired[1][2])
        live_inventory = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        self.assertEqual(
            [item["port_bindings"][0]["network_status"] for item in live_inventory
             if item["bound_device_id"] in {"dev-004", "dev-009"}],
            ["WIRED", "WIRED"],
        )
        document["cables"] = []
        unplugged = self.client.put(
            url, json.dumps({"expected_config_revision": 1, "document": document}),
            content_type="application/json",
        )
        self.assertEqual(unplugged.status_code, 200)
        self.assertEqual(self.runtime_client.wired_ports[-2][1], False)
        self.assertEqual(self.runtime_client.wired_ports[-1][1], False)
        offline_inventory = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        self.assertEqual(
            [item["port_bindings"][0]["network_status"] for item in offline_inventory
             if item["bound_device_id"] in {"dev-004", "dev-009"}],
            ["DISCONNECTED", "DISCONNECTED"],
        )

    def test_invalid_frontend_port_mapping_is_rejected(self) -> None:
        """无效物理端口名不能默默映射到 VM 网卡。"""
        inventory = self.client.get("/api/v1/runtime/desktops/").json()
        runtime_id = inventory["instances"][0]["id"]
        response = self.client.put(
            f"/api/v1/runtime/desktops/{runtime_id}/binding/",
            json.dumps({
                "experiment_id": str(self.experiment.id),
                "device_id": "dev-004",
                "model_id": "generic-atx-pc",
                "display_name": "PC-004",
                "device_type": "pc",
                "nic_aliases": ["eth0"],
                "port_keys": ["LAN 1"],
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "NIC_PORT_MAPPING_INVALID")

    def test_frontend_spec_creates_managed_vm_and_persists_exact_resources(self) -> None:
        """CPU、内存、磁盘和登记镜像由前端选择并进入 Host Agent 规格。"""
        response = self.client.post(
            "/api/v1/runtime/desktops/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-009",
                    "model_id": "generic-atx-pc",
                    "display_name": "PC-009",
                    "device_type": "pc",
                    "spec": {
                        "profile_release_id": "linux-cloud-profile-v1",
                        "image_release": "ubuntu-noble-20260725",
                        "memory_mib": 3072,
                        "vcpu_count": 3,
                        "disk_gib": 24,
                    },
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        instance = VirtualRuntimeInstance.objects.get(source="MANAGED")
        self.assertEqual(instance.frontend_device_id, "dev-009")
        self.assertEqual(instance.desired_json["memory_mib"], 3072)
        self.assertEqual(instance.desired_json["vcpu_count"], 3)
        self.assertEqual(instance.desired_json["disk_gib"], 24)
        self.assertEqual(self.runtime_client.defined_specs[0]["memory_mib"], 3072)
        self.assertEqual(
            self.runtime_client.defined_specs[0]["image_release"], "ubuntu-noble-20260725"
        )

    def test_rebinding_device_clears_previous_external_projection(self) -> None:
        """同一前端设备改绑其他 VM 后，旧 G0 投影不会在刷新时复活。"""
        instances = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        pc1 = next(item for item in instances if item["domain_name"] == "simlab-g0-pc1")
        pc2 = next(item for item in instances if item["domain_name"] == "simlab-g0-pc2")
        target = {
            "experiment_id": str(self.experiment.id),
            "device_id": "dev-021",
            "model_id": "generic-laptop-wifi6",
            "display_name": "Laptop-021",
            "device_type": "laptop",
        }
        first = self.client.put(
            f"/api/v1/runtime/desktops/{pc1['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )
        second = self.client.put(
            f"/api/v1/runtime/desktops/{pc2['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertIsNone(VirtualRuntimeInstance.objects.get(pk=pc1["id"]).frontend_device_id)
        self.assertFalse(
            ExternalRuntimeBinding.objects.filter(domain_name="simlab-g0-pc1").exists()
        )
        self.assertEqual(
            ExternalRuntimeBinding.objects.get(domain_name="simlab-g0-pc2").frontend_device_id,
            "dev-021",
        )

    def test_out_of_range_spec_is_rejected_before_host_call(self) -> None:
        """浏览器不能绕过资源范围或提交任意镜像。"""
        response = self.client.post(
            "/api/v1/runtime/desktops/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-010",
                    "model_id": "generic-atx-pc",
                    "display_name": "PC-010",
                    "device_type": "pc",
                    "spec": {
                        "profile_release_id": "linux-cloud-profile-v1",
                        "image_release": "../../etc/shadow",
                        "memory_mib": 65536,
                        "vcpu_count": 64,
                        "disk_gib": 2048,
                    },
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "IMAGE_NOT_ALLOWED")
        self.assertEqual(self.runtime_client.defined_specs, [])

    def test_manual_shutdown_automatically_unbinds_external_vm(self) -> None:
        """手动关机成功后必须同时清除资源池和兼容 G0 绑定。"""
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]
        target = {
            "experiment_id": str(self.experiment.id),
            "device_id": "dev-exp-one-001",
            "model_id": "generic-atx-pc",
            "display_name": "PC-One",
            "device_type": "pc",
        }
        self.client.put(
            f"/api/v1/runtime/desktops/{instance['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )

        response = self.client.post(
            f"/api/v1/runtime/desktops/{instance['id']}/power/",
            json.dumps({"device_id": target["device_id"], "on": False}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["instance"]["bound_device_id"])
        stored = VirtualRuntimeInstance.objects.get(pk=instance["id"])
        self.assertIsNone(stored.frontend_device_id)
        self.assertFalse(ExternalRuntimeBinding.objects.filter(domain_name=stored.domain_name).exists())
        self.assertEqual(self.runtime_client.shutdown_domains, [stored.domain_name])

    def test_deleting_frontend_device_destroys_managed_runtime(self) -> None:
        """前端设备删除联动关机、解绑并精确删除平台创建的虚拟机。"""
        created = self.client.post(
            "/api/v1/runtime/desktops/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-exp-two-001",
                    "model_id": "generic-laptop-wifi6",
                    "display_name": "Laptop-Two",
                    "device_type": "laptop",
                    "spec": {
                        "profile_release_id": "linux-cloud-profile-v1",
                        "image_release": "ubuntu-noble-20260725",
                        "memory_mib": 2048,
                        "vcpu_count": 2,
                        "disk_gib": 16,
                    },
                }
            ),
            content_type="application/json",
        ).json()["instance"]
        instance = VirtualRuntimeInstance.objects.get(pk=created["id"])
        instance.observed_json = self.runtime_client._observation(
            "simlab-managed-test", "RUNNING"
        )
        instance.save(update_fields=("observed_json", "updated_at"))

        response = self.client.delete(
            f"/api/v1/runtime/desktops/{instance.id}/lifecycle/",
            json.dumps({"device_id": "dev-exp-two-001"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["backend_destroyed"])
        self.assertFalse(VirtualRuntimeInstance.objects.filter(pk=instance.id).exists())
        self.assertEqual(len(self.runtime_client.deleted_units), 1)
        self.assertEqual(self.runtime_client.shutdown_domains, [None])

    def test_deleting_frontend_device_preserves_external_domain(self) -> None:
        """已有宿主机域只关机解绑，禁止把未受管资源从宿主机删除。"""
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]
        target = {
            "experiment_id": str(self.experiment.id),
            "device_id": "dev-exp-three-001",
            "model_id": "generic-atx-pc",
            "display_name": "PC-Three",
            "device_type": "pc",
        }
        self.client.put(
            f"/api/v1/runtime/desktops/{instance['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )

        response = self.client.delete(
            f"/api/v1/runtime/desktops/{instance['id']}/lifecycle/",
            json.dumps({"device_id": target["device_id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["backend_destroyed"])
        self.assertTrue(response.json()["external_runtime_preserved"])
        self.assertTrue(VirtualRuntimeInstance.objects.filter(pk=instance["id"]).exists())
        self.assertEqual(self.runtime_client.deleted_units, [])

    def test_experiment_release_closes_and_unbinds_bound_runtimes(self) -> None:
        """实验关闭接口只处理请求列出的前端设备。"""
        instances = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        first = instances[0]
        second = instances[1]
        for runtime, device_id in ((first, "dev-exp-four-001"), (second, "dev-other-001")):
            self.client.put(
                f"/api/v1/runtime/desktops/{runtime['id']}/binding/",
                json.dumps(
                    {
                        "experiment_id": str(self.experiment.id),
                        "device_id": device_id,
                        "model_id": "generic-atx-pc",
                        "display_name": device_id,
                        "device_type": "pc",
                    }
                ),
                content_type="application/json",
            )

        response = self.client.post(
            "/api/v1/runtime/desktops/release/",
            json.dumps(
                {"experiment_id": str(self.experiment.id), "device_ids": ["dev-exp-four-001"]}
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["released"]), 1)
        self.assertIsNone(VirtualRuntimeInstance.objects.get(pk=first["id"]).frontend_device_id)
        self.assertEqual(
            VirtualRuntimeInstance.objects.get(pk=second["id"]).frontend_device_id,
            "dev-other-001",
        )

    def test_lifecycle_endpoints_reject_non_object_payloads(self) -> None:
        """生命周期接口以稳定错误码拒绝非对象 JSON，避免内部属性错误。"""
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]

        lifecycle_response = self.client.delete(
            f"/api/v1/runtime/desktops/{instance['id']}/lifecycle/",
            json.dumps([]),
            content_type="application/json",
        )
        release_response = self.client.post(
            "/api/v1/runtime/desktops/release/",
            json.dumps([]),
            content_type="application/json",
        )

        self.assertEqual(lifecycle_response.status_code, 400)
        self.assertEqual(lifecycle_response.json()["error"]["code"], "INVALID_PAYLOAD")
        self.assertEqual(release_response.status_code, 400)
        self.assertEqual(release_response.json()["error"]["code"], "INVALID_PAYLOAD")

    def test_stopped_domain_with_legacy_binding_becomes_available_again(self) -> None:
        """资源池刷新会清理旧版本遗留的关机绑定，使 virsh 关闭域可重新选择。"""
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]
        self.client.put(
            f"/api/v1/runtime/desktops/{instance['id']}/binding/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-stale-001",
                    "model_id": "generic-atx-pc",
                    "display_name": "Stale-PC",
                    "device_type": "pc",
                }
            ),
            content_type="application/json",
        )

        self.runtime_client.bind_external = lambda operation_id, target, domain_name: (
            self.runtime_client._observation(domain_name, "STOPPED")
        )
        refreshed = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        current = next(item for item in refreshed if item["id"] == instance["id"])

        self.assertIsNone(current["bound_device_id"])
        self.assertEqual(current["power_state"], "STOPPED")
        self.assertFalse(
            ExternalRuntimeBinding.objects.filter(domain_name=instance["domain_name"]).exists()
        )

    def test_stopped_existing_vm_stays_bound_until_first_power_on(self) -> None:
        """绑定已关机的宿主机域后，清单刷新不能在首次开机前将其解绑。"""
        self.runtime_client.bind_external = lambda operation_id, target, domain_name: (
            self.runtime_client._observation(domain_name, "STOPPED")
        )
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]
        target = {
            "experiment_id": str(self.experiment.id),
            "device_id": "dev-004",
            "model_id": "generic-atx-pc",
            "display_name": "PC-004",
            "device_type": "pc",
        }
        bound = self.client.put(
            f"/api/v1/runtime/desktops/{instance['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )
        inventory = self.client.get("/api/v1/runtime/desktops/").json()["instances"]
        current = next(item for item in inventory if item["id"] == instance["id"])
        powered = self.client.post(
            f"/api/v1/runtime/desktops/{instance['id']}/power/",
            json.dumps({"device_id": target["device_id"], "on": True}),
            content_type="application/json",
        )

        self.assertEqual(bound.status_code, 200)
        self.assertEqual(current["bound_device_id"], target["device_id"])
        self.assertEqual(current["power_state"], "STOPPED")
        self.assertEqual(powered.status_code, 200)
        self.assertEqual(powered.json()["instance"]["power_state"], "RUNNING")

    def test_other_account_cannot_control_or_see_bound_runtime(self) -> None:
        """跨账户不可枚举或按已知 UUID 控制正在绑定的虚拟机。"""
        instance = self.client.get("/api/v1/runtime/desktops/").json()["instances"][0]
        target = {
            "experiment_id": str(self.experiment.id),
            "device_id": "dev-004",
            "model_id": "generic-atx-pc",
            "display_name": "Owner-PC",
            "device_type": "pc",
        }
        bound = self.client.put(
            f"/api/v1/runtime/desktops/{instance['id']}/binding/",
            json.dumps(target),
            content_type="application/json",
        )
        self.assertEqual(bound.status_code, 200)
        other = get_user_model().objects.create_user(username="other-desktop", password="pass")
        other_client = Client()
        other_client.force_login(other)

        inventory = other_client.get("/api/v1/runtime/desktops/").json()["instances"]
        power = other_client.post(
            f"/api/v1/runtime/desktops/{instance['id']}/power/",
            json.dumps({"device_id": "dev-004", "on": True}),
            content_type="application/json",
        )

        self.assertNotIn(instance["id"], {item["id"] for item in inventory})
        self.assertEqual(power.status_code, 404)
        self.assertEqual(power.json()["error"]["code"], "RESOURCE_NOT_FOUND")
        self.assertEqual(self.runtime_client.shutdown_domains, [])
