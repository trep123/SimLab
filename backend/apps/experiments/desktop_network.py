# -*- coding: utf-8 -*-
"""将 Web 网线拓扑编译成受控桌面虚拟机的 OVS 二层连接。"""

from __future__ import annotations

import uuid
from collections import defaultdict

from django.conf import settings

from apps.experiments.models import Experiment, VirtualRuntimeInstance
from apps.experiments.services import SimlabError


def _endpoint(value: object) -> tuple[str, str] | None:
    if not isinstance(value, dict):
        return None
    device, port = value.get("device_id"), value.get("port")
    if not isinstance(device, str) or not isinstance(port, str) or not device or not port:
        return None
    return device, port


def network_plan(
    experiment: Experiment, document: dict[str, object], instances: list[VirtualRuntimeInstance],
    cloud_plans: dict[str, uuid.UUID] | None = None,
) -> dict[tuple[uuid.UUID, str], tuple[uuid.UUID, bool]]:
    """同一交换机 VLAN 内端口构成一个广播域；无真实转发节点时关闭载波。"""
    parent: dict[tuple[str, str], tuple[str, str]] = {}

    def find(item: tuple[str, str]) -> tuple[str, str]:
        parent.setdefault(item, item)
        if parent[item] != item:
            parent[item] = find(parent[item])
        return parent[item]

    def union(left: tuple[str, str], right: tuple[str, str]) -> None:
        parent[find(left)] = find(right)

    device_rows = {
        item.get("device_id"): item
        for item in document.get("devices", [])
        if isinstance(item, dict) and isinstance(item.get("device_id"), str)
    }
    bound_switches = {
        str(instance.frontend_device_id): instance
        for instance in instances
        if instance.frontend_device_id
        and any(kind in instance.compatible_device_types for kind in ("switch", "l3switch"))
    }
    switch_ports: dict[tuple[str, int], list[tuple[str, str]]] = defaultdict(list)
    for cable in document.get("cables", []):
        if not isinstance(cable, dict) or cable.get("cable_type") not in {
            "ETHERNET_COPPER", "OPTICAL_FIBER",
        }:
            continue
        left, right = _endpoint(cable.get("source")), _endpoint(cable.get("target"))
        if not left or not right:
            continue
        if cable["cable_type"] == "OPTICAL_FIBER" and not all(
            device_rows.get(endpoint[0], {}).get("device_type") in {
                "switch", "l3switch", "router", "firewall",
            }
            for endpoint in (left, right)
        ):
            # GPON/ONU 光纤不是以太网 SFP 链路，不能误编译成 QEMU 虚拟网卡。
            continue
        union(left, right)
        for endpoint in (left, right):
            device = device_rows.get(endpoint[0], {})
            if (device.get("device_type") not in {"switch", "l3switch", "cloud"}
                    or endpoint[0] in bound_switches):
                continue
            if device.get("device_type") == "cloud":
                # Cloud 的所有以太网下联口共享一个二层广播域；上联由宿主 patch 接入。
                continue
            port = next(
                (p for p in device.get("ports", []) if isinstance(p, dict)
                 and p.get("short_name") == endpoint[1]), None
            )
            vlan = port.get("vlan", 1) if port else 1
            if isinstance(vlan, int) and not isinstance(vlan, bool):
                switch_ports[(endpoint[0], vlan)].append(endpoint)
    wireless_ap_ids: set[str] = set()
    for association in document.get("wireless_associations", []):
        if not isinstance(association, dict):
            continue
        sta_id = association.get("sta_device_id")
        ap_id = association.get("ap_device_id")
        if not isinstance(sta_id, str) or not isinstance(ap_id, str):
            continue
        ap_row = device_rows.get(ap_id, {})
        if ap_row.get("device_type") != "ap" or not ap_row.get("power_on"):
            continue
        instance = next(
            (item for item in instances if str(item.frontend_device_id) == sta_id), None
        )
        if instance is None:
            continue
        aliases = instance.desired_json.get("nic_aliases") or [
            item.get("port_alias") for item in instance.observed_json.get("interfaces", [])
            if isinstance(item, dict)
        ]
        keys = instance.desired_json.get("frontend_port_keys") or aliases
        if "RADIO0" not in keys:
            raise SimlabError(
                "WIRELESS_NIC_MISSING",
                "笔记本缺少独立射频虚拟网卡 eth1；请换用双网卡实例后重新绑定。",
                status_code=409,
            )
        radio_index = keys.index("RADIO0")
        if radio_index >= len(aliases):
            raise SimlabError(
                "WIRELESS_NIC_MISSING", "射频接口没有对应的虚拟网卡；请刷新资源池后重新绑定。",
                status_code=409,
            )
        uplink = next(
            (port.get("short_name") for port in ap_row.get("ports", [])
             if isinstance(port, dict) and isinstance(port.get("short_name"), str)
             and not port["short_name"].upper().startswith(("CON", "PWR", "POWER"))),
            None,
        )
        if not uplink:
            raise SimlabError(
                "WIRELESS_AP_UPLINK_MISSING", "AP 缺少以太网上联口；请检查模板后重试。",
                status_code=409,
            )
        union((sta_id, "RADIO0"), (ap_id, str(uplink)))
        wireless_ap_ids.add(ap_id)
    for endpoints in switch_ports.values():
        for endpoint in endpoints[1:]:
            union(endpoints[0], endpoint)
    for device_id, device in device_rows.items():
        if device.get("model_id") != "generic-cloud-bridge":
            continue
        endpoints = [item for item in parent if item[0] == device_id]
        for endpoint in endpoints[1:]:
            union(endpoints[0], endpoint)

    members: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    for endpoint in parent:
        members[find(endpoint)].append(endpoint)
    if cloud_plans is not None:
        for device_id, device in device_rows.items():
            if device.get("model_id") != "generic-cloud-bridge":
                continue
            endpoints = [item for item in parent if item[0] == device_id]
            if endpoints:
                component = members[find(endpoints[0])]
                signature = "|".join(sorted(f"{name}:{port}" for name, port in component))
                cloud_plans[device_id] = uuid.uuid5(experiment.id, signature)
    desktop_ports: dict[tuple[str, str], tuple[VirtualRuntimeInstance, str]] = {}
    for instance in instances:
        aliases = instance.desired_json.get("nic_aliases") or [
            item.get("port_alias") for item in instance.observed_json.get("interfaces", [])
            if isinstance(item, dict)
        ]
        keys = instance.desired_json.get("frontend_port_keys") or aliases
        for key, alias in zip(keys, aliases, strict=False):
            desktop_ports[(str(instance.frontend_device_id), str(key))] = (instance, str(alias))
    plan: dict[tuple[uuid.UUID, str], tuple[uuid.UUID, bool]] = {}
    def saved_port_exists(endpoint: tuple[str, str]) -> bool:
        if endpoint[1] == "RADIO0" and endpoint[0] in device_rows:
            return device_rows[endpoint[0]].get("device_type") == "laptop"
        saved_ports = device_rows.get(endpoint[0], {}).get("ports", [])
        known_ports = {
            item.get("short_name") for item in saved_ports if isinstance(item, dict)
        } if isinstance(saved_ports, list) else set()
        return not known_ports or endpoint[1] in known_ports

    for endpoint, (instance, alias) in desktop_ports.items():
        valid_frontend_port = saved_port_exists(endpoint)
        component = (
            members.get(find(endpoint), []) if endpoint in parent and valid_frontend_port else []
        )
        peers = [
            candidate for candidate in component
            if candidate in desktop_ports and saved_port_exists(candidate)
        ]
        active_peers = [
            candidate for candidate in peers
            if desktop_ports[candidate][0].observed_json.get("power_state") == "RUNNING"
        ]
        has_switch = any(
            device_rows.get(candidate[0], {}).get("device_type") in {"switch", "l3switch"}
            and (
                candidate[0] not in bound_switches
                or bound_switches[candidate[0]].observed_json.get("power_state") == "RUNNING"
            )
            for candidate in component
        )
        has_cloud = any(
            device_rows.get(candidate[0], {}).get("model_id") == "generic-cloud-bridge"
            and bool(device_rows[candidate[0]].get("cloud_uplink"))
            for candidate in component
        )
        has_wireless_ap = any(candidate[0] in wireless_ap_ids for candidate in component)
        connected = bool(component) and (
            len(active_peers) >= 2 or has_switch or has_cloud or has_wireless_ap
        )
        signature = "|".join(sorted(f"{device}:{port}" for device, port in component))
        network_id = uuid.uuid5(experiment.id, signature) if connected else uuid.uuid5(
            instance.id, f"isolated:{alias}"
        )
        plan[(instance.id, alias)] = network_id, connected
    return plan


def sync_experiment_network(
    experiment: Experiment, document: dict[str, object], operation_id: uuid.UUID
) -> list[dict[str, object]]:
    """经 Host Agent 将每个实体端口对应的 TAP 接线或断开并保存观测。"""
    instances = list(VirtualRuntimeInstance.objects.filter(
        bound_experiment=experiment, frontend_device_id__isnull=False
    ))
    from apps.experiments.desktop_runtime import _runtime_client, _runtime_target

    cloud_plans: dict[str, uuid.UUID] = {}
    plan = network_plan(experiment, document, instances, cloud_plans)
    cloud_rows = {
        row["device_id"]: row for row in document.get("devices", [])
        if isinstance(row, dict) and row.get("model_id") == "generic-cloud-bridge"
        and isinstance(row.get("device_id"), str)
    }
    previous_rows = {
        row["device_id"]: row for row in experiment.document_json.get("devices", [])
        if isinstance(row, dict) and row.get("model_id") == "generic-cloud-bridge"
        and isinstance(row.get("device_id"), str)
    } if isinstance(experiment.document_json, dict) else {}
    configured = [row.get("cloud_uplink") for row in cloud_rows.values() if row.get("cloud_uplink")]
    if any(not isinstance(uplink, str) for uplink in configured):
        raise SimlabError("CLOUD_UPLINK_INVALID", "Cloud 上联必须是桥名；请重新选择桥接网卡")
    if len(configured) != len(set(configured)):
        raise SimlabError(
            "CLOUD_UPLINK_DUPLICATE", "一个实验中同一宿主桥只能选择一次；请改选其他桥接网卡"
        )
    wired_networks = [cloud_plans[device_id] for device_id, row in cloud_rows.items()
                      if row.get("cloud_uplink") and device_id in cloud_plans]
    if len(wired_networks) != len(set(wired_networks)):
        raise SimlabError(
            "CLOUD_UPLINK_LOOP", "两个 Cloud 不能接入同一实验网段；请断开其中一条网线"
        )
    for uplink in configured:
        if uplink not in settings.CLOUD_UPLINK_BRIDGES:
            raise SimlabError(
                "CLOUD_UPLINK_NOT_ALLOWED", "所选宿主桥未获批准；请刷新上联列表或联系管理员"
            )
    if not instances and settings.RUNTIME_MODE != "runtime_real":
        return []
    client = _runtime_client()
    results = []
    # 即使没有运行中的 VM，也要移除已删除/已取消配置 Cloud 的宿主接线。
    cloud_ids = (
        sorted(set(previous_rows) | set(cloud_rows))
        if settings.RUNTIME_MODE == "runtime_real" else []
    )
    for device_id in cloud_ids:
        row = cloud_rows.get(device_id, {})
        uplink = str(row.get("cloud_uplink") or "")
        network_id = cloud_plans.get(device_id)
        active = bool(uplink and network_id)
        observed = client.wire_cloud(
            uuid.uuid5(operation_id, f"cloud:{device_id}:{network_id}:{uplink}:{active}"),
            experiment.id, uuid.uuid5(experiment.id, f"cloud:{device_id}"),
            network_id or uuid.uuid5(experiment.id, f"cloud-empty:{device_id}"),
            uplink, up=active,
        )
        results.append({"device_id": device_id, "status": observed["status"],
                        "uplink_bridge": uplink, "quality": "real_runtime"})
    for instance in instances:
        ports = dict(instance.observed_json.get("network_ports") or {})
        aliases = instance.desired_json.get("nic_aliases") or [
            item.get("port_alias") for item in instance.observed_json.get("interfaces", [])
            if isinstance(item, dict)
        ]
        keys = instance.desired_json.get("frontend_port_keys") or aliases
        for key, alias in zip(keys, aliases, strict=False):
            network_id, connected = plan[(instance.id, str(alias))]
            observed = client.wire_port(
                uuid.uuid5(operation_id, f"{instance.id}:{alias}:{network_id}:{connected}"),
                _runtime_target(instance), str(alias), network_id, up=connected,
                domain_name=(
                    instance.domain_name
                    if instance.source == VirtualRuntimeInstance.Source.EXTERNAL else None
                ),
            )
            ports[str(key)] = {
                "runtime_alias": alias,
                "status": observed.get("network_status", "UNKNOWN"),
                "bridge": observed.get("network_bridge", ""),
            }
            instance.observed_json = {**observed, "network_ports": ports}
            instance.save(update_fields=("observed_json", "updated_at"))
            results.append({
                "device_id": instance.frontend_device_id, "port": key, **ports[str(key)]
            })
    return results
