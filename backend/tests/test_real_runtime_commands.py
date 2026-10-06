# -*- coding: utf-8 -*-
"""真实 Runtime 模式的 Command 到 Host Agent 投影测试。"""

from __future__ import annotations

import hashlib
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.experiments.models import (
    DeviceInstance,
    DeviceModelRelease,
    DevicePort,
    PortAttachment,
    RuntimeUnit,
)
from apps.experiments.services import (
    CommandEnvelope,
    create_experiment,
    execute_command,
    submit_command,
)
from runtime.real_client import HostAgentClientError, RuntimeTarget


class FakeRuntimeClient:
    """记录控制平面应发送的结构化动作。"""

    def __init__(self) -> None:
        self.actions: list[tuple[str, RuntimeTarget]] = []

    @staticmethod
    def _observation(target: RuntimeTarget, power_state: str) -> dict[str, object]:
        return {
            "unit_id": str(target.unit_id),
            "experiment_id": str(target.experiment_id),
            "generation": target.generation,
            "domain_name": f"simlab-{target.unit_id.hex[:12]}-g{target.generation}",
            "power_state": power_state,
            "source": "observed",
            "quality": "real_runtime",
        }

    def ensure_defined(
        self, operation_id: uuid.UUID, target: RuntimeTarget, spec: dict[str, object]
    ) -> dict[str, object]:
        self.actions.append(("ENSURE_DEFINED", target))
        assert operation_id
        assert spec["profile_release_id"] == "linux-cloud-profile-v1"
        return self._observation(target, "STOPPED")

    def start(self, operation_id: uuid.UUID, target: RuntimeTarget) -> dict[str, object]:
        self.actions.append(("START", target))
        assert operation_id
        return self._observation(target, "RUNNING")

    def set_link(
        self,
        operation_id: uuid.UUID,
        target: RuntimeTarget,
        port_alias: str,
        *,
        up: bool,
    ) -> dict[str, object]:
        self.actions.append((f"SET_LINK:{port_alias}:{up}", target))
        assert operation_id
        observation = self._observation(target, "RUNNING")
        observation["link_state"] = "UP" if up else "DOWN"
        return observation


def create_real_model() -> DeviceModelRelease:
    """创建声明真实 QEMU profile 的测试型号。"""
    manifest = {
        "ports": [{"port_key": "eth0", "connector_type": "RJ45", "protocol": "ethernet"}],
        "runtime_profiles": [
            {
                "role": "guest_os",
                "backend": "qemu",
                "profile_release_id": "linux-cloud-profile-v1",
            }
        ],
    }
    return DeviceModelRelease.objects.create(
        model_id="real-test-pc",
        release_version="1.0.0",
        name="真实测试 PC",
        device_type="pc",
        manifest_hash=hashlib.sha256(b"real-test").hexdigest(),
        manifest_json=manifest,
        publication_status="PUBLISHED",
    )


@override_settings(RUNTIME_MODE="runtime_real")
class RealRuntimeCommandTests(TestCase):
    """验证数据库只接受 Host Agent 的实际观测。"""

    def setUp(self) -> None:
        """建立隔离实验和真实 profile。"""
        self.user = get_user_model().objects.create_user(username="real-owner")
        self.experiment = create_experiment(self.user, "真实 Runtime 测试")
        self.model = create_real_model()

    def create_device(self, name: str = "PC-REAL") -> DeviceInstance:
        """通过 Command 创建带 RuntimeUnit 的设备。"""
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.create",
            self.experiment.config_revision,
            {"model_release_id": str(self.model.id), "name": name},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        execute_command(command.id)
        command.refresh_from_db()
        self.experiment.refresh_from_db()
        return DeviceInstance.objects.get(pk=command.result["device_id"])

    def test_power_on_uses_agent_and_persists_observation(self) -> None:
        device = self.create_device()
        fake_client = FakeRuntimeClient()
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.power_on",
            self.experiment.config_revision,
            {"device_id": str(device.id)},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        with patch("apps.experiments.services._runtime_client", return_value=fake_client):
            execute_command(command.id)
        device.refresh_from_db()
        unit = RuntimeUnit.objects.get(device=device)
        assert [action for action, _ in fake_client.actions] == ["ENSURE_DEFINED", "START"]
        assert device.runtime_state == "RUNNING"
        assert device.observed_json["source"] == "observed"
        assert device.observed_json["quality"] == "real_runtime"
        assert unit.state == "RUNNING"

    def test_agent_failure_marks_command_failed_without_fake_success(self) -> None:
        device = self.create_device()
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.power_on",
            self.experiment.config_revision,
            {"device_id": str(device.id)},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        with patch(
            "apps.experiments.services.RealRuntimeClient.ensure_defined",
            side_effect=HostAgentClientError(
                "HOST_AGENT_UNAVAILABLE", "Host Agent 不可用", retryable=True
            ),
        ):
            execute_command(command.id)
        command.refresh_from_db()
        device.refresh_from_db()
        assert command.status == "FAILED"
        assert command.error["code"] == "HOST_AGENT_UNAVAILABLE"
        assert device.runtime_state == "STOPPED"
        assert device.observed_json["runtime_mode"] == "runtime_real"

    def test_second_link_failure_releases_reservations_and_compensates_first(self) -> None:
        """验证两端接线半失败时反向关闭首端并释放数据库预留。"""
        first_device = self.create_device("PC-A")
        second_device = self.create_device("PC-B")
        RuntimeUnit.objects.filter(device__in=(first_device, second_device)).update(state="RUNNING")
        ports = list(
            DevicePort.objects.filter(
                device__in=(first_device, second_device), port_key="eth0"
            ).order_by("device__name")
        )

        class FailingSecondLinkClient(FakeRuntimeClient):
            """第二次链路修改失败，后续补偿调用恢复成功。"""

            def __init__(self) -> None:
                super().__init__()
                self.link_calls = 0

            def set_link(
                self,
                operation_id: uuid.UUID,
                target: RuntimeTarget,
                port_alias: str,
                *,
                up: bool,
            ) -> dict[str, object]:
                self.link_calls += 1
                self.actions.append((f"SET_LINK:{port_alias}:{up}", target))
                if self.link_calls == 2:
                    raise HostAgentClientError(
                        "LINK_APPLY_FAILED", "第二端应用失败", retryable=True
                    )
                observation = self._observation(target, "RUNNING")
                observation["link_state"] = "UP" if up else "DOWN"
                return observation

        fake_client = FailingSecondLinkClient()
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "cable.connect",
            self.experiment.config_revision,
            {"port_a_id": str(ports[0].id), "port_b_id": str(ports[1].id)},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        with patch("apps.experiments.services._runtime_client", return_value=fake_client):
            execute_command(command.id)

        command.refresh_from_db()
        assert command.status == "FAILED"
        assert command.error["code"] == "LINK_APPLY_FAILED"
        assert (
            PortAttachment.objects.filter(
                experiment=self.experiment,
                state__in=(PortAttachment.State.RESERVED, PortAttachment.State.ACTIVE),
            ).count()
            == 0
        )
        connected_count = DevicePort.objects.filter(
            id__in=[port.id for port in ports], physical_connected=True
        ).count()
        assert connected_count == 0
        assert [action for action, _ in fake_client.actions][-1].endswith(":False")
        compensated_unit = RuntimeUnit.objects.get(device=first_device)
        assert compensated_unit.observed_json["link_state"] == "DOWN"
