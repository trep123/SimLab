# -*- coding: utf-8 -*-
"""Host Agent 协议、白名单和 journal 防重测试。"""

from __future__ import annotations

import json
import uuid
import xml.etree.ElementTree as element_tree

import pytest

from runtime.host_agent.errors import HostAgentError
from runtime.host_agent.journal import OperationJournal
from runtime.host_agent.policy import bridge_name, domain_name, tap_name
from runtime.host_agent.protocol import HostAction, parse_request, success_response
from runtime.host_agent.port_identity import find_port_interface


def encoded_request(**overrides: object) -> bytes:
    """生成一条可按字段覆盖的合法定义请求。"""
    request: dict[str, object] = {
        "schema_version": "1.0",
        "operation_id": str(uuid.uuid4()),
        "action": "ENSURE_DEFINED",
        "experiment_id": str(uuid.uuid4()),
        "unit_id": str(uuid.uuid4()),
        "generation": 1,
        "payload": {
            "profile_release_id": "linux-cloud-profile-v1",
            "memory_mib": 1024,
            "vcpu_count": 1,
            "disk_gib": 8,
            "ipv4_address": "10.88.0.10",
            "hostname": "simlab-test",
            "link_up": False,
            "nic_model": "virtio",
            "gpu_model": "virtio",
        },
    }
    request.update(overrides)
    return json.dumps(request).encode()


def test_resource_names_are_deterministic_and_kernel_safe() -> None:
    """资源名必须由 UUID 推导且符合接口长度上限。"""
    resource_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    assert bridge_name(resource_id) == "slb123456781234"
    assert tap_name(resource_id) == "slt123456781234"
    assert tap_name(resource_id, 1) == "sln123456781201"
    collision_id = uuid.UUID("12345678-1201-5678-1234-567812345678")
    assert tap_name(collision_id) != tap_name(collision_id, 1)
    assert len(bridge_name(resource_id)) == 15
    assert domain_name(resource_id, 3) == "simlab-123456781234-g3"


def test_cloud_wire_accepts_only_structured_bridge_request() -> None:
    payload = {"cloud_id": str(uuid.uuid4()), "network_id": str(uuid.uuid4()),
               "uplink_bridge": "br-lab", "up": True}
    parsed = parse_request(encoded_request(
        action="CLOUD_WIRE", unit_id=None, generation=None, payload=payload,
    ))
    assert parsed.action is HostAction.CLOUD_WIRE
    for bad_bridge in ("--help", "br-lab;ip", "a" * 16):
        with pytest.raises(HostAgentError):
            parse_request(encoded_request(
                action="CLOUD_WIRE", unit_id=None, generation=None,
                payload={**payload, "uplink_bridge": bad_bridge},
            ))
    with pytest.raises(HostAgentError):
        parse_request(encoded_request(
            action="CLOUD_WIRE", unit_id=None, generation=None,
            payload={**payload, "host_path": "/etc/shadow"},
        ))


def test_protocol_rejects_unknown_fields_and_host_injection() -> None:
    """请求不能提交宿主路径、额外 argv 或 cloud-init 注入。"""
    with pytest.raises(HostAgentError, match="未知字段"):
        parse_request(encoded_request(host_path="/etc/shadow"))
    payload = json.loads(encoded_request())["payload"]
    payload["hostname"] = "safe\nruncmd: [touch, /tmp/owned]"
    with pytest.raises(HostAgentError, match="hostname"):
        parse_request(encoded_request(payload=payload))


def test_protocol_accepts_only_profile_network_and_port_allowlist() -> None:
    """Profile、地址和端口必须在节点白名单内。"""
    parsed = parse_request(encoded_request())
    assert parsed.action is HostAction.ENSURE_DEFINED
    payload = json.loads(encoded_request())["payload"]
    payload["ipv4_address"] = "192.168.1.10"
    with pytest.raises(HostAgentError, match="受控实验网段"):
        parse_request(encoded_request(payload=payload))
    with pytest.raises(HostAgentError, match="未由当前 Runtime Profile 声明"):
        parse_request(
            encoded_request(
                action="SET_LINK", payload={"port_alias": "eth99", "up": True}
            )
        )
    attach = parse_request(encoded_request(action="CONSOLE_ATTACH", payload={}))
    assert attach.action is HostAction.CONSOLE_ATTACH
    with pytest.raises(HostAgentError, match="domain_name"):
        parse_request(encoded_request(
            action="CONSOLE_ATTACH", payload={"domain_name": "../outside"}
        ))


def test_radio_nic_requires_a_separate_desktop_interface() -> None:
    payload = json.loads(encoded_request())["payload"]
    payload["nic_aliases"] = ["eth0", "eth1"]
    payload["radio_nic_alias"] = "eth1"
    assert parse_request(encoded_request(payload=payload)).payload["radio_nic_alias"] == "eth1"
    payload["radio_nic_alias"] = "eth0"
    with pytest.raises(HostAgentError, match="射频虚拟网卡"):
        parse_request(encoded_request(payload=payload))


def test_appliance_profile_accepts_26_ports_and_rejects_role_mismatch() -> None:
    """网络设备允许多网卡，角色仍由批准的 Profile 固定。"""
    payload = json.loads(encoded_request())["payload"]
    payload.update({
        "profile_release_id": "linux-switch-profile-v1",
        "appliance_role": "switch",
        "nic_aliases": [f"eth{index}" for index in range(26)],
    })
    assert len(parse_request(encoded_request(payload=payload)).payload["nic_aliases"]) == 26
    payload["image_release"] = "uploaded-" + "a" * 64
    assert parse_request(encoded_request(payload=payload)).payload["image_release"] == payload["image_release"]
    payload["image_release"] = "uploaded-../../etc/passwd"
    with pytest.raises(HostAgentError, match="镜像"):
        parse_request(encoded_request(payload=payload))
    payload["image_release"] = "ubuntu-noble-20260725"
    payload["appliance_role"] = "router"
    with pytest.raises(HostAgentError, match="角色"):
        parse_request(encoded_request(payload=payload))


def test_external_domain_action_accepts_only_a_safe_exact_name() -> None:
    """外部 domain 协议只携带受限名称，禁止注入额外宿主参数。"""
    parsed = parse_request(
        encoded_request(
            action="BIND_EXTERNAL", payload={"domain_name": "simlab-g0-pc1"}
        )
    )
    assert parsed.action is HostAction.BIND_EXTERNAL
    assert parsed.payload == {"domain_name": "simlab-g0-pc1"}
    with pytest.raises(HostAgentError, match="domain_name"):
        parse_request(encoded_request(
            action="BIND_EXTERNAL",
            payload={"domain_name": "simlab-g0-pc1; virsh destroy victim"},
        ))
    with pytest.raises(HostAgentError, match="仅接受"):
        parse_request(encoded_request(
            action="BIND_EXTERNAL",
            payload={"domain_name": "simlab-g0-pc1", "socket": "/run/libvirt.sock"},
        ))


def test_wire_port_requires_valid_network_and_declared_nic() -> None:
    network_id = str(uuid.uuid4())
    parsed = parse_request(encoded_request(
        action="WIRE_PORT", payload={"port_alias": "eth0", "network_id": network_id, "up": True}
    ))
    assert parsed.action is HostAction.WIRE_PORT
    with pytest.raises(HostAgentError):
        parse_request(encoded_request(
            action="WIRE_PORT", payload={"port_alias": "eth99", "network_id": network_id, "up": True}
        ))
    with pytest.raises(HostAgentError):
        parse_request(encoded_request(
            action="WIRE_PORT", payload={"port_alias": "eth0", "network_id": "../etc", "up": True}
        ))


def test_managed_eth0_uses_stable_mac_and_tap_when_libvirt_alias_is_net0() -> None:
    mac = "52:54:74:3d:73:1a"
    tap = "slt54d1cb155ae2"
    root = element_tree.fromstring(
        "<domain><devices><interface>"
        f"<mac address='{mac}'/>"
        f"<target dev='{tap}'/>"
        "<alias name='net0'/></interface></devices></domain>"
    )
    assert find_port_interface(
        root, "eth0", external=False, expected_mac=mac, expected_tap=tap
    ) is not None
    root.find("./devices/interface/mac").set("address", "52:54:00:00:00:00")
    with pytest.raises(HostAgentError, match="MAC/TAP"):
        find_port_interface(
            root, "eth0", external=False, expected_mac=mac, expected_tap=tap
        )


def test_appliance_eth27_can_be_isolated_and_eth32_is_rejected() -> None:
    """网络设备卸载高序号端口时应沿用完整的 32 网卡白名单。"""
    interfaces = "".join(
        f"<interface><mac address='52:54:00:00:00:{index:02x}'/>"
        f"<target dev='sln0123456789{index:02d}'/></interface>"
        for index in range(28)
    )
    root = element_tree.fromstring(f"<domain><devices>{interfaces}</devices></domain>")
    assert find_port_interface(
        root, "eth27", external=False,
        expected_mac="52:54:00:00:00:1b", expected_tap="sln012345678927",
    ) is not None
    with pytest.raises(HostAgentError, match="虚拟网卡别名无效"):
        find_port_interface(root, "eth32", external=True)



def test_journal_reuses_identical_result_and_rejects_changed_request(tmp_path) -> None:
    """相同 operation_id 复用结果，不同请求不得覆盖日志。"""
    journal = OperationJournal(tmp_path / "journal.sqlite3")
    operation_id = uuid.uuid4()
    first = journal.begin(operation_id, "hash-a", "START")
    assert first.should_execute is True
    response = success_response(operation_id, {"power_state": "RUNNING"})
    journal.complete(operation_id, response)
    repeated = journal.begin(operation_id, "hash-a", "START")
    assert repeated.should_execute is False
    assert repeated.response == response
    with pytest.raises(HostAgentError, match="不同请求"):
        journal.begin(operation_id, "hash-b", "FORCE_OFF")


def test_retryable_journal_entry_is_executed_again(tmp_path) -> None:
    """可重试宿主错误不能被永久缓存为最终结果。"""
    journal = OperationJournal(tmp_path / "journal.sqlite3")
    operation_id = uuid.uuid4()
    journal.begin(operation_id, "same-hash", "START")
    journal.mark_retryable(operation_id, {"ok": False})
    decision = journal.begin(operation_id, "same-hash", "START")
    assert decision.should_execute is True
