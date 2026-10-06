#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 Django Command 经 Host Agent 控制真实 libvirt 运行单元。"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

PROJECT_ROOT: Final = Path(__file__).resolve().parents[2]
BACKEND_ROOT: Final = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.local")
os.environ["SIMLAB_RUNTIME_MODE"] = "runtime_real"

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402

from apps.experiments.models import (  # noqa: E402
    Command,
    DeviceInstance,
    DeviceModelRelease,
    Experiment,
    RuntimeUnit,
)
from apps.experiments.services import (  # noqa: E402
    CommandEnvelope,
    create_experiment,
    execute_command,
    submit_command,
)
from runtime.real_client import RealRuntimeClient, RuntimeTarget  # noqa: E402

EVIDENCE_PATH: Final = PROJECT_ROOT / "docs/poc/control-plane-runtime-evidence.json"


class ControlPlaneProbeError(RuntimeError):
    """真实控制平面探测未满足预期。"""


def execute(
    *,
    user: object,
    experiment: Experiment,
    command_type: str,
    payload: dict[str, object],
) -> Command:
    """同步提交并执行一条 Command，失败即终止探测。"""
    experiment.refresh_from_db()
    envelope = CommandEnvelope(
        uuid.uuid4(), command_type, experiment.config_revision, payload
    )
    command, created = submit_command(user, experiment.id, envelope)
    if not created:
        raise ControlPlaneProbeError("探测命令未被新建")
    execute_command(command.id)
    command.refresh_from_db()
    if command.status != Command.Status.SUCCEEDED:
        raise ControlPlaneProbeError(f"{command_type} 失败：{command.error}")
    return command


def create_probe_model(run_id: str) -> DeviceModelRelease:
    """创建本次探测专用且可删除的发布模型。"""
    manifest = {
        "schema_version": "1.1",
        "model_id": f"runtime-probe-{run_id[:8]}",
        "release_version": "1.0.0",
        "device_type": "pc",
        "name": "Runtime Probe PC",
        "ports": [
            {
                "port_key": "eth0",
                "connector_type": "RJ45",
                "protocol": "ethernet",
            }
        ],
        "runtime_profiles": [
            {
                "role": "guest_os",
                "backend": "qemu",
                "profile_release_id": "linux-cloud-profile-v1",
            }
        ],
    }
    digest = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return DeviceModelRelease.objects.create(
        model_id=manifest["model_id"],
        release_version="1.0.0",
        name="Runtime Probe PC",
        device_type="pc",
        manifest_hash=digest,
        manifest_json=manifest,
        publication_status="PUBLISHED",
    )


def run_probe() -> None:
    """执行真实 Command 闭环并输出可复核证据。"""
    run_id = str(uuid.uuid4())
    started_at = datetime.now(UTC)
    user = None
    model = None
    experiment = None
    target = None
    command_evidence: list[dict[str, object]] = []
    cleanup_errors: list[str] = []
    probe_error: str | None = None
    try:
        user = get_user_model().objects.create_user(username=f"runtime-probe-{run_id[:8]}")
        model = create_probe_model(run_id)
        experiment = create_experiment(user, f"Runtime Probe {run_id[:8]}")
        create_command = execute(
            user=user,
            experiment=experiment,
            command_type="device.create",
            payload={
                "model_release_id": str(model.id),
                "name": "PC-RUNTIME-PROBE",
                "position": {"x": 0, "y": 0, "z": 0},
            },
        )
        device = DeviceInstance.objects.get(pk=create_command.result["device_id"])
        unit = RuntimeUnit.objects.get(device=device)
        target = RuntimeTarget(unit.experiment_id, unit.id, unit.generation)
        command_evidence.append(
            {
                "type": create_command.type,
                "status": create_command.status,
                "command_id": str(create_command.id),
                "runtime_unit_id": str(unit.id),
            }
        )
        power_command = execute(
            user=user,
            experiment=experiment,
            command_type="device.power_on",
            payload={"device_id": str(device.id)},
        )
        device.refresh_from_db()
        unit.refresh_from_db()
        if (
            device.runtime_state != "RUNNING"
            or device.observed_json.get("source") != "observed"
            or device.observed_json.get("quality") != "real_runtime"
            or unit.state != "RUNNING"
        ):
            raise ControlPlaneProbeError("上电后数据库未保存真实 Runtime 观测")
        command_evidence.append(
            {
                "type": power_command.type,
                "status": power_command.status,
                "command_id": str(power_command.id),
                "observation": power_command.result.get("observation"),
            }
        )
        force_command = execute(
            user=user,
            experiment=experiment,
            command_type="device.force_off",
            payload={"device_id": str(device.id)},
        )
        device.refresh_from_db()
        if device.runtime_state != "STOPPED":
            raise ControlPlaneProbeError("强制断电后实际状态不是 STOPPED")
        command_evidence.append(
            {
                "type": force_command.type,
                "status": force_command.status,
                "command_id": str(force_command.id),
            }
        )
        delete_command = execute(
            user=user,
            experiment=experiment,
            command_type="device.delete",
            payload={"device_id": str(device.id)},
        )
        if DeviceInstance.objects.filter(pk=device.id).exists():
            raise ControlPlaneProbeError("设备删除后领域对象仍存在")
        command_evidence.append(
            {
                "type": delete_command.type,
                "status": delete_command.status,
                "command_id": str(delete_command.id),
            }
        )
    except Exception as error:
        probe_error = str(error)
    finally:
        if target is not None:
            client = RealRuntimeClient(Path("/run/simlab/host-agent.sock"), 180)
            try:
                client.delete_unit(uuid.uuid4(), target)
            except Exception as error:
                if "尚未定义" not in str(error):
                    cleanup_errors.append(str(error))
            try:
                client.delete_fabric(uuid.uuid4(), target.experiment_id)
            except Exception as error:
                cleanup_errors.append(str(error))
        if experiment is not None:
            experiment.delete()
        if model is not None:
            model.delete()
        if user is not None:
            user.delete()
    evidence = {
        "schema_version": "1.0",
        "gate": "TSK-008-control-plane",
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "passed": probe_error is None and not cleanup_errors,
        "runtime_mode": "runtime_real",
        "commands": command_evidence,
        "resources_cleaned": not cleanup_errors,
        "cleanup_errors": cleanup_errors,
        "error": probe_error,
    }
    EVIDENCE_PATH.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not evidence["passed"]:
        raise ControlPlaneProbeError(probe_error or f"清理失败：{cleanup_errors}")
    print(json.dumps({"passed": True, "evidence": str(EVIDENCE_PATH)}, ensure_ascii=False))


def main() -> int:
    """命令行入口。"""
    try:
        run_probe()
        return 0
    except ControlPlaneProbeError as error:
        print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
