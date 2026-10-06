# -*- coding: utf-8 -*-
"""认证与对象权限 API 测试。"""

import json
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from apps.experiments.desktop_runtime import ensure_external_runtime_instances
from apps.experiments.models import (
    Experiment,
    ExternalRuntimeBinding,
    ExternalRuntimeCommand,
    VirtualRuntimeInstance,
)
from apps.experiments.services import create_experiment


class ApiAuthorizationTests(TestCase):
    """验证未认证与跨用户请求均无法读取实验。"""

    def setUp(self) -> None:
        """创建两个互不授权的用户。"""
        self.owner = get_user_model().objects.create_user(username="owner", password="owner-pass")
        self.other = get_user_model().objects.create_user(username="other", password="other-pass")
        self.experiment = create_experiment(self.owner, "私有实验")

    def test_anonymous_request_returns_auth_required(self) -> None:
        response = Client().get(f"/api/v1/experiments/{self.experiment.id}/state/")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "AUTH_REQUIRED")

    def test_other_user_cannot_read_experiment(self) -> None:
        client = Client()
        client.force_login(self.other)
        response = client.get(f"/api/v1/experiments/{self.experiment.id}/state/")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RESOURCE_NOT_FOUND")

    def test_vite_origin_can_login_with_csrf(self) -> None:
        """验证本地 Vite 代理来源可以完成受保护登录。"""
        client = Client(enforce_csrf_checks=True, HTTP_ORIGIN="http://127.0.0.1:5173")
        csrf_response = client.get("/api/v1/auth/csrf/")
        csrf_token = csrf_response.json()["csrf_token"]
        response = client.post(
            "/api/v1/auth/login/",
            {"username": "owner", "password": "owner-pass"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["username"], "owner")

    def test_csrf_failure_is_json(self) -> None:
        """验证 CSRF 拒绝不会向 SPA 返回 HTML。"""
        client = Client(enforce_csrf_checks=True, HTTP_ORIGIN="http://untrusted.example")
        response = client.post(
            "/api/v1/auth/login/",
            {"username": "owner", "password": "owner-pass"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.headers["Content-Type"], "application/json")
        self.assertEqual(response.json()["error"]["code"], "CSRF_FAILED")

    def test_anonymous_user_cannot_control_desktop_runtime_pool(self) -> None:
        """账户功能启用后，匿名请求不能枚举或操作宿主机虚拟机。"""
        response = Client().get("/api/v1/runtime/desktops/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "AUTH_REQUIRED")


class ServerExperimentDocumentTests(TestCase):
    """验证服务器实验保存、账户隔离和成员角色。"""

    def setUp(self) -> None:
        """创建所有者、编辑者、查看者和无权限账户。"""
        users = get_user_model().objects
        self.owner = users.create_user(username="lab-owner", password="owner-pass")
        self.editor = users.create_user(username="lab-editor", password="editor-pass")
        self.viewer = users.create_user(username="lab-viewer", password="viewer-pass")
        self.other = users.create_user(username="lab-other", password="other-pass")
        self.experiment = create_experiment(self.owner, "服务器实验")
        self.owner_client = Client()
        self.owner_client.force_login(self.owner)

    def document(self, name: str = "服务器实验") -> dict[str, object]:
        """生成最小合法 Web 实验文档。"""
        return {
            "schema_version": "1.0",
            "experiment_id": str(self.experiment.id),
            "name": name,
            "created_at": "2026-10-05T00:00:00.000Z",
            "updated_at": "2026-10-05T00:01:00.000Z",
            "devices": [],
            "cables": [],
            "cable_labels": {},
            "cable_waypoints": {},
            "scene": {
                "view": "iso",
                "display_mode": "shell",
                "flow_enabled": True,
                "auto_rotate": False,
                "render": {"quality": "auto"},
            },
        }

    def test_owner_saves_document_and_other_user_cannot_discover_it(self) -> None:
        """文档保存到数据库，未授权用户的列表和详情均不可见。"""
        response = self.owner_client.put(
            f"/api/v1/experiments/{self.experiment.id}/document/",
            json.dumps(
                {"expected_config_revision": 0, "document": self.document()}
            ),
            content_type="application/json",
        )
        other_client = Client()
        other_client.force_login(self.other)

        self.assertEqual(response.status_code, 200)
        self.experiment.refresh_from_db()
        self.assertEqual(self.experiment.document_json["name"], "服务器实验")
        self.assertEqual(self.experiment.config_revision, 1)
        self.assertEqual(other_client.get("/api/v1/experiments/").json(), [])
        hidden = other_client.get(
            f"/api/v1/experiments/{self.experiment.id}/document/"
        )
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(hidden.json()["error"]["code"], "RESOURCE_NOT_FOUND")

    def test_editor_can_save_but_viewer_cannot(self) -> None:
        """OWNER 可授权 EDITOR 保存，而 VIEWER 始终只读。"""
        for username, role in (("lab-editor", "EDITOR"), ("lab-viewer", "VIEWER")):
            response = self.owner_client.post(
                f"/api/v1/experiments/{self.experiment.id}/members/",
                json.dumps({"username": username, "role": role}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200)
        self.experiment.refresh_from_db()

        editor_client = Client()
        editor_client.force_login(self.editor)
        edited = editor_client.put(
            f"/api/v1/experiments/{self.experiment.id}/document/",
            json.dumps(
                {
                    "expected_config_revision": self.experiment.config_revision,
                    "document": self.document("编辑者保存"),
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(edited.status_code, 200)

        self.experiment.refresh_from_db()
        viewer_client = Client()
        viewer_client.force_login(self.viewer)
        rejected = viewer_client.put(
            f"/api/v1/experiments/{self.experiment.id}/document/",
            json.dumps(
                {
                    "expected_config_revision": self.experiment.config_revision,
                    "document": self.document("查看者修改"),
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.json()["error"]["code"], "PERMISSION_DENIED")

    def test_only_owner_can_archive_experiment(self) -> None:
        """删除采用命令审计的软归档，编辑者不能删除所有者实验。"""
        self.owner_client.post(
            f"/api/v1/experiments/{self.experiment.id}/members/",
            json.dumps({"username": "lab-editor", "role": "EDITOR"}),
            content_type="application/json",
        )
        editor_client = Client()
        editor_client.force_login(self.editor)
        rejected = editor_client.delete(
            f"/api/v1/experiments/{self.experiment.id}/document/"
        )
        archived = self.owner_client.delete(
            f"/api/v1/experiments/{self.experiment.id}/document/"
        )

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error"]["code"], "PERMISSION_DENIED")
        self.assertEqual(archived.status_code, 204)
        self.assertEqual(Experiment.objects.get(pk=self.experiment.id).status, "ARCHIVED")


@override_settings(
    G0_PC1_BRIDGE_ENABLED=True,
    G0_PC1_DOMAIN="simlab-g0-pc1",
    G0_PC1_NOVNC_URL="/g0-novnc/vnc.html?path=g0-novnc/websockify",
)
class G0PcBridgeApiTests(TestCase):
    """验证本机 PC 选择绑定、命令审计与真实电源投影。"""

    observation = {
        "domain_name": "simlab-g0-pc1",
        "power_state": "RUNNING",
        "source": "observed",
        "quality": "real_runtime",
        "vnc": {"listen": "127.0.0.1", "port": 5905},
    }

    def setUp(self) -> None:
        """为本机 Runtime 桥请求建立已认证 Session。"""
        self.user = get_user_model().objects.create_user(
            username="runtime-user", password="runtime-pass"
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.experiment = create_experiment(self.user, "G0 测试")
        self.experiment.document_json = {"devices": [{"device_id": "dev-009"}]}
        self.experiment.save(update_fields=("document_json",))
        ensure_external_runtime_instances()

    @patch("apps.experiments.services.observe_g0_runtime")
    def test_frontend_pc_can_be_selected_and_bound_through_command(
        self, observe_runtime: MagicMock
    ) -> None:
        """绑定必须持久化成功命令，响应带真实 VNC 端口。"""
        observe_runtime.return_value = self.observation
        response = self.client.put(
            "/api/v1/runtime/g0-pc1/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-009",
                    "model_id": "generic-atx-pc",
                    "display_name": "PC-009",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["bound_device_id"], "dev-009")
        self.assertEqual(response.json()["vnc"]["port"], 5905)
        self.assertTrue(
            ExternalRuntimeBinding.objects.filter(
                domain_name="simlab-g0-pc1", frontend_device_id="dev-009"
            ).exists()
        )
        command = ExternalRuntimeCommand.objects.get()
        self.assertEqual(command.type, "external.bind")
        self.assertEqual(command.status, ExternalRuntimeCommand.Status.SUCCEEDED)

    def test_non_pc_model_and_non_loopback_request_are_rejected(self) -> None:
        """只允许本机请求绑定固定 PC 型号。"""
        wrong_model = self.client.put(
            "/api/v1/runtime/g0-pc1/",
            json.dumps(
                {
                    "experiment_id": str(self.experiment.id),
                    "device_id": "dev-009",
                    "model_id": "huawei-s5731-s24t4x",
                    "display_name": "SW-009",
                }
            ),
            content_type="application/json",
        )
        remote_client = Client(REMOTE_ADDR="192.0.2.20")
        remote_client.force_login(self.user)
        remote = remote_client.get("/api/v1/runtime/g0-pc1/")
        proxy_client = Client(
            REMOTE_ADDR="127.0.0.1", HTTP_X_FORWARDED_FOR="127.0.0.1, 192.0.2.20"
        )
        proxy_client.force_login(self.user)
        remote_through_proxy = proxy_client.get("/api/v1/runtime/g0-pc1/")

        self.assertEqual(wrong_model.status_code, 400)
        self.assertEqual(wrong_model.json()["error"]["code"], "MODEL_NOT_BINDABLE")
        self.assertEqual(remote.status_code, 403)
        self.assertEqual(remote.json()["error"]["code"], "G0_BRIDGE_LOCAL_ONLY")
        self.assertEqual(remote_through_proxy.status_code, 403)

    @patch("apps.experiments.api.observe_g0_runtime")
    def test_other_account_cannot_read_bound_g0_pc(self, observe_runtime: MagicMock) -> None:
        """固定 PC 的绑定和 VNC 投影只能由实验成员读取。"""
        ExternalRuntimeBinding.objects.create(
            domain_name="simlab-g0-pc1",
            frontend_device_id="dev-009",
            model_id="generic-atx-pc",
            display_name="PC-009",
        )
        VirtualRuntimeInstance.objects.filter(domain_name="simlab-g0-pc1").update(
            frontend_device_id="dev-009", bound_experiment=self.experiment
        )
        other = get_user_model().objects.create_user(username="g0-other", password="other-pass")
        other_client = Client()
        other_client.force_login(other)

        response = other_client.get("/api/v1/runtime/g0-pc1/")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RESOURCE_NOT_FOUND")
        observe_runtime.assert_not_called()

    @patch("apps.experiments.services._runtime_client")
    def test_power_on_controls_only_the_bound_pc_and_records_command(
        self, runtime_client_factory: MagicMock
    ) -> None:
        """开机使用 Host Agent 固定 domain，并留下持久化命令结果。"""
        ExternalRuntimeBinding.objects.create(
            domain_name="simlab-g0-pc1",
            frontend_device_id="dev-009",
            model_id="generic-atx-pc",
            display_name="PC-009",
        )
        VirtualRuntimeInstance.objects.filter(domain_name="simlab-g0-pc1").update(
            frontend_device_id="dev-009", bound_experiment=self.experiment
        )
        runtime_client = runtime_client_factory.return_value
        runtime_client.start.return_value = self.observation

        response = self.client.post(
            "/api/v1/runtime/g0-pc1/power/",
            json.dumps({"device_id": "dev-009", "on": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["power_state"], "RUNNING")
        runtime_client.start.assert_called_once()
        command = ExternalRuntimeCommand.objects.get()
        self.assertEqual(command.type, "external.power_on")
        self.assertEqual(command.status, ExternalRuntimeCommand.Status.SUCCEEDED)
