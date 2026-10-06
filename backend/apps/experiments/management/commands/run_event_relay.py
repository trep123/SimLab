# -*- coding: utf-8 -*-
"""持续把 Redis Stream 事件转发到 Channels。"""

from __future__ import annotations

import time

import redis
from django.core.management.base import BaseCommand, CommandError

from apps.experiments.event_delivery import EventRelay


class Command(BaseCommand):
    """运行 Redis consumer group 到 Channels 的至少一次 relay。"""

    help = "持续转发事件；使用 --once 执行一次轮询"

    def add_arguments(self, parser: object) -> None:
        """登记 consumer 与轮询参数。"""
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--consumer", default=None)
        parser.add_argument("--batch-size", type=int, default=100)
        parser.add_argument("--block-ms", type=int, default=1_000)

    def handle(self, *args: object, **options: object) -> None:
        """转发一批或持续运行。"""
        relay = EventRelay(options["consumer"])
        batch_size = int(options["batch_size"])
        if not 1 <= batch_size <= 1_000:
            raise CommandError("batch-size 必须为 1 到 1000")
        while True:
            try:
                result = relay.relay_once(count=batch_size, block_ms=int(options["block_ms"]))
            except redis.RedisError as error:
                raise CommandError(f"Redis Event Relay 失败：{error}") from error
            if options["once"]:
                self.stdout.write(str(result.delivered))
                return
            if result.delivered == 0:
                time.sleep(0.05)
