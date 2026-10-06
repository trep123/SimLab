# -*- coding: utf-8 -*-
"""命令幂等、版本和拓扑规则测试。"""

from __future__ import annotations

import hashlib
import uuid

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.experiments.models import (
    Cable,
    CableEnd,
    DeviceInstance,
    DeviceModelRelease,
    DevicePort,
    PortAttachment,
)
from apps.experiments.services import (
    CommandEnvelope,
    SimlabError,
    create_experiment,
    execute_command,
    submit_command,
)


def create_model() -> DeviceModelRelease:
    """创建用于测试的已发布 PC 型号。"""
    manifest = {
        "ports": [
            {"port_key": "eth0", "connector_type": "RJ45", "protocol": "ethernet"},
            {"port_key": "eth1", "connector_type": "RJ45", "protocol": "ethernet"},
        ]
    }
    return DeviceModelRelease.objects.create(
        model_id="test-pc",
        release_version="1.0.0",
        name="测试 PC",
        device_type="pc",
        manifest_hash=hashlib.sha256(b"test").hexdigest(),
        manifest_json=manifest,
        publication_status="PUBLISHED",
    )


class CommandServiceTests(TestCase):
    """验证 Command 是所有状态变更的可靠入口。"""

    def setUp(self) -> None:
        """建立隔离用户和实验。"""
        self.user = get_user_model().objects.create_user(username="owner", password="secret-pass")
        self.experiment = create_experiment(self.user, "测试实验")
        self.model = create_model()

    def create_device(self, name: str, revision: int) -> str:
        """通过命令创建设备并返回 ID。"""
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.create",
            revision,
            {
                "model_release_id": str(self.model.id),
                "name": name,
                "position": {"x": 0, "y": 0, "z": 0},
            },
        )
        command, created = submit_command(self.user, self.experiment.id, envelope)
        self.assertTrue(created)
        execute_command(command.id)
        command.refresh_from_db()
        return str(command.result["device_id"])

    def test_same_command_is_idempotent(self) -> None:
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.create",
            0,
            {
                "model_release_id": str(self.model.id),
                "name": "PC01",
                "position": {"x": 0, "y": 0, "z": 0},
            },
        )
        first, created = submit_command(self.user, self.experiment.id, envelope)
        second, repeated = submit_command(self.user, self.experiment.id, envelope)
        self.assertTrue(created)
        self.assertFalse(repeated)
        self.assertEqual(first.id, second.id)

    def test_same_id_with_other_payload_is_rejected(self) -> None:
        command_id = uuid.uuid4()
        first = CommandEnvelope(
            command_id, "device.create", 0, {"model_release_id": str(self.model.id), "name": "A"}
        )
        second = CommandEnvelope(
            command_id, "device.create", 0, {"model_release_id": str(self.model.id), "name": "B"}
        )
        submit_command(self.user, self.experiment.id, first)
        with self.assertRaisesMessage(SimlabError, "命令 ID 已被其他请求使用"):
            submit_command(self.user, self.experiment.id, second)

    def test_stale_revision_is_rejected(self) -> None:
        self.create_device("PC01", 0)
        stale = CommandEnvelope(
            uuid.uuid4(),
            "device.create",
            0,
            {"model_release_id": str(self.model.id), "name": "PC02"},
        )
        with self.assertRaisesMessage(SimlabError, "配置版本已变更"):
            submit_command(self.user, self.experiment.id, stale)

    def test_port_cannot_be_occupied_twice(self) -> None:
        self.create_device("PC01", 0)
        self.experiment.refresh_from_db()
        self.create_device("PC02", self.experiment.config_revision)
        ports = list(
            DevicePort.objects.filter(experiment=self.experiment).order_by(
                "device__name", "port_key"
            )
        )
        first_cable = Cable.objects.create(experiment=self.experiment)
        first_end = CableEnd.objects.create(cable=first_cable, end="A")
        PortAttachment.objects.create(
            experiment=self.experiment, cable_end=first_end, device_port=ports[0], state="ACTIVE"
        )
        second_cable = Cable.objects.create(experiment=self.experiment)
        second_end = CableEnd.objects.create(cable=second_cable, end="A")
        with self.assertRaises(IntegrityError), transaction.atomic():
            PortAttachment.objects.create(
                experiment=self.experiment,
                cable_end=second_end,
                device_port=ports[0],
                state="RESERVED",
            )

    def test_connect_and_disconnect_changes_carrier_without_deleting_port(self) -> None:
        self.create_device("PC01", 0)
        self.experiment.refresh_from_db()
        self.create_device("PC02", self.experiment.config_revision)
        self.experiment.refresh_from_db()
        ports = list(
            DevicePort.objects.filter(experiment=self.experiment, port_key="eth0").order_by(
                "device__name"
            )
        )
        connect = CommandEnvelope(
            uuid.uuid4(),
            "cable.connect",
            self.experiment.config_revision,
            {"port_a_id": str(ports[0].id), "port_b_id": str(ports[1].id)},
        )
        command, _ = submit_command(self.user, self.experiment.id, connect)
        execute_command(command.id)
        command.refresh_from_db()
        DevicePort.objects.get(pk=ports[0].id).refresh_from_db()
        self.assertEqual(DevicePort.objects.get(pk=ports[0].id).carrier_state, "UP")
        self.experiment.refresh_from_db()
        disconnect = CommandEnvelope(
            uuid.uuid4(),
            "cable.disconnect",
            self.experiment.config_revision,
            {"cable_id": command.result["cable_id"]},
        )
        second_command, _ = submit_command(self.user, self.experiment.id, disconnect)
        execute_command(second_command.id)
        self.assertEqual(DevicePort.objects.get(pk=ports[0].id).carrier_state, "DOWN")
        self.assertEqual(DevicePort.objects.filter(pk=ports[0].id).count(), 1)
        self.client.force_login(self.user)
        response = self.client.get(f"/api/v1/experiments/{self.experiment.id}/state/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["cables"], [])

    def test_connect_rejects_different_physical_connectors(self) -> None:
        """RJ45 与 SFP+ 即使都是以太网协议也不能直接接线。"""
        self.create_device("PC01", 0)
        self.experiment.refresh_from_db()
        self.create_device("PC02", self.experiment.config_revision)
        self.experiment.refresh_from_db()
        ports = list(
            DevicePort.objects.filter(experiment=self.experiment, port_key="eth0").order_by(
                "device__name"
            )
        )
        DevicePort.objects.filter(pk=ports[1].pk).update(connector_type="SFP_PLUS")
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "cable.connect",
            self.experiment.config_revision,
            {"port_a_id": str(ports[0].id), "port_b_id": str(ports[1].id)},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        execute_command(command.id)
        command.refresh_from_db()
        self.assertEqual(command.status, "FAILED")
        self.assertEqual(command.error["code"], "PORT_INCOMPATIBLE")
        self.assertFalse(Cable.objects.filter(experiment=self.experiment).exists())

    def test_device_can_be_renamed_through_command(self) -> None:
        device_id = self.create_device("PC01", 0)
        self.experiment.refresh_from_db()
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.update",
            self.experiment.config_revision,
            {"device_id": device_id, "name": "核心工作站"},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        execute_command(command.id)
        self.assertEqual(DeviceInstance.objects.get(pk=device_id).name, "核心工作站")

    def test_stopped_unconnected_device_can_be_deleted(self) -> None:
        device_id = self.create_device("PC01", 0)
        self.experiment.refresh_from_db()
        envelope = CommandEnvelope(
            uuid.uuid4(),
            "device.delete",
            self.experiment.config_revision,
            {"device_id": device_id},
        )
        command, _ = submit_command(self.user, self.experiment.id, envelope)
        execute_command(command.id)
        self.assertFalse(DeviceInstance.objects.filter(pk=device_id).exists())
