# -*- coding: utf-8 -*-
"""所有 Runtime Adapter 必须满足的最小契约。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol
from uuid import UUID


class RuntimePowerState(str, Enum):
    """运行单元电源状态。"""

    STOPPED = "STOPPED"
    RUNNING = "RUNNING"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class RuntimeObservation:
    """带代次和来源的运行观测。"""

    unit_id: UUID
    generation: int
    power_state: RuntimePowerState
    source: str
    quality: str


class RuntimeProvider(Protocol):
    """VM 或逻辑执行单元的基础生命周期接口。"""

    def ensure_defined(
        self, unit_id: UUID, generation: int, spec: dict[str, object]
    ) -> RuntimeObservation:
        """幂等确保运行单元已定义。"""

    def start(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """启动指定代次的运行单元。"""

    def shutdown(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """请求客体正常关机。"""

    def force_off(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """强制停止运行单元。"""

    def observe(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """读取实际状态。"""


class LinkProvider(Protocol):
    """保留网卡身份的链路控制能力。"""

    def set_link(self, unit_id: UUID, port_alias: str, *, up: bool, generation: int) -> None:
        """改变虚拟载波，不移除网卡。"""
