# -*- coding: utf-8 -*-
"""Host Agent 的持久幂等操作日志。"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from runtime.host_agent.errors import HostAgentError


@dataclass(frozen=True)
class JournalDecision:
    """一次操作登记的处理决定。"""

    should_execute: bool
    response: dict[str, object] | None


class OperationJournal:
    """使用 SQLite 保证 operation_id 的持久防重。"""

    def __init__(self, path: Path) -> None:
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS operation_journal (
                        operation_id TEXT PRIMARY KEY,
                        request_hash TEXT NOT NULL,
                        action TEXT NOT NULL,
                        status TEXT NOT NULL,
                        response_json TEXT,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )

    def begin(self, operation_id: UUID, request_hash: str, action: str) -> JournalDecision:
        """登记新操作，或返回已经完成的相同操作。"""
        with closing(self._connect()) as connection:
            with connection:
                row = connection.execute(
                    "SELECT request_hash, status, response_json FROM operation_journal "
                    "WHERE operation_id = ?",
                    (str(operation_id),),
                ).fetchone()
                if row is None:
                    connection.execute(
                        "INSERT INTO operation_journal "
                        "(operation_id, request_hash, action, status) VALUES (?, ?, ?, 'RUNNING')",
                        (str(operation_id), request_hash, action),
                    )
                    return JournalDecision(True, None)
                stored_hash, status, response_json = row
                if stored_hash != request_hash:
                    raise HostAgentError("OPERATION_ID_REUSED", "operation_id 已用于不同请求")
                if status == "COMPLETED" and response_json:
                    response = json.loads(response_json)
                    if not isinstance(response, dict):
                        raise HostAgentError("JOURNAL_CORRUPT", "操作日志响应格式损坏")
                    return JournalDecision(False, response)
                return JournalDecision(True, None)

    def complete(self, operation_id: UUID, response: dict[str, object]) -> None:
        """持久保存操作最终响应。"""
        encoded = json.dumps(response, ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "UPDATE operation_journal SET status = 'COMPLETED', response_json = ?, "
                    "updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?",
                    (encoded, str(operation_id)),
                )

    def mark_retryable(self, operation_id: UUID, response: dict[str, object]) -> None:
        """记录可重试错误，但允许相同操作稍后重新核对执行。"""
        encoded = json.dumps(response, ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "UPDATE operation_journal SET status = 'RETRYABLE', response_json = ?, "
                    "updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?",
                    (encoded, str(operation_id)),
                )
