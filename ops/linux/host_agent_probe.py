#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证真实 Host Agent 的防重、VM 生命周期、链路和精确清理。"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

SOCKET_PATH: Final = Path("/run/simlab/host-agent.sock")
MAX_RESPONSE_BYTES: Final = 262_144
LIBVIRT_URI: Final = "qemu:///system"


class ProbeError(RuntimeError):
    """Host Agent 真实探测未满足预期。"""


def request(
    action: str,
    operation_id: uuid.UUID,
    *,
    experiment_id: uuid.UUID | None = None,
    unit_id: uuid.UUID | None = None,
    generation: int | None = None,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    """发送一条严格 Agent 请求。"""
    message = {
        "schema_version": "1.0",
        "operation_id": str(operation_id),
        "action": action,
        "experiment_id": str(experiment_id) if experiment_id else None,
        "unit_id": str(unit_id) if unit_id else None,
        "generation": generation,
        "payload": payload or {},
    }
    encoded = json.dumps(message, separators=(",", ":")).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(240)
        connection.connect(str(SOCKET_PATH))
        connection.sendall(encoded)
        response_bytes = bytearray()
        while not response_bytes.endswith(b"\n"):
            chunk = connection.recv(65_536)
            if not chunk:
                break
            response_bytes.extend(chunk)
            if len(response_bytes) > MAX_RESPONSE_BYTES:
                raise ProbeError("Agent 响应超过限制")
    try:
        response = json.loads(response_bytes)
    except json.JSONDecodeError as error:
        raise ProbeError("Agent 未返回有效 JSON 响应") from error
    if not isinstance(response, dict):
        raise ProbeError("Agent 响应不是对象")
    return response


def expect_success(response: dict[str, object]) -> dict[str, object]:
    """提取成功响应，失败时保留稳定错误内容。"""
    if response.get("ok") is not True or not isinstance(response.get("result"), dict):
        raise ProbeError(f"Agent 请求失败：{response.get('error')}")
    return response["result"]


def virsh(arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    """只为探测读取受管 domain 状态。"""
    completed = subprocess.run(
        ["virsh", "-c", LIBVIRT_URI, *arguments],
        capture_output=True,
        check=False,
        text=True,
        timeout=120,
    )
    if check and completed.returncode != 0:
        raise ProbeError((completed.stderr or completed.stdout).strip())
    return completed


def unit_request(
    action: str,
    operation_id: uuid.UUID,
    experiment_id: uuid.UUID,
    unit_id: uuid.UUID,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    """发送运行单元动作。"""
    return request(
        action,
        operation_id,
        experiment_id=experiment_id,
        unit_id=unit_id,
        generation=1,
        payload=payload,
    )


def run_probe(evidence_path: Path) -> None:
    """执行两台 VM 的真实 Agent 闭环并保存证据。"""
    started_at = datetime.now(UTC)
    experiment_id = uuid.uuid4()
    units = (uuid.uuid4(), uuid.uuid4())
    operation_namespace = uuid.uuid4()
    evidence: dict[str, object] = {
        "schema_version": "1.0",
        "gate": "TSK-008",
        "started_at": started_at.isoformat(),
        "experiment_id": str(experiment_id),
        "units": [str(unit_id) for unit_id in units],
    }
    observations: dict[str, object] = {}
    defined_units: list[uuid.UUID] = []
    probe_failure: str | None = None
    cleaned = False
    try:
        preflight = expect_success(request("PREFLIGHT", uuid.uuid5(operation_namespace, "preflight")))
        observations["preflight"] = preflight
        defined: list[dict[str, object]] = []
        for index, unit_id in enumerate(units, start=1):
            define_operation = uuid.uuid5(operation_namespace, f"define-{unit_id}")
            spec = {
                "profile_release_id": "linux-cloud-profile-v1",
                "memory_mib": 1024,
                "vcpu_count": 1,
                "disk_gib": 8,
                "ipv4_address": f"10.88.0.{100 + index}",
                "hostname": f"agent-probe-{index}",
                "link_up": False,
            }
            first = expect_success(
                unit_request(
                    "ENSURE_DEFINED", define_operation, experiment_id, unit_id, spec
                )
            )
            repeated = expect_success(
                unit_request(
                    "ENSURE_DEFINED", define_operation, experiment_id, unit_id, spec
                )
            )
            if first != repeated:
                raise ProbeError("相同 operation_id 未返回相同定义结果")
            defined.append(first)
            defined_units.append(unit_id)
        observations["defined"] = defined
        observations["initial_links"] = {
            item["domain_name"]: virsh(
                ["domif-getlink", str(item["domain_name"]), str(item["tap"])]
            ).stdout.strip()
            for item in defined
        }
        running: list[dict[str, object]] = []
        for unit_id, item in zip(units, defined, strict=True):
            running.append(
                expect_success(
                    unit_request(
                        "START",
                        uuid.uuid5(operation_namespace, f"start-{unit_id}"),
                        experiment_id,
                        unit_id,
                    )
                )
            )
            expect_success(
                unit_request(
                    "SET_LINK",
                    uuid.uuid5(operation_namespace, f"link-up-{unit_id}"),
                    experiment_id,
                    unit_id,
                    {"port_alias": "eth0", "up": True},
                )
            )
        observations["running"] = running
        observations["connected_links"] = {
            item["domain_name"]: virsh(
                ["domif-getlink", str(item["domain_name"]), str(item["tap"])]
            ).stdout.strip()
            for item in defined
        }
        observations["interfaces"] = {
            item["domain_name"]: virsh(["domiflist", str(item["domain_name"])]).stdout.strip()
            for item in defined
        }
        disk_paths: list[str] = []
        for item in defined:
            block_rows = virsh(["domblklist", str(item["domain_name"]), "--details"]).stdout
            source_rows = [
                row.split()[-1]
                for row in block_rows.splitlines()
                if " disk " in f" {row} " and "qcow2" not in row
            ]
            if not source_rows:
                source_rows = [
                    row.split()[-1]
                    for row in block_rows.splitlines()
                    if row.split() and row.split()[0] == "file" and row.split()[1] == "disk"
                ]
            if not source_rows:
                raise ProbeError(f"未找到 {item['domain_name']} 的独立磁盘")
            disk_paths.append(source_rows[0])
        if len(set(disk_paths)) != len(units):
            raise ProbeError("两个运行单元错误地共享了可写磁盘")
        observations["independent_disks"] = disk_paths
        observations["ovs_ports"] = subprocess.run(
            ["ovs-vsctl", "list-ports", str(defined[0]["bridge"])],
            capture_output=True,
            check=True,
            text=True,
            timeout=30,
        ).stdout.splitlines()
        stable_mac_before = {
            item["domain_name"]: str(item["mac_address"])
            for item in defined
        }
        expect_success(
            unit_request(
                "SET_LINK",
                uuid.uuid5(operation_namespace, "link-down-first"),
                experiment_id,
                units[0],
                {"port_alias": "eth0", "up": False},
            )
        )
        observations["link_down"] = virsh(
            ["domif-getlink", str(defined[0]["domain_name"]), str(defined[0]["tap"])]
        ).stdout.strip()
        expect_success(
            unit_request(
                "SET_LINK",
                uuid.uuid5(operation_namespace, "link-up-first-again"),
                experiment_id,
                units[0],
                {"port_alias": "eth0", "up": True},
            )
        )
        observations["link_reconnected"] = virsh(
            ["domif-getlink", str(defined[0]["domain_name"]), str(defined[0]["tap"])]
        ).stdout.strip()
        observations["stable_mac"] = stable_mac_before
        observations["guest_network_evidence"] = "docs/poc/g0-evidence.json"
        if (
            not all(
                str(value).split()[-1] == "down"
                for value in observations["initial_links"].values()
            )
            or not all(
                str(value).split()[-1] == "up"
                for value in observations["connected_links"].values()
            )
            or str(observations["link_down"]).split()[-1] != "down"
            or str(observations["link_reconnected"]).split()[-1] != "up"
        ):
            raise ProbeError("链路状态未按 Agent 动作改变")
    except (ProbeError, OSError, subprocess.SubprocessError) as error:
        probe_failure = str(error)
    finally:
        cleanup_errors: list[str] = []
        for unit_id in defined_units:
            for action in ("FORCE_OFF", "DELETE_UNIT"):
                response = unit_request(
                    action,
                    uuid.uuid5(operation_namespace, f"cleanup-{action}-{unit_id}"),
                    experiment_id,
                    unit_id,
                )
                if response.get("ok") is not True:
                    cleanup_errors.append(str(response.get("error")))
        fabric_response = request(
            "DELETE_FABRIC",
            uuid.uuid5(operation_namespace, "cleanup-fabric"),
            experiment_id=experiment_id,
        )
        if fabric_response.get("ok") is not True:
            cleanup_errors.append(str(fabric_response.get("error")))
        cleaned = not cleanup_errors
        observations["cleanup_errors"] = cleanup_errors
    evidence.update(
        {
            "completed_at": datetime.now(UTC).isoformat(),
            "passed": probe_failure is None and cleaned and not observations["cleanup_errors"],
            "observations": observations,
            "resources_cleaned": cleaned,
            "error": probe_failure,
            "limitations": [
                "当前 Ubuntu cloud profile 未预装 qemu-guest-agent；本证据不声明 QGA readiness。",
                "Guest 内真实通信、NO-CARRIER 与恢复沿用 docs/poc/g0-evidence.json 的 G0 证据。",
            ],
        }
    )
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not evidence["passed"]:
        raise ProbeError(probe_failure or f"清理失败：{observations['cleanup_errors']}")
    print(json.dumps({"passed": True, "evidence": str(evidence_path)}, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    """读取证据输出位置。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence", type=Path, default=Path("docs/poc/host-agent-evidence.json")
    )
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""
    try:
        run_probe(parse_args().evidence)
        return 0
    except (ProbeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
