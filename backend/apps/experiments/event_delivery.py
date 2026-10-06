# -*- coding: utf-8 -*-
"""持久事件序列化、Outbox 到 Redis Streams 与 Channels relay。"""

from __future__ import annotations

import json
import logging
import os
import socket
from dataclasses import dataclass
from uuid import UUID

import redis
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.db import connection, models, transaction
from django.utils import timezone

from apps.experiments.models import ExperimentEvent, OutboxMessage

LOGGER = logging.getLogger(__name__)
DEFAULT_BATCH_SIZE = 100


def event_payload(event: ExperimentEvent) -> dict[str, object]:
    """将权威数据库事件转换为公开 schema。"""
    return {
        "schema_version": "1.0",
        "experiment_id": str(event.experiment_id),
        "seq": event.seq,
        "generation": event.generation,
        "type": event.type,
        "command_id": str(event.command_id) if event.command_id else None,
        "payload": event.payload,
        "occurred_at": event.occurred_at.isoformat(),
    }


def stream_client() -> redis.Redis:
    """创建 decode-responses 模式的事件 Redis 客户端。"""
    return redis.Redis.from_url(settings.EVENT_STREAM_REDIS_URL, decode_responses=True)


def dispatch_outbox_batch(
    *, limit: int = DEFAULT_BATCH_SIZE, experiment_id: UUID | None = None
) -> int:
    """把一批未发布 Outbox 以至少一次语义写入 Redis Stream。"""
    messages = OutboxMessage.objects.filter(published_at__isnull=True)
    if experiment_id is not None:
        messages = messages.filter(event__experiment_id=experiment_id)
    message_ids = list(messages.order_by("created_at").values_list("id", flat=True)[:limit])
    if not message_ids:
        return 0
    redis_client = stream_client()
    dispatched = 0
    for message_id in message_ids:
        try:
            with transaction.atomic():
                lock_options = (
                    {"skip_locked": True}
                    if connection.features.has_select_for_update_skip_locked
                    else {}
                )
                message = (
                    OutboxMessage.objects.select_for_update(**lock_options)
                    .select_related("event")
                    .get(pk=message_id)
                )
                if message.published_at is not None:
                    continue
                payload = event_payload(message.event)
                redis_client.xadd(
                    settings.EVENT_STREAM_KEY,
                    {
                        "event_id": str(message.event_id),
                        "experiment_id": str(message.event.experiment_id),
                        "seq": str(message.event.seq),
                        "payload": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    },
                )
                message.published_at = timezone.now()
                message.attempts += 1
                message.save(update_fields=("published_at", "attempts"))
                dispatched += 1
        except redis.RedisError:
            OutboxMessage.objects.filter(pk=message_id).update(attempts=models.F("attempts") + 1)
            raise
    return dispatched


@dataclass(frozen=True)
class RelayResult:
    """一次 relay 轮询结果。"""

    delivered: int
    stream_entries: tuple[str, ...]


class EventRelay:
    """从 Redis consumer group 转发事件到 Channels。"""

    def __init__(self, consumer_name: str | None = None) -> None:
        self._redis = stream_client()
        self._stream = settings.EVENT_STREAM_KEY
        self._group = settings.EVENT_STREAM_GROUP
        self._consumer = consumer_name or f"{socket.gethostname()}-{os.getpid()}"
        self._channel_layer = get_channel_layer()

    def ensure_group(self) -> None:
        """幂等创建 consumer group，并从现有 stream 起点消费。"""
        try:
            self._redis.xgroup_create(self._stream, self._group, id="0-0", mkstream=True)
        except redis.ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    def _deliver_entries(self, entries: list[tuple[str, dict[str, str]]]) -> RelayResult:
        """验证、组播并在成功后 ACK。"""
        delivered_ids: list[str] = []
        for stream_id, fields in entries:
            try:
                payload = json.loads(fields["payload"])
                experiment_id = str(payload["experiment_id"])
                if (
                    payload.get("schema_version") != "1.0"
                    or str(payload.get("seq")) != fields.get("seq")
                    or experiment_id != fields.get("experiment_id")
                ):
                    raise ValueError("stream envelope mismatch")
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                LOGGER.exception("invalid event stream entry: stream_id=%s", stream_id)
                self._redis.xack(self._stream, self._group, stream_id)
                continue
            async_to_sync(self._channel_layer.group_send)(
                f"experiment.{experiment_id}",
                {"type": "experiment.event", "payload": payload},
            )
            self._redis.xack(self._stream, self._group, stream_id)
            delivered_ids.append(stream_id)
        return RelayResult(len(delivered_ids), tuple(delivered_ids))

    def relay_once(self, *, count: int = DEFAULT_BATCH_SIZE, block_ms: int = 1000) -> RelayResult:
        """先恢复本 consumer 的 pending，再读取新消息。"""
        self.ensure_group()
        pending = self._redis.xreadgroup(
            self._group,
            self._consumer,
            {self._stream: "0"},
            count=count,
        )
        if pending and pending[0][1]:
            return self._deliver_entries(pending[0][1])
        messages = self._redis.xreadgroup(
            self._group,
            self._consumer,
            {self._stream: ">"},
            count=count,
            block=block_ms,
        )
        if not messages:
            return RelayResult(0, ())
        return self._deliver_entries(messages[0][1])
