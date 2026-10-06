# -*- coding: utf-8 -*-
"""线路、光预算和无线电纯模型测试。"""

from django.test import SimpleTestCase
from simulator.optical.model import (
    OnuState,
    OpticalPath,
    business_forwarding_allowed,
    calculate_budget,
)
from simulator.radio.model import calculate_rssi


class SimulationModelTests(SimpleTestCase):
    """验证派生值和业务门控边界。"""

    def test_optical_service_requires_budget_and_activation(self) -> None:
        observation = calculate_budget(OpticalPath(3, 10, 0.35, 7.2, 1, -28, -8))
        self.assertTrue(observation.within_receiver_range)
        self.assertFalse(business_forwarding_allowed(OnuState.REGISTERED, observation))
        self.assertTrue(business_forwarding_allowed(OnuState.SERVICE_READY, observation))

    def test_radio_distance_reduces_rssi(self) -> None:
        near = calculate_rssi(
            transmit_dbm=20,
            distance_m=1,
            reference_loss_db=40,
            path_loss_exponent=2.2,
            receiver_sensitivity_dbm=-80,
        )
        far = calculate_rssi(
            transmit_dbm=20,
            distance_m=30,
            reference_loss_db=40,
            path_loss_exponent=2.2,
            receiver_sensitivity_dbm=-80,
        )
        self.assertGreater(near.rssi_dbm, far.rssi_dbm)
