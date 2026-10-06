# -*- coding: utf-8 -*-
"""持续把数据库 Outbox 发布到 Redis Streams。"""

from __future__ import annotations

import time
from uuid import UUID

import redis
from django.core.management.base import BaseCommand, CommandError

from apps.experiments.event_delivery import dispatch_outbox_batch


class Command(BaseCommand):
    """可恢复扫描 Outbox，不依赖 Web 请求的 on_commit 回调。"""

    help = "持续发布未发送的 Outbox；使用 --once 执行单批"

    def add_arguments(self, parser: object) -> None:
        """登记批量和轮询参数。"""
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--batch-size", type=int, default=100)
        parser.add_argument("--poll-seconds", type=float, default=0.5)
        parser.add_argument("--experiment-id", default=None)

    def handle(self, *args: object, **options: object) -> None:
        """发布一批或进入受进程管理器监督的循环。"""
        batch_size = int(options["batch_size"])
        if not 1 <= batch_size <= 1_000:
            raise CommandError("batch-size 必须为 1 到 1000")
        try:
            experiment_id = (
                UUID(str(options["experiment_id"])) if options["experiment_id"] else None
            )
        except ValueError as error:
            raise CommandError("experiment-id 必须是 UUID") from error
        while True:
            try:
                dispatched = dispatch_outbox_batch(limit=batch_size, experiment_id=experiment_id)
            except redis.RedisError as error:
                raise CommandError(f"Redis Stream 发布失败：{error}") from error
            if options["once"]:
                self.stdout.write(str(dispatched))
                return
            if dispatched == 0:
                time.sleep(float(options["poll_seconds"]))
