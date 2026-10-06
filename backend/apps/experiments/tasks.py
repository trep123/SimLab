# -*- coding: utf-8 -*-
"""命令后台执行任务。"""

from uuid import UUID

from celery import shared_task

from apps.experiments.event_delivery import dispatch_outbox_batch
from apps.experiments.services import execute_command


@shared_task(acks_late=True)
def execute_command_task(command_id: str) -> None:
    """幂等执行已持久化的命令。"""
    execute_command(UUID(command_id))
    dispatch_outbox_batch()


def publish_experiment_outbox(experiment_id: str) -> None:
    """兼容旧调用点；实际通知统一先进入 Redis Stream。"""
    dispatch_outbox_batch(experiment_id=UUID(experiment_id))
