# -*- coding: utf-8 -*-
"""严格标为开发用途的内存 Runtime。"""

from __future__ import annotations

from uuid import UUID

from runtime.contracts import RuntimeObservation, RuntimePowerState


class DevelopmentMockRuntime:
    """用于领域测试，不提供真实通信声明。"""

    def __init__(self) -> None:
        self._states: dict[tuple[UUID, int], RuntimePowerState] = {}

    def _observation(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        return RuntimeObservation(
            unit_id=unit_id,
            generation=generation,
            power_state=self._states.get((unit_id, generation), RuntimePowerState.UNKNOWN),
            source="configured",
            quality="development_mock",
        )

    def ensure_defined(
        self, unit_id: UUID, generation: int, spec: dict[str, object]
    ) -> RuntimeObservation:
        """定义一个停止状态的模拟单元。"""
        self._states.setdefault((unit_id, generation), RuntimePowerState.STOPPED)
        return self._observation(unit_id, generation)

    def start(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """设置模拟运行状态。"""
        self._states[(unit_id, generation)] = RuntimePowerState.RUNNING
        return self._observation(unit_id, generation)

    def shutdown(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """设置模拟停止状态。"""
        self._states[(unit_id, generation)] = RuntimePowerState.STOPPED
        return self._observation(unit_id, generation)

    def force_off(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """设置模拟断电状态。"""
        return self.shutdown(unit_id, generation)

    def observe(self, unit_id: UUID, generation: int) -> RuntimeObservation:
        """读取模拟状态。"""
        return self._observation(unit_id, generation)
