# -*- coding: utf-8 -*-
"""控制平面访问本机 Host Agent 的受限客户端。"""

from __future__ import annotations

import json
import socket
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

PROTOCOL_VERSION = "1.0"
MAX_RESPONSE_BYTES = 262_144


class HostAgentClientError(Exception):
    """Host Agent 不可用或拒绝动作。"""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


@dataclass(frozen=True)
class RuntimeTarget:
    """一次 Host Agent 操作的稳定资源身份。"""

    experiment_id: UUID
    unit_id: UUID
    generation: int


class RealRuntimeClient:
    """每次请求建立一条本机 Unix Socket 连接。"""

    def __init__(self, socket_path: Path, timeout_seconds: float) -> None:
        self._socket_path = socket_path
        self._timeout_seconds = timeout_seconds

    def _request(
        self,
        *,
        operation_id: UUID,
        action: str,
        target: RuntimeTarget | None = None,
        payload: dict[str, object] | None = None,
        experiment_id: UUID | None = None,
    ) -> dict[str, object]:
        """发送严格的一问一答 JSON Lines 请求。"""
        request = {
            "schema_version": PROTOCOL_VERSION,
            "operation_id": str(operation_id),
            "action": action,
            "experiment_id": str(target.experiment_id if target else experiment_id)
            if target or experiment_id
            else None,
            "unit_id": str(target.unit_id) if target else None,
            "generation": target.generation if target else None,
            "payload": payload or {},
        }
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self._timeout_seconds)
                connection.connect(str(self._socket_path))
                connection.sendall(encoded)
                response_bytes = bytearray()
                while not response_bytes.endswith(b"\n"):
                    chunk = connection.recv(65_536)
                    if not chunk:
                        break
                    response_bytes.extend(chunk)
                    if len(response_bytes) > MAX_RESPONSE_BYTES:
                        raise HostAgentClientError(
                            "HOST_AGENT_RESPONSE_TOO_LARGE",
                            "Host Agent 响应超过大小限制",
                            retryable=False,
                        )
        except (FileNotFoundError, ConnectionError, TimeoutError) as error:
            raise HostAgentClientError(
                "HOST_AGENT_UNAVAILABLE",
                "Host Agent 当前不可用，请检查本机服务和 Socket 权限",
                retryable=True,
            ) from error
        try:
            response = json.loads(response_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HostAgentClientError(
                "HOST_AGENT_PROTOCOL_ERROR", "Host Agent 返回了无效响应", retryable=True
            ) from error
        if not isinstance(response, dict) or response.get("schema_version") != PROTOCOL_VERSION:
            raise HostAgentClientError(
                "HOST_AGENT_PROTOCOL_ERROR", "Host Agent 响应版本无效", retryable=False
            )
        if response.get("operation_id") != str(operation_id):
            received_operation_id = response.get("operation_id")
            raise HostAgentClientError(
                "HOST_AGENT_OPERATION_ID_MISMATCH",
                "Host Agent 回包 operation_id 与本次请求不一致"
                f"（请求 {operation_id}，回包 {received_operation_id!s}）；"
                "请确认后端与 /run/simlab/host-agent.sock 对应同一部署版本，"
                "然后重启 simlab-host-agent.service",
                retryable=False,
            )
        if response.get("ok") is not True:
            error_payload = response.get("error", {})
            if not isinstance(error_payload, dict):
                error_payload = {}
            raise HostAgentClientError(
                str(error_payload.get("code", "HOST_AGENT_FAILED")),
                str(error_payload.get("message", "Host Agent 拒绝了请求")),
                retryable=bool(error_payload.get("retryable", False)),
            )
        result = response.get("result")
        if not isinstance(result, dict):
            raise HostAgentClientError(
                "HOST_AGENT_PROTOCOL_ERROR", "Host Agent 成功响应缺少 result", retryable=False
            )
        return result

    def preflight(self, operation_id: UUID) -> dict[str, object]:
        """查询 agent 的实际能力。"""
        return self._request(operation_id=operation_id, action="PREFLIGHT")

    def ensure_defined(
        self, operation_id: UUID, target: RuntimeTarget, spec: dict[str, object]
    ) -> dict[str, object]:
        """幂等确保运行单元已定义。"""
        return self._request(
            operation_id=operation_id,
            action="ENSURE_DEFINED",
            target=target,
            payload=spec,
        )

    def bind_external(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str
    ) -> dict[str, object]:
        """核对一个白名单外部 domain 并读取实际状态。"""
        return self._request(
            operation_id=operation_id,
            action="BIND_EXTERNAL",
            target=target,
            payload={"domain_name": domain_name},
        )

    def start(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str | None = None
    ) -> dict[str, object]:
        """启动运行单元。"""
        return self._request(
            operation_id=operation_id,
            action="START",
            target=target,
            payload={"domain_name": domain_name} if domain_name else None,
        )

    def shutdown(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str | None = None
    ) -> dict[str, object]:
        """正常关闭运行单元。"""
        return self._request(
            operation_id=operation_id,
            action="SHUTDOWN",
            target=target,
            payload={"domain_name": domain_name} if domain_name else None,
        )

    def force_off(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str | None = None
    ) -> dict[str, object]:
        """强制停止运行单元。"""
        return self._request(
            operation_id=operation_id,
            action="FORCE_OFF",
            target=target,
            payload={"domain_name": domain_name} if domain_name else None,
        )

    def reset(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str | None = None
    ) -> dict[str, object]:
        """重置正在运行的单元。"""
        return self._request(
            operation_id=operation_id,
            action="RESET",
            target=target,
            payload={"domain_name": domain_name} if domain_name else None,
        )

    def observe(
        self, operation_id: UUID, target: RuntimeTarget, domain_name: str | None = None
    ) -> dict[str, object]:
        """读取实际状态。"""
        return self._request(
            operation_id=operation_id,
            action="OBSERVE",
            target=target,
            payload={"domain_name": domain_name} if domain_name else None,
        )

    def set_link(
        self,
        operation_id: UUID,
        target: RuntimeTarget,
        port_alias: str,
        *,
        up: bool,
        domain_name: str | None = None,
    ) -> dict[str, object]:
        """改变固定端口的虚拟载波。"""
        return self._request(
            operation_id=operation_id,
            action="SET_LINK",
            target=target,
            payload={
                "port_alias": port_alias,
                "up": up,
                **({"domain_name": domain_name} if domain_name else {}),
            },
        )

    def wire_port(
        self,
        operation_id: UUID,
        target: RuntimeTarget,
        port_alias: str,
        network_id: UUID,
        *,
        up: bool,
        domain_name: str | None = None,
    ) -> dict[str, object]:
        """将一张真实 TAP 接入确定的隔离 OVS 网络，并设置虚拟载波。"""
        return self._request(
            operation_id=operation_id,
            action="WIRE_PORT",
            target=target,
            payload={
                "port_alias": port_alias,
                "network_id": str(network_id),
                "up": up,
                **({"domain_name": domain_name} if domain_name else {}),
            },
        )

    def wire_cloud(
        self, operation_id: UUID, experiment_id: UUID, cloud_id: UUID,
        network_id: UUID, uplink_bridge: str, *, up: bool,
    ) -> dict[str, object]:
        """将实验广播域接到预批准的宿主 OVS 桥，或拆除该 Cloud 接线。"""
        return self._request(
            operation_id=operation_id,
            action="CLOUD_WIRE",
            experiment_id=experiment_id,
            payload={"cloud_id": str(cloud_id), "network_id": str(network_id),
                     "uplink_bridge": uplink_bridge, "up": up},
        )

    def delete_unit(self, operation_id: UUID, target: RuntimeTarget) -> dict[str, object]:
        """删除一个精确运行单元。"""
        return self._request(operation_id=operation_id, action="DELETE_UNIT", target=target)

    def delete_fabric(self, operation_id: UUID, experiment_id: UUID) -> dict[str, object]:
        """删除无运行单元引用的实验网络。"""
        return self._request(
            operation_id=operation_id,
            action="DELETE_FABRIC",
            experiment_id=experiment_id,
        )
