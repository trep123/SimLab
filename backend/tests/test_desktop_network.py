# -*- coding: utf-8 -*-
"""前端实体网口到真实 VM 网段的拓扑编译测试。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.test import override_settings

from apps.experiments.desktop_network import network_plan, sync_experiment_network
from apps.experiments.services import SimlabError, _validate_experiment_document


def _instance(device_id: str, key: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(), frontend_device_id=device_id,
        desired_json={"nic_aliases": ["eth0"], "frontend_port_keys": [key]},
        observed_json={"power_state": "RUNNING"}, compatible_device_types=["pc"],
    )


def test_visual_wireless_association_does_not_wire_guest_to_ap_uplink() -> None:
    """浏览器中的关联不会绕过尚未实现的无线真实报文边界。"""
    experiment = SimpleNamespace(id=uuid.uuid4())
    laptop = _instance("laptop-1", "ETH0/0/1")
    document = {
        "devices": [
            {"device_id": "laptop-1", "device_type": "laptop"},
            {"device_id": "ap-1", "device_type": "ap"},
            {"device_id": "pc-1", "device_type": "pc"},
        ],
        "cables": [{
            "cable_type": "ETHERNET_COPPER",
            "source": {"device_id": "ap-1", "port": "GE0/0/1"},
            "target": {"device_id": "pc-1", "port": "eth0"},
        }],
        "wireless_associations": [{
            "sta_device_id": "laptop-1", "ap_device_id": "ap-1",
        }],
    }
    plan = network_plan(experiment, document, [laptop, _instance("pc-1", "eth0")])
    assert plan[(laptop.id, "eth0")][1] is False


def test_radio_virtual_nic_joins_ap_lan_without_rewiring_laptop_rj45() -> None:
    """独立 eth1 承载无线关联，AP 上联桥接真实有线 LAN。"""
    experiment = SimpleNamespace(id=uuid.uuid4())
    laptop = SimpleNamespace(
        id=uuid.uuid4(), frontend_device_id="laptop-1",
        desired_json={"nic_aliases": ["eth0", "eth1"],
                      "frontend_port_keys": ["ETH0/0/1", "RADIO0"]},
        observed_json={"power_state": "RUNNING"}, compatible_device_types=["laptop"],
    )
    peer = _instance("pc-1", "eth0")
    document = {
        "devices": [
            {"device_id": "laptop-1", "device_type": "laptop",
             "ports": [{"short_name": "ETH0/0/1"}]},
            {"device_id": "ap-1", "device_type": "ap", "power_on": True,
             "ports": [{"short_name": "GE0/0/1"}, {"short_name": "CON0/0/1"}]},
            {"device_id": "pc-1", "device_type": "pc"},
        ],
        "cables": [{"cable_type": "ETHERNET_COPPER",
                    "source": {"device_id": "ap-1", "port": "GE0/0/1"},
                    "target": {"device_id": "pc-1", "port": "eth0"}}],
        "wireless_associations": [{
            "sta_device_id": "laptop-1", "ap_device_id": "ap-1",
        }],
    }
    plan = network_plan(experiment, document, [laptop, peer])
    assert plan[(laptop.id, "eth1")] == plan[(peer.id, "eth0")]
    assert plan[(laptop.id, "eth0")][1] is False
    document["devices"][1]["power_on"] = False
    plan = network_plan(experiment, document, [laptop, peer])
    assert plan[(laptop.id, "eth1")][1] is False
    document["devices"][1]["power_on"] = True
    document["wireless_associations"] = []
    plan = network_plan(experiment, document, [laptop, peer])
    assert plan[(laptop.id, "eth1")][1] is False


def test_radio_link_rejects_one_nic_laptop() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    document = {
        "devices": [
            {"device_id": "laptop-1", "device_type": "laptop"},
            {"device_id": "ap-1", "device_type": "ap", "power_on": True,
             "ports": [{"short_name": "GE0/0/1"}]},
        ],
        "cables": [],
        "wireless_associations": [
            {"sta_device_id": "laptop-1", "ap_device_id": "ap-1"},
        ],
    }
    with pytest.raises(SimlabError, match="WIRELESS_NIC_MISSING|缺少独立射频"):
        network_plan(experiment, document, [_instance("laptop-1", "ETH0/0/1")])


def test_saved_wireless_association_requires_existing_ap_and_unique_client() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    document = {
        "schema_version": "1.0", "experiment_id": str(experiment.id),
        "name": "无线实验", "scene": {}, "cables": [],
        "devices": [
            {"device_id": "laptop-1", "device_type": "laptop"},
            {"device_id": "ap-1", "device_type": "ap"},
        ],
        "wireless_associations": [{
            "sta_device_id": "laptop-1", "ap_device_id": "ap-1",
        }],
    }
    assert _validate_experiment_document(experiment, document) is document
    document["wireless_associations"].append(document["wireless_associations"][0])
    with pytest.raises(SimlabError, match="唯一客户端"):
        _validate_experiment_document(experiment, document)


def test_ap_radio_document_rejects_invalid_channel_and_power() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    document = {
        "schema_version": "1.0", "experiment_id": str(experiment.id),
        "name": "AP 实验", "scene": {}, "cables": [],
        "devices": [{"device_id": "ap-1", "device_type": "ap", "ap_radio": {
            "ssid": "LAB", "channel": 6, "tx_power_dbm": 20,
        }}],
    }
    assert _validate_experiment_document(experiment, document) is document
    document["devices"][0]["ap_radio"]["channel"] = 13
    with pytest.raises(SimlabError, match="AP 参数无效"):
        _validate_experiment_document(experiment, document)


def test_pc_ports_on_same_switch_vlan_share_real_network() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("pc-a", "LAN1"), _instance("pc-b", "eth0")
    document = {
        "devices": [
            {"device_id": "pc-a", "device_type": "pc"},
            {"device_id": "pc-b", "device_type": "pc"},
            {"device_id": "sw", "device_type": "switch", "ports": [
                {"short_name": "GE1", "vlan": 1}, {"short_name": "GE2", "vlan": 1},
            ]},
        ],
        "cables": [
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-a", "port": "LAN1"},
             "target": {"device_id": "sw", "port": "GE1"}},
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-b", "port": "eth0"},
             "target": {"device_id": "sw", "port": "GE2"}},
        ],
    }
    plan = network_plan(experiment, document, [first, second])
    assert plan[(first.id, "eth0")] == plan[(second.id, "eth0")]
    assert plan[(first.id, "eth0")][1] is True


def test_cloud_downlinks_share_uplink_broadcast_domain() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("pc-a", "eth0"), _instance("pc-b", "eth0")
    cloud_plans: dict[str, uuid.UUID] = {}
    document = {
        "devices": [
            {"device_id": "pc-a", "device_type": "pc"},
            {"device_id": "pc-b", "device_type": "pc"},
            {"device_id": "cloud", "model_id": "generic-cloud-bridge",
             "device_type": "cloud", "cloud_uplink": "br-lab"},
        ],
        "cables": [
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-a", "port": "eth0"},
             "target": {"device_id": "cloud", "port": "eth0"}},
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-b", "port": "eth0"},
             "target": {"device_id": "cloud", "port": "eth1"}},
        ],
    }
    plan = network_plan(experiment, document, [first, second], cloud_plans)
    assert plan[(first.id, "eth0")] == plan[(second.id, "eth0")]
    assert plan[(first.id, "eth0")][0] == cloud_plans["cloud"]
    assert plan[(first.id, "eth0")][1] is True
    document["devices"][2]["cloud_uplink"] = ""
    document["cables"].pop()
    plan = network_plan(experiment, document, [first, second], cloud_plans)
    assert plan[(first.id, "eth0")][1] is False


@override_settings(RUNTIME_MODE="runtime_real", CLOUD_UPLINK_BRIDGES=("br-lab",))
def test_cloud_save_and_delete_wire_only_approved_bridge() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4(), document_json={})
    cloud = {"device_id": "cloud-1", "model_id": "generic-cloud-bridge",
             "device_type": "cloud", "cloud_uplink": "br-lab"}
    document = {"devices": [cloud], "cables": [{
        "cable_type": "ETHERNET_COPPER",
        "source": {"device_id": "cloud-1", "port": "eth0"},
        "target": {"device_id": "pc", "port": "eth0"},
    }]}
    calls: list[tuple[str, bool]] = []

    class FakeClient:
        def wire_cloud(self, _operation: object, _experiment: object, _cloud: object,
                       _network: object, bridge: str, *, up: bool) -> dict[str, str]:
            calls.append((bridge, up))
            return {"status": "WIRED" if up else "DISCONNECTED"}

    with patch(
        "apps.experiments.desktop_network.VirtualRuntimeInstance.objects.filter", return_value=[]
    ), patch("apps.experiments.desktop_runtime._runtime_client", return_value=FakeClient()):
        sync_experiment_network(experiment, document, uuid.uuid4())
        experiment.document_json = document
        sync_experiment_network(experiment, {"devices": [], "cables": []}, uuid.uuid4())
        with pytest.raises(SimlabError, match="未获批准"):
            sync_experiment_network(experiment, {
                "devices": [{**cloud, "cloud_uplink": "br-management"}], "cables": []
            }, uuid.uuid4())
    assert calls == [("br-lab", True), ("", False)]


def test_unplug_and_vlan_split_isolate_real_interfaces() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("pc-a", "eth0"), _instance("pc-b", "eth0")
    document = {
        "devices": [{"device_id": "sw", "device_type": "switch", "ports": [
            {"short_name": "GE1", "vlan": 1}, {"short_name": "GE2", "vlan": 2},
        ]}],
        "cables": [
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-a", "port": "eth0"},
             "target": {"device_id": "sw", "port": "GE1"}},
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-b", "port": "eth0"},
             "target": {"device_id": "sw", "port": "GE2"}},
        ],
    }
    plan = network_plan(experiment, document, [first, second])
    assert plan[(first.id, "eth0")][1]
    assert plan[(second.id, "eth0")][1]
    assert plan[(first.id, "eth0")][0] != plan[(second.id, "eth0")][0]
    document["cables"].clear()
    plan = network_plan(experiment, document, [first, second])
    assert not plan[(first.id, "eth0")][1]
    assert not plan[(second.id, "eth0")][1]


def test_two_frontend_module_ports_map_to_two_different_vm_nics() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    pc = SimpleNamespace(
        id=uuid.uuid4(), frontend_device_id="pc-a",
        desired_json={"nic_aliases": ["eth0", "eth1"],
                      "frontend_port_keys": ["LAN-A", "LAN-B"]},
        observed_json={"power_state": "RUNNING"}, compatible_device_types=["pc"],
    )
    document = {
        "devices": [
            {"device_id": "sw-a", "device_type": "switch", "ports": []},
            {"device_id": "sw-b", "device_type": "switch", "ports": []},
        ],
        "cables": [
            {"cable_type": "ETHERNET_COPPER",
             "source": {"device_id": "pc-a", "port": "LAN-A"},
             "target": {"device_id": "sw-a", "port": "GE1"}},
            {"cable_type": "ETHERNET_COPPER",
             "source": {"device_id": "pc-a", "port": "LAN-B"},
             "target": {"device_id": "sw-b", "port": "GE1"}},
        ],
    }
    plan = network_plan(experiment, document, [pc])
    assert plan[(pc.id, "eth0")][1]
    assert plan[(pc.id, "eth1")][1]
    assert plan[(pc.id, "eth0")][0] != plan[(pc.id, "eth1")][0]


def test_removed_frontend_socket_cannot_keep_vm_nic_wired() -> None:
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("pc-a", "LAN1"), _instance("pc-b", "eth0")
    document = {
        "devices": [
            {"device_id": "pc-a", "device_type": "pc", "ports": [{"short_name": "LAN2"}]},
            {"device_id": "pc-b", "device_type": "pc", "ports": [{"short_name": "eth0"}]},
        ],
        "cables": [{"cable_type": "ETHERNET_COPPER",
                    "source": {"device_id": "pc-a", "port": "LAN1"},
                    "target": {"device_id": "pc-b", "port": "eth0"}}],
    }
    plan = network_plan(experiment, document, [first, second])
    assert not plan[(first.id, "eth0")][1]
    assert not plan[(second.id, "eth0")][1]


def test_bound_switch_ports_are_separate_guest_interfaces() -> None:
    """真实交换机必须通过客体转发；控制平面不能把两个端口短接。"""
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("pc-a", "eth0"), _instance("pc-b", "eth0")
    switch = SimpleNamespace(
        id=uuid.uuid4(), frontend_device_id="sw",
        desired_json={"nic_aliases": ["eth0", "eth1"],
                      "frontend_port_keys": ["GE1", "GE2"]},
        observed_json={"power_state": "RUNNING"},
        compatible_device_types=["switch", "l3switch"],
    )
    document = {
        "devices": [
            {"device_id": "pc-a", "device_type": "pc"},
            {"device_id": "pc-b", "device_type": "pc"},
            {"device_id": "sw", "device_type": "switch", "ports": [
                {"short_name": "GE1", "vlan": 1}, {"short_name": "GE2", "vlan": 1},
            ]},
        ],
        "cables": [
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-a", "port": "eth0"},
             "target": {"device_id": "sw", "port": "GE1"}},
            {"cable_type": "ETHERNET_COPPER", "source": {"device_id": "pc-b", "port": "eth0"},
             "target": {"device_id": "sw", "port": "GE2"}},
        ],
    }
    plan = network_plan(experiment, document, [first, second, switch])
    assert plan[(first.id, "eth0")] == plan[(switch.id, "eth0")]
    assert plan[(second.id, "eth0")] == plan[(switch.id, "eth1")]
    assert plan[(first.id, "eth0")][0] != plan[(second.id, "eth0")][0]
    switch.observed_json["power_state"] = "STOPPED"
    plan = network_plan(experiment, document, [first, second, switch])
    assert not plan[(first.id, "eth0")][1]
    assert not plan[(second.id, "eth0")][1]


def test_sfp_ethernet_fiber_is_wired_but_gpon_fiber_is_not() -> None:
    """SFP 承载以太网；PON 光纤仍由独立协议处理。"""
    experiment = SimpleNamespace(id=uuid.uuid4())
    first, second = _instance("sw-a", "SFP1"), _instance("sw-b", "SFP1")
    for instance in (first, second):
        instance.compatible_device_types = ["switch"]
    document = {
        "devices": [
            {"device_id": "sw-a", "device_type": "switch"},
            {"device_id": "sw-b", "device_type": "switch"},
            {"device_id": "onu", "device_type": "onu"},
        ],
        "cables": [{"cable_type": "OPTICAL_FIBER",
                    "source": {"device_id": "sw-a", "port": "SFP1"},
                    "target": {"device_id": "sw-b", "port": "SFP1"}}],
    }
    plan = network_plan(experiment, document, [first, second])
    assert plan[(first.id, "eth0")] == plan[(second.id, "eth0")]
    document["cables"] = [{"cable_type": "OPTICAL_FIBER",
                           "source": {"device_id": "sw-a", "port": "SFP1"},
                           "target": {"device_id": "onu", "port": "PON1"}}]
    plan = network_plan(experiment, document, [first, second])
    assert not plan[(first.id, "eth0")][1]
