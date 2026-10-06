#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 DB Outbox 经 Redis Streams 跨进程进入 Channels。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

PROJECT_ROOT: Final = Path(__file__).resolve().parents[2]
BACKEND_ROOT: Final = PROJECT_ROOT / "backend"
MANAGE_PATH: Final = BACKEND_ROOT / "manage.py"
EVIDENCE_PATH: Final = PROJECT_ROOT / "docs/poc/event-pipeline-evidence.json"
LISTENER_CODE: Final = """
import asyncio
import json
import django

django.setup()
from channels.layers import get_channel_layer

async def listen():
    layer = get_channel_layer()
    channel = await layer.new_channel("simlab.probe.")
    await layer.group_add("experiment." + __import__("os").environ["PROBE_EXPERIMENT_ID"], channel)
    print(json.dumps({"ready": True, "channel": channel}), flush=True)
    message = await asyncio.wait_for(layer.receive(channel), timeout=15)
    print(json.dumps(message, ensure_ascii=False), flush=True)
    await layer.group_discard(
        "experiment." + __import__("os").environ["PROBE_EXPERIMENT_ID"], channel
    )

asyncio.run(listen())
"""


class EventPipelineProbeError(RuntimeError):
    """跨进程事件闭环未满足预期。"""


def run_command(arguments: list[str], environment: dict[str, str]) -> str:
    """执行独立 Django 进程并返回 stdout。"""
    completed = subprocess.run(
        arguments,
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        raise EventPipelineProbeError(
            f"子进程失败：{arguments[-1]}: {(completed.stderr or completed.stdout).strip()}"
        )
    return completed.stdout.strip()


def run_probe() -> None:
    """创建持久事件并通过三个独立进程完成投递。"""
    run_id = uuid.uuid4().hex
    stream_key = f"simlab:probe:{run_id}:events"
    stream_group = f"simlab-probe-{run_id}"
    channel_prefix = f"simlab-probe-{run_id}"
    environment = os.environ.copy()
    environment.update(
        {
            "DJANGO_SETTINGS_MODULE": "config.settings.local",
            "SIMLAB_RUNTIME_MODE": "runtime_real",
            "SIMLAB_CHANNEL_LAYER": "redis",
            "CHANNEL_REDIS_URL": "redis://127.0.0.1:6379/1",
            "EVENT_STREAM_REDIS_URL": "redis://127.0.0.1:6379/2",
            "SIMLAB_EVENT_STREAM_KEY": stream_key,
            "SIMLAB_EVENT_STREAM_GROUP": stream_group,
            "SIMLAB_CHANNEL_PREFIX": channel_prefix,
            "PYTHONPATH": str(BACKEND_ROOT),
        }
    )
    os.environ.update(environment)
    sys.path.insert(0, str(BACKEND_ROOT))

    import django

    django.setup()
    import redis
    from django.contrib.auth import get_user_model

    from apps.experiments.models import OutboxMessage
    from apps.experiments.services import create_experiment

    user = None
    experiment = None
    listener: subprocess.Popen[str] | None = None
    cleanup_errors: list[str] = []
    probe_error: str | None = None
    observations: dict[str, object] = {}
    started_at = datetime.now(UTC)
    try:
        user = get_user_model().objects.create_user(username=f"event-probe-{run_id[:8]}")
        experiment = create_experiment(user, f"Event Pipeline Probe {run_id[:8]}")
        target_outbox = OutboxMessage.objects.get(event__experiment=experiment)
        environment["PROBE_EXPERIMENT_ID"] = str(experiment.id)
        listener = subprocess.Popen(
            [sys.executable, "-c", LISTENER_CODE],
            cwd=PROJECT_ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert listener.stdout is not None
        ready_line = listener.stdout.readline().strip()
        ready = json.loads(ready_line)
        if ready.get("ready") is not True:
            raise EventPipelineProbeError("Channels listener 未就绪")
        observations["listener"] = ready
        dispatch_output = run_command(
            [
                sys.executable,
                str(MANAGE_PATH),
                "run_outbox_dispatcher",
                "--once",
                "--experiment-id",
                str(experiment.id),
            ],
            environment,
        )
        observations["outbox_dispatched"] = int(dispatch_output.splitlines()[-1])
        relay_output = run_command(
            [
                sys.executable,
                str(MANAGE_PATH),
                "run_event_relay",
                "--once",
                "--consumer",
                f"probe-{run_id}",
                "--block-ms",
                "1000",
            ],
            environment,
        )
        observations["relay_delivered"] = int(relay_output.splitlines()[-1])
        remaining_stdout, listener_stderr = listener.communicate(timeout=20)
        if listener.returncode != 0:
            raise EventPipelineProbeError(f"Channels listener 失败：{listener_stderr.strip()}")
        delivered = json.loads(remaining_stdout.strip().splitlines()[-1])
        observations["channel_message"] = delivered
        payload = delivered.get("payload", {})
        target_outbox.refresh_from_db()
        if (
            observations["outbox_dispatched"] != 1
            or observations["relay_delivered"] != 1
            or delivered.get("type") != "experiment.event"
            or not isinstance(payload, dict)
            or payload.get("experiment_id") != str(experiment.id)
            or payload.get("seq") != 1
            or target_outbox.published_at is None
            or target_outbox.attempts != 1
        ):
            raise EventPipelineProbeError("跨进程事件内容或 Outbox 状态不一致")
    except Exception as error:
        probe_error = str(error)
    finally:
        if listener is not None and listener.poll() is None:
            listener.terminate()
            try:
                listener.wait(timeout=5)
            except subprocess.TimeoutExpired:
                listener.kill()
        for redis_url, key_pattern in (
            ("redis://127.0.0.1:6379/2", stream_key),
            ("redis://127.0.0.1:6379/1", f"{channel_prefix}*"),
        ):
            try:
                redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
                keys = list(redis_client.scan_iter(match=key_pattern))
                if keys:
                    redis_client.delete(*keys)
            except redis.RedisError as error:
                cleanup_errors.append(str(error))
        if experiment is not None:
            experiment.delete()
        if user is not None:
            user.delete()
    evidence = {
        "schema_version": "1.0",
        "gate": "TSK-009",
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "passed": probe_error is None and not cleanup_errors,
        "process_boundary": ["channels-listener", "outbox-dispatcher", "event-relay"],
        "redis": {"streams_db": 2, "channels_db": 1, "version": "8.0.5"},
        "observations": observations,
        "resources_cleaned": not cleanup_errors,
        "cleanup_errors": cleanup_errors,
        "error": probe_error,
    }
    EVIDENCE_PATH.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not evidence["passed"]:
        raise EventPipelineProbeError(probe_error or f"清理失败：{cleanup_errors}")
    print(json.dumps({"passed": True, "evidence": str(EVIDENCE_PATH)}, ensure_ascii=False))


def main() -> int:
    """命令行入口。"""
    try:
        run_probe()
        return 0
    except EventPipelineProbeError as error:
        print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
