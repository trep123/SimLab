#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证鉴权 ASGI WebSocket 的实时事件与断线补齐。"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from websockets.sync.client import connect

PROJECT_ROOT: Final = Path(__file__).resolve().parents[2]
BACKEND_ROOT: Final = PROJECT_ROOT / "backend"
MANAGE_PATH: Final = BACKEND_ROOT / "manage.py"
EVIDENCE_PATH: Final = PROJECT_ROOT / "docs/poc/websocket-pipeline-evidence.json"


class WebSocketProbeError(RuntimeError):
    """鉴权 WebSocket 闭环未满足预期。"""


def free_port() -> int:
    """取得当前可绑定的本机 TCP 端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_for_api(base_url: str, process: subprocess.Popen[str]) -> None:
    """等待 Uvicorn 健康检查成功或提前失败。"""
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            _, error_output = process.communicate()
            raise WebSocketProbeError(f"Uvicorn 提前退出：{error_output.strip()}")
        try:
            with urllib.request.urlopen(f"{base_url}/api/v1/health/live/", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.2)
    raise WebSocketProbeError("Uvicorn 未在截止时间内就绪")


def append_probe_event(experiment_id: uuid.UUID, event_type: str) -> int:
    """在数据库锁内追加用于验收的持久事件。"""
    from django.db import transaction

    from apps.experiments.models import Experiment
    from apps.experiments.services import append_event

    with transaction.atomic():
        experiment = Experiment.objects.select_for_update().get(pk=experiment_id)
        event = append_event(experiment, event_type, {"probe": True})
    return event.seq


def wait_for_outbox(experiment_id: uuid.UUID, sequence: int) -> None:
    """等待 dispatcher 把指定事件标为已进入 Stream。"""
    from apps.experiments.models import OutboxMessage

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if OutboxMessage.objects.filter(
            event__experiment_id=experiment_id,
            event__seq=sequence,
            published_at__isnull=False,
        ).exists():
            time.sleep(0.5)
            return
        time.sleep(0.1)
    raise WebSocketProbeError(f"事件 {sequence} 未进入 Redis Stream")


def get_json(url: str, session_cookie: str) -> object:
    """携带 Django Session 执行鉴权 GET。"""
    request = urllib.request.Request(url, headers={"Cookie": f"sessionid={session_cookie}"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def stop_process(process: subprocess.Popen[str] | None) -> None:
    """温和停止探测子进程，超时后终止。"""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_probe() -> None:
    """运行真实 ASGI、Redis 与断线补齐闭环。"""
    run_id = uuid.uuid4().hex
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    websocket_url = f"ws://127.0.0.1:{port}"
    stream_key = f"simlab:ws-probe:{run_id}:events"
    stream_group = f"simlab-ws-probe-{run_id}"
    channel_prefix = f"simlab-ws-probe-{run_id}"
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
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.test import Client

    from apps.experiments.services import create_experiment

    started_at = datetime.now(UTC)
    user = None
    experiment = None
    api_process: subprocess.Popen[str] | None = None
    outbox_process: subprocess.Popen[str] | None = None
    relay_process: subprocess.Popen[str] | None = None
    cleanup_errors: list[str] = []
    probe_error: str | None = None
    observations: dict[str, object] = {}
    try:
        user = get_user_model().objects.create_user(username=f"ws-probe-{run_id[:8]}")
        experiment = create_experiment(user, f"WebSocket Probe {run_id[:8]}")
        client = Client()
        client.force_login(user)
        session_cookie = client.cookies[settings.SESSION_COOKIE_NAME].value
        environment["PROBE_EXPERIMENT_ID"] = str(experiment.id)
        api_process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "config.asgi:application",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=BACKEND_ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        wait_for_api(base_url, api_process)
        outbox_process = subprocess.Popen(
            [
                sys.executable,
                str(MANAGE_PATH),
                "run_outbox_dispatcher",
                "--experiment-id",
                str(experiment.id),
                "--poll-seconds",
                "0.05",
            ],
            cwd=PROJECT_ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        relay_process = subprocess.Popen(
            [
                sys.executable,
                str(MANAGE_PATH),
                "run_event_relay",
                "--consumer",
                f"ws-probe-{run_id}",
                "--block-ms",
                "100",
            ],
            cwd=PROJECT_ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        websocket_path = f"{websocket_url}/ws/experiments/{experiment.id}/"
        headers = {"Cookie": f"sessionid={session_cookie}"}
        with connect(
            websocket_path,
            origin=base_url,
            additional_headers=headers,
            proxy=None,
        ) as websocket:
            ready = json.loads(websocket.recv(timeout=5))
            observations["initial_cursor"] = ready
            if ready.get("type") != "subscription.ready" or ready.get("latest_seq") != 1:
                raise WebSocketProbeError("初始订阅游标不正确")
            live_sequence = append_probe_event(experiment.id, "probe.live")
            deadline = time.monotonic() + 10
            live_event = None
            while time.monotonic() < deadline:
                candidate = json.loads(websocket.recv(timeout=5))
                if candidate.get("seq") == live_sequence:
                    live_event = candidate
                    break
            if live_event is None:
                raise WebSocketProbeError("实时事件未到达鉴权 WebSocket")
            observations["live_event"] = live_event
        missed_sequence = append_probe_event(experiment.id, "probe.while_disconnected")
        wait_for_outbox(experiment.id, missed_sequence)
        with connect(
            websocket_path,
            origin=base_url,
            additional_headers=headers,
            proxy=None,
        ) as websocket:
            reconnect_cursor = json.loads(websocket.recv(timeout=5))
            observations["reconnect_cursor"] = reconnect_cursor
            if reconnect_cursor.get("latest_seq") != missed_sequence:
                raise WebSocketProbeError("重连游标未暴露断线期间的尾部事件")
        missing_events = get_json(
            f"{base_url}/api/v1/experiments/{experiment.id}/events/?after_seq={live_sequence}",
            session_cookie,
        )
        observations["rest_gap_fill"] = missing_events
        if (
            not isinstance(missing_events, list)
            or [event.get("seq") for event in missing_events] != [missed_sequence]
        ):
            raise WebSocketProbeError("REST after_seq 未准确补齐断线事件")
    except Exception as error:
        probe_error = str(error)
    finally:
        for process in (relay_process, outbox_process, api_process):
            stop_process(process)
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
        "gate": "TSK-009-websocket",
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "passed": probe_error is None and not cleanup_errors,
        "process_boundary": ["uvicorn", "outbox-dispatcher", "event-relay", "ws-client"],
        "authentication": "django_session",
        "observations": observations,
        "resources_cleaned": not cleanup_errors,
        "cleanup_errors": cleanup_errors,
        "error": probe_error,
    }
    EVIDENCE_PATH.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not evidence["passed"]:
        raise WebSocketProbeError(probe_error or f"清理失败：{cleanup_errors}")
    print(json.dumps({"passed": True, "evidence": str(EVIDENCE_PATH)}, ensure_ascii=False))


def main() -> int:
    """命令行入口。"""
    try:
        run_probe()
        return 0
    except WebSocketProbeError as error:
        print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
