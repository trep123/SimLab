# -*- coding: utf-8 -*-
"""创建本地演示用户、设备目录和实验。"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.experiments.models import DeviceModelRelease, DevicePort
from apps.experiments.services import (
    CommandEnvelope,
    create_experiment,
    execute_command,
    submit_command,
)


class Command(BaseCommand):
    """创建可重复执行的本地演示数据。"""

    help = "创建 SimLab 本地演示数据"

    def handle(self, *args: object, **options: object) -> None:
        """写入演示目录与拓扑。"""
        if settings.RUNTIME_MODE != "development_mock":
            self.stderr.write(self.style.ERROR("seed_demo 仅允许 development_mock"))
            return
        user_model = get_user_model()
        demo_username = os.environ.get("SIMLAB_DEMO_USERNAME", "demo")
        demo_password = os.environ.get("SIMLAB_DEMO_PASSWORD")
        if not demo_password and not user_model.objects.filter(username=demo_username).exists():
            raise CommandError("首次创建演示用户必须设置 SIMLAB_DEMO_PASSWORD")
        user, created = user_model.objects.get_or_create(username=demo_username)
        if created or demo_password:
            user.set_password(demo_password)
            user.save(update_fields=("password",))
        manifest_path = Path(settings.BASE_DIR).parent / "assets" / "profiles" / "generic-pc.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
        model, _ = DeviceModelRelease.objects.get_or_create(
            model_id=manifest["model_id"],
            release_version=manifest["release_version"],
            defaults={
                "schema_version": manifest["schema_version"],
                "name": manifest["name"],
                "device_type": manifest["device_type"],
                "manifest_hash": digest,
                "manifest_json": manifest,
                "publication_status": "PUBLISHED",
            },
        )
        DeviceModelRelease.objects.filter(
            model_id=manifest["model_id"], publication_status="PUBLISHED"
        ).exclude(pk=model.pk).update(publication_status="RETIRED")

        def ethernet_ports(
            keys: tuple[str, ...], speed_bps: int = 1_000_000_000
        ) -> list[dict[str, object]]:
            return [
                {
                    "port_key": key,
                    "connector_type": "RJ45",
                    "role": "bidirectional",
                    "protocol": "ethernet",
                    "speed_bps": speed_bps,
                }
                for key in keys
            ]

        catalog = (
            (
                "generic-switch",
                "教学交换机",
                "switch",
                ethernet_ports(tuple(f"eth{index}" for index in range(8))),
            ),
            ("linux-server", "Linux 服务器", "server", ethernet_ports(("eth0", "eth1"))),
            (
                "frr-router",
                "FRR 路由器",
                "router",
                ethernet_ports(("wan0", "lan0", "lan1", "lan2")),
            ),
            (
                "nft-firewall",
                "nftables 防火墙",
                "firewall",
                ethernet_ports(("wan0", "lan0", "dmz0")),
            ),
            ("wireless-ap", "无线接入点", "access_point", ethernet_ports(("poe0", "lan1"))),
            (
                "optical-onu",
                "光网络 ONU",
                "onu",
                [
                    {
                        "port_key": "pon0",
                        "connector_type": "SC_APC",
                        "role": "bidirectional",
                        "protocol": "gpon",
                        "speed_bps": 2_500_000_000,
                    },
                    *ethernet_ports(("lan0",)),
                ],
            ),
            (
                "optical-olt",
                "光线路终端 OLT",
                "olt",
                [
                    {
                        "port_key": f"pon{index}",
                        "connector_type": "SC_APC",
                        "role": "bidirectional",
                        "protocol": "gpon",
                        "speed_bps": 2_500_000_000,
                    }
                    for index in range(2)
                ]
                + [
                    {
                        "port_key": f"uplink{index}",
                        "connector_type": "SFP_PLUS",
                        "role": "bidirectional",
                        "protocol": "ethernet",
                        "speed_bps": 10_000_000_000,
                    }
                    for index in range(2)
                ],
            ),
        )
        for model_id, name, device_type, ports in catalog:
            item_manifest = {
                **manifest,
                "model_id": model_id,
                "name": name,
                "device_type": device_type,
                "visual": {
                    "asset_id": None,
                    "units": "meter",
                    "anchors": {
                        str(port["port_key"]): f"PORT_{str(port['port_key']).upper()}"
                        for port in ports
                    },
                },
                "ports": ports,
                "runtime_profiles": [],
                "fidelity": {"network": "visual_development_mock"},
            }
            item_digest = hashlib.sha256(
                json.dumps(item_manifest, sort_keys=True).encode()
            ).hexdigest()
            catalog_model, _ = DeviceModelRelease.objects.get_or_create(
                model_id=model_id,
                release_version="1.1.0",
                defaults={
                    "schema_version": "1.1",
                    "name": name,
                    "device_type": device_type,
                    "manifest_hash": item_digest,
                    "manifest_json": item_manifest,
                    "publication_status": "PUBLISHED",
                },
            )
            DeviceModelRelease.objects.filter(
                model_id=model_id, publication_status="PUBLISHED"
            ).exclude(pk=catalog_model.pk).update(publication_status="RETIRED")
        if user.experiment_memberships.exists():
            self.stdout.write(f"演示数据已存在；账号 {demo_username}")
            return
        experiment = create_experiment(user, "双机网络实验")
        for index, x_position in enumerate((-2.3, 2.3), start=1):
            envelope = CommandEnvelope(
                command_id=uuid.uuid4(),
                type="device.create",
                expected_config_revision=experiment.config_revision,
                payload={
                    "model_release_id": str(model.id),
                    "name": f"PC-{index:02}",
                    "position": {"x": x_position, "y": 0.4, "z": 0},
                },
            )
            command, _ = submit_command(user, experiment.id, envelope)
            execute_command(command.id)
            experiment.refresh_from_db()
        ports = list(
            DevicePort.objects.filter(experiment=experiment, protocol="ethernet").order_by(
                "device__name"
            )
        )
        envelope = CommandEnvelope(
            command_id=uuid.uuid4(),
            type="cable.connect",
            expected_config_revision=experiment.config_revision,
            payload={"port_a_id": str(ports[0].id), "port_b_id": str(ports[1].id)},
        )
        command, _ = submit_command(user, experiment.id, envelope)
        execute_command(command.id)
        self.stdout.write(self.style.SUCCESS(f"已创建演示账号 {demo_username}"))
