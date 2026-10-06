# -*- coding: utf-8 -*-
"""带来源标记的对数距离路径损耗模型。"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class RadioObservation:
    """模型派生的 RSSI 结果。"""

    rssi_dbm: float
    reachable: bool
    source: str = "derived"
    model: str = "log_distance"


def calculate_rssi(
    *,
    transmit_dbm: float,
    distance_m: float,
    reference_loss_db: float,
    path_loss_exponent: float,
    receiver_sensitivity_dbm: float,
) -> RadioObservation:
    """计算大于等于一米距离的确定性 RSSI。"""
    if distance_m <= 0 or path_loss_exponent <= 0:
        raise ValueError("距离与路径损耗指数必须大于零")
    effective_distance = max(distance_m, 1.0)
    rssi_dbm = (
        transmit_dbm
        - reference_loss_db
        - 10 * path_loss_exponent * math.log10(effective_distance)
    )
    return RadioObservation(
        rssi_dbm=rssi_dbm, reachable=rssi_dbm >= receiver_sensitivity_dbm
    )
