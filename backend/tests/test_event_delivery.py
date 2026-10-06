# -*- coding: utf-8 -*-
"""Outbox、Redis Stream 与 Channels relay 语义测试。"""

from __future__ import annotations

import json
from unittest.mock import patch

import redis
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.experiments.event_delivery import EventRelay, dispatch_outbox_batch
from apps.experiments.models import OutboxMessage
from apps.experiments.services import create_experiment


class FakeStreamClient:
    """记录 XADD 或注入 Redis 失败。"""

    def __init__(self, error: redis.RedisError | None = None) -> None:
        self.error = error
        self.entries: list[tuple[str, dict[str, str]]] = []

    def xadd(self, stream: str, fields: dict[str, str]) -> str:
        if self.error is not None:
            raise self.error
        self.entries.append((stream, fields))
        return "1-0"


class OutboxDispatchTests(TestCase):
    """验证数据库事件在 Redis 成功前不会标为已发布。"""

    def setUp(self) -> None:
        """创建一个自带 experiment.created 事件的实验。"""
        user = get_user_model().objects.create_user(username="outbox-owner")
        self.experiment = create_experiment(user, "Outbox Test")
        self.message = OutboxMessage.objects.get(event__experiment=self.experiment)

    def test_successful_xadd_marks_outbox_published(self) -> None:
        fake_redis = FakeStreamClient()
        with patch("apps.experiments.event_delivery.stream_client", return_value=fake_redis):
            dispatched = dispatch_outbox_batch(experiment_id=self.experiment.id)
        self.message.refresh_from_db()
        assert dispatched == 1
        assert self.message.published_at is not None
        assert self.message.attempts == 1
        assert len(fake_redis.entries) == 1
        payload = json.loads(fake_redis.entries[0][1]["payload"])
        assert payload["experiment_id"] == str(self.experiment.id)
        assert payload["seq"] == 1

    def test_failed_xadd_remains_pending_and_counts_attempt(self) -> None:
        fake_redis = FakeStreamClient(redis.ConnectionError("offline"))
        with (
            patch("apps.experiments.event_delivery.stream_client", return_value=fake_redis),
            self.assertRaises(redis.ConnectionError),
        ):
            dispatch_outbox_batch(experiment_id=self.experiment.id)
        self.message.refresh_from_db()
        assert self.message.published_at is None
        assert self.message.attempts == 1


class FakeRelayRedis:
    """提供一条新 Stream 消息并记录 ACK。"""

    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.read_count = 0
        self.acked: list[str] = []

    def xgroup_create(self, *args: object, **kwargs: object) -> None:
        return None

    def xreadgroup(self, *args: object, **kwargs: object) -> list[tuple[str, object]]:
        self.read_count += 1
        if self.read_count == 1:
            return []
        fields = {
            "event_id": "event-1",
            "experiment_id": str(self.payload["experiment_id"]),
            "seq": str(self.payload["seq"]),
            "payload": json.dumps(self.payload),
        }
        return [("simlab:events:v1", [("1-0", fields)])]

    def xack(self, stream: str, group: str, stream_id: str) -> None:
        self.acked.append(stream_id)


class FakeChannelLayer:
    """记录 relay 的异步 group_send。"""

    def __init__(self) -> None:
        self.messages: list[tuple[str, dict[str, object]]] = []

    async def group_send(self, group: str, message: dict[str, object]) -> None:
        self.messages.append((group, message))


class EventRelayTests(SimpleTestCase):
    """验证成功组播后才 ACK Stream。"""

    def test_relay_sends_persisted_event_then_acks(self) -> None:
        payload = {
            "schema_version": "1.0",
            "experiment_id": "a9366f63-c1d0-46df-ac67-d854adb25a73",
            "seq": 7,
            "generation": 1,
            "type": "command.succeeded",
            "command_id": None,
            "payload": {},
            "occurred_at": "2026-10-04T00:00:00+00:00",
        }
        fake_redis = FakeRelayRedis(payload)
        fake_layer = FakeChannelLayer()
        with (
            patch("apps.experiments.event_delivery.stream_client", return_value=fake_redis),
            patch("apps.experiments.event_delivery.get_channel_layer", return_value=fake_layer),
        ):
            result = EventRelay("test-consumer").relay_once(block_ms=0)
        assert result.delivered == 1
        assert fake_redis.acked == ["1-0"]
        assert fake_layer.messages == [
            (
                f"experiment.{payload['experiment_id']}",
                {"type": "experiment.event", "payload": payload},
            )
        ]
