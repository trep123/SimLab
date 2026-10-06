# -*- coding: utf-8 -*-
"""线路退化配置的安全值对象。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ImpairmentSpec:
    """可编译到双向 tc/netem 的受限参数。"""

    delay_ms: float = 0
    jitter_ms: float = 0
    loss_ratio: float = 0
    rate_bps: int | None = None

    def validate(self) -> None:
        """拒绝负数和超范围丢包率。"""
        if self.delay_ms < 0 or self.jitter_ms < 0:
            raise ValueError("延迟和抖动必须非负")
        if not 0 <= self.loss_ratio <= 1:
            raise ValueError("丢包率必须位于 [0, 1]")
        if self.rate_bps is not None and self.rate_bps <= 0:
            raise ValueError("限速值必须大于零")

    def to_netem_arguments(self) -> tuple[str, ...]:
        """生成不含用户自由文本的 netem argv 片段。"""
        self.validate()
        arguments = ["delay", f"{self.delay_ms:.3f}ms"]
        if self.jitter_ms:
            arguments.append(f"{self.jitter_ms:.3f}ms")
        if self.loss_ratio:
            arguments.extend(("loss", f"{self.loss_ratio * 100:.4f}%"))
        if self.rate_bps is not None:
            arguments.extend(("rate", f"{self.rate_bps}bit"))
        return tuple(arguments)
