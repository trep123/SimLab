# -*- coding: utf-8 -*-
"""PON 光预算与业务门控纯函数。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class OnuState(str, Enum):
    """简化 ONU 激活阶段。"""

    OFFLINE = "OFFLINE"
    OPTICAL_SYNC = "OPTICAL_SYNC"
    REGISTERED = "REGISTERED"
    AUTHORIZED = "AUTHORIZED"
    SERVICE_READY = "SERVICE_READY"


@dataclass(frozen=True)
class OpticalPath:
    """带明确单位的光路径输入。"""

    transmit_dbm: float
    fiber_length_km: float
    attenuation_db_per_km: float
    splitter_loss_db: float
    connector_loss_db: float
    receiver_min_dbm: float
    receiver_max_dbm: float


@dataclass(frozen=True)
class OpticalObservation:
    """模型计算的接收功率与门控结果。"""

    receive_dbm: float
    margin_db: float
    within_receiver_range: bool
    source: str = "derived"


def calculate_budget(path: OpticalPath) -> OpticalObservation:
    """计算单向简化光预算。"""
    if path.fiber_length_km < 0 or path.attenuation_db_per_km < 0:
        raise ValueError("光纤长度和衰减必须非负")
    receive_dbm = (
        path.transmit_dbm
        - path.fiber_length_km * path.attenuation_db_per_km
        - path.splitter_loss_db
        - path.connector_loss_db
    )
    return OpticalObservation(
        receive_dbm=receive_dbm,
        margin_db=receive_dbm - path.receiver_min_dbm,
        within_receiver_range=path.receiver_min_dbm
        <= receive_dbm
        <= path.receiver_max_dbm,
    )


def business_forwarding_allowed(
    state: OnuState, observation: OpticalObservation
) -> bool:
    """仅在光预算和业务开通都有效时允许转发。"""
    return state is OnuState.SERVICE_READY and observation.within_receiver_range
