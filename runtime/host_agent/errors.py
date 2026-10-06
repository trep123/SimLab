# -*- coding: utf-8 -*-
"""Host Agent 的稳定错误类型。"""

from __future__ import annotations


class HostAgentError(Exception):
    """可安全返回给控制平面的 Host Agent 错误。"""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)

    def as_dict(self) -> dict[str, object]:
        """生成不包含宿主机堆栈的错误响应。"""
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
