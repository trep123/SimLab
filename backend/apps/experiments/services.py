# -*- coding: utf-8 -*-
"""实验领域服务、命令提交和开发 Runtime 投影。"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from django.db import transaction
from django.utils import timezone

from apps.experiments.models import (
    Cable,
    CableEnd,
    Command,
    DeviceInstance,
    DeviceModelRelease,
    DevicePort,
    Experiment,
    ExperimentEvent,
    ExperimentMember,
    ExperimentSnapshot,
    ExternalRuntimeBinding,
    ExternalRuntimeCommand,
    MemberRole,
    OutboxMessage,
    PortAttachment,
    RuntimeUnit,
    VirtualRuntimeInstance,
)
from runtime.real_client import (
    HostAgentClientError,
    RealRuntimeClient,
    RuntimeTarget,
)

LOGGER = logging.getLogger(__name__)
RUNTIME_IPV4_FIRST_HOST = 10
RUNTIME_IPV4_LAST_HOST = 250
G0_COMMAND_BIND = "external.bind"
G0_COMMAND_UNBIND = "external.unbind"
G0_COMMAND_POWER_ON = "external.power_on"
G0_COMMAND_SHUTDOWN = "external.shutdown"
G0_SUPPORTED_COMMANDS = frozenset(
    {G0_COMMAND_BIND, G0_COMMAND_UNBIND, G0_COMMAND_POWER_ON, G0_COMMAND_SHUTDOWN}
)

CONFIGURING_COMMANDS = frozenset(
    {
        "experiment.document.save",
        "experiment.archive",
        "experiment.member.set",
        "experiment.member.remove",
        "device.create",
        "device.update",
        "device.delete",
        "device.move",
        "cable.connect",
        "cable.disconnect",
        "snapshot.restore_cold",
        "fault.inject",
        "fault.clear",
    }
)
SUPPORTED_COMMANDS = CONFIGURING_COMMANDS | frozenset(
    {
        "device.power_on",
        "device.shutdown",
        "device.force_off",
        "device.restart",
        "device.reset",
        "snapshot.create_cold",
    }
)


class SimlabError(Exception):
    """具有稳定错误码的领域异常。"""

    def __init__(
        self, code: str, message: str, *, status_code: int = 400, retryable: bool = False
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
        super().__init__(message)

    def as_dict(self) -> dict[str, object]:
        """返回安全的 API 错误结构。"""
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


@dataclass(frozen=True)
class CommandEnvelope:
    """已经过结构校验的命令信封。"""

    command_id: UUID
    type: str
    expected_config_revision: int
    payload: dict[str, object]


def canonical_hash(envelope: CommandEnvelope) -> str:
    """计算确定性的请求哈希。"""
    content = {
        "command_id": str(envelope.command_id),
        "expected_config_revision": envelope.expected_config_revision,
        "payload": envelope.payload,
        "type": envelope.type,
    }
    encoded = json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def require_member(
    user: AbstractBaseUser, experiment: Experiment, *, write: bool = False
) -> ExperimentMember:
    """验证用户对实验的对象权限。"""
    membership = ExperimentMember.objects.filter(experiment=experiment, user=user).first()
    if membership is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
    if write and membership.role == MemberRole.VIEWER:
        raise SimlabError("PERMISSION_DENIED", "当前成员只有查看权限", status_code=403)
    return membership


def append_event(
    experiment: Experiment,
    event_type: str,
    payload: dict[str, object],
    command: Command | None = None,
) -> ExperimentEvent:
    """在锁定的实验内追加单调事件并创建 outbox。"""
    experiment.last_event_seq += 1
    experiment.save(update_fields=("last_event_seq", "updated_at"))
    event = ExperimentEvent.objects.create(
        experiment=experiment,
        seq=experiment.last_event_seq,
        generation=experiment.generation,
        type=event_type,
        command=command,
        payload=payload,
    )
    OutboxMessage.objects.create(event=event)
    return event


@transaction.atomic
def create_experiment(user: AbstractBaseUser, name: str) -> Experiment:
    """创建实验并授予创建者 OWNER 权限。"""
    experiment = Experiment.objects.create(name=name.strip() or "未命名实验", owner=user)
    ExperimentMember.objects.create(experiment=experiment, user=user, role=MemberRole.OWNER)
    append_event(experiment, "experiment.created", {"name": experiment.name})
    return experiment


@transaction.atomic
def submit_command(
    user: AbstractBaseUser, experiment_id: UUID, envelope: CommandEnvelope
) -> tuple[Command, bool]:
    """持久化命令并实施幂等与乐观并发检查。"""
    if envelope.type not in SUPPORTED_COMMANDS:
        raise SimlabError("COMMAND_UNSUPPORTED", "当前版本不支持该命令")
    request_hash = canonical_hash(envelope)
    existing = Command.objects.filter(pk=envelope.command_id).first()
    if existing is not None:
        require_member(user, existing.experiment)
        if existing.experiment_id != experiment_id or existing.request_hash != request_hash:
            raise SimlabError("IDEMPOTENCY_KEY_REUSED", "命令 ID 已被其他请求使用", status_code=409)
        return existing, False

    experiment = Experiment.objects.select_for_update().get(pk=experiment_id)
    require_member(user, experiment, write=True)
    if envelope.expected_config_revision != experiment.config_revision:
        raise SimlabError(
            "CONFIG_REVISION_CONFLICT",
            f"配置版本已变更，当前版本为 {experiment.config_revision}",
            status_code=409,
        )
    accepted_order = experiment.commands.count() + 1
    command = Command.objects.create(
        id=envelope.command_id,
        experiment=experiment,
        actor=user,
        type=envelope.type,
        payload=envelope.payload,
        request_hash=request_hash,
        expected_config_revision=envelope.expected_config_revision,
        accepted_order=accepted_order,
    )
    event = append_event(
        experiment,
        "command.accepted",
        {"command_id": str(command.id), "type": command.type},
        command,
    )
    command.result = {"accepted_event_seq": event.seq}
    command.save(update_fields=("result",))
    return command, True


def _require_payload_id(payload: dict[str, object], key: str) -> UUID:
    """从命令 payload 读取 UUID。"""
    value = payload.get(key)
    try:
        return UUID(str(value))
    except (ValueError, TypeError) as error:
        raise SimlabError("INVALID_PAYLOAD", f"{key} 必须是 UUID") from error


def _runtime_client() -> RealRuntimeClient:
    """构造不持有连接的真实 Runtime 客户端。"""
    return RealRuntimeClient(settings.HOST_AGENT_SOCKET, settings.HOST_AGENT_TIMEOUT_SECONDS)


def _runtime_target(unit: RuntimeUnit) -> RuntimeTarget:
    """从权威映射生成 Host Agent 资源身份。"""
    return RuntimeTarget(unit.experiment_id, unit.id, unit.generation)


def _runtime_operation_id(command: Command, label: str) -> UUID:
    """为一个命令子步骤生成可重试的稳定操作 ID。"""
    return uuid.uuid5(command.id, label)


def _raise_runtime_error(error: HostAgentClientError) -> None:
    """把 Host Agent 错误转换为领域错误。"""
    raise SimlabError(error.code, error.message, retryable=error.retryable) from error


def _g0_runtime_target() -> RuntimeTarget:
    """为固定 G0 domain 生成稳定、不可由浏览器指定的宿主资源身份。"""
    domain_name = settings.G0_PC1_DOMAIN
    return RuntimeTarget(
        uuid.uuid5(uuid.NAMESPACE_URL, "simlab:g0-pc1:experiment"),
        uuid.uuid5(uuid.NAMESPACE_URL, f"simlab:g0-domain:{domain_name}"),
        1,
    )


def observe_g0_runtime() -> dict[str, object]:
    """通过 Host Agent 白名单核对并观测固定的 simlab-g0-pc1。"""
    try:
        return _runtime_client().bind_external(
            uuid.uuid4(), _g0_runtime_target(), settings.G0_PC1_DOMAIN
        )
    except HostAgentClientError as error:
        raise SimlabError(
            error.code, error.message, status_code=503, retryable=error.retryable
        ) from error


def _fail_external_command(
    command: ExternalRuntimeCommand, code: str, message: str, retryable: bool = False
) -> None:
    """持久化外部 Runtime 命令的失败结果。"""
    command.status = ExternalRuntimeCommand.Status.FAILED
    command.error = {"code": code, "message": message, "retryable": retryable}
    command.completed_at = timezone.now()
    command.save(update_fields=("status", "error", "completed_at"))


def execute_g0_command(
    command_type: str, payload: dict[str, object]
) -> tuple[ExternalRuntimeBinding | None, dict[str, object], ExternalRuntimeCommand]:
    """持久化并同步执行一个受限 G0 Runtime 命令。"""
    if command_type not in G0_SUPPORTED_COMMANDS:
        raise SimlabError("COMMAND_UNSUPPORTED", "不支持的 G0 Runtime 命令")
    frontend_device_id = str(payload.get("device_id", ""))
    command = ExternalRuntimeCommand.objects.create(
        domain_name=settings.G0_PC1_DOMAIN,
        frontend_device_id=frontend_device_id,
        type=command_type,
        payload=payload,
    )
    command.status = ExternalRuntimeCommand.Status.RUNNING
    command.started_at = timezone.now()
    command.save(update_fields=("status", "started_at"))

    try:
        current_binding = ExternalRuntimeBinding.objects.filter(
            domain_name=settings.G0_PC1_DOMAIN
        ).first()
        if command_type in {G0_COMMAND_POWER_ON, G0_COMMAND_SHUTDOWN}:
            if current_binding is None:
                raise SimlabError("G0_PC_NOT_BOUND", "请先选择一台 PC 并保存绑定配置")
            if frontend_device_id != current_binding.frontend_device_id:
                raise SimlabError("G0_PC_BINDING_MISMATCH", "当前 PC 未绑定 simlab-g0-pc1")
            client = _runtime_client()
            operation_id = uuid.uuid5(command.id, "runtime-operation")
            if command_type == G0_COMMAND_POWER_ON:
                observation = client.start(
                    operation_id, _g0_runtime_target(), settings.G0_PC1_DOMAIN
                )
            else:
                observation = client.shutdown(
                    operation_id, _g0_runtime_target(), settings.G0_PC1_DOMAIN
                )
        else:
            observation = observe_g0_runtime()

        with transaction.atomic():
            if command_type == G0_COMMAND_BIND:
                binding, _ = ExternalRuntimeBinding.objects.update_or_create(
                    domain_name=settings.G0_PC1_DOMAIN,
                    defaults={
                        "frontend_device_id": frontend_device_id,
                        "model_id": str(payload.get("model_id", "")),
                        "display_name": str(payload.get("display_name", "")),
                        "observed_json": observation,
                    },
                )
                VirtualRuntimeInstance.objects.filter(
                    domain_name=settings.G0_PC1_DOMAIN
                ).update(
                    frontend_device_id=frontend_device_id,
                    model_id=str(payload.get("model_id", "")),
                    display_name=str(payload.get("display_name", "")),
                    observed_json=observation,
                )
            elif command_type in {G0_COMMAND_UNBIND, G0_COMMAND_SHUTDOWN}:
                ExternalRuntimeBinding.objects.filter(domain_name=settings.G0_PC1_DOMAIN).delete()
                VirtualRuntimeInstance.objects.filter(
                    domain_name=settings.G0_PC1_DOMAIN
                ).update(
                    frontend_device_id=None,
                    bound_experiment=None,
                    model_id="",
                    display_name="",
                    observed_json=observation,
                )
                binding = None
            else:
                assert current_binding is not None
                current_binding.observed_json = observation
                current_binding.save(update_fields=("observed_json", "updated_at"))
                binding = current_binding
            command.status = ExternalRuntimeCommand.Status.SUCCEEDED
            command.result = observation
            command.completed_at = timezone.now()
            command.save(update_fields=("status", "result", "completed_at"))
        return binding, observation, command
    except HostAgentClientError as error:
        _fail_external_command(command, error.code, error.message, error.retryable)
        raise SimlabError(
            error.code, error.message, status_code=503, retryable=error.retryable
        ) from error
    except SimlabError as error:
        _fail_external_command(command, error.code, error.message, error.retryable)
        raise


def _runtime_profile_id(model: DeviceModelRelease) -> str | None:
    """读取模型声明的首个 QEMU Runtime Profile。"""
    profiles = model.manifest_json.get("runtime_profiles", [])
    if not isinstance(profiles, list):
        return None
    for profile in profiles:
        if isinstance(profile, dict) and profile.get("backend") == "qemu":
            value = profile.get("profile_release_id")
            return str(value) if value else None
    return None


def _allocate_runtime_ipv4(experiment: Experiment) -> str:
    """在实验隔离网段内分配唯一静态地址。"""
    used_addresses = {
        str(value) for value in experiment.runtime_units.values_list("ipv4_address", flat=True)
    }
    for host_number in range(RUNTIME_IPV4_FIRST_HOST, RUNTIME_IPV4_LAST_HOST + 1):
        candidate = f"10.88.0.{host_number}"
        if candidate not in used_addresses:
            return candidate
    raise SimlabError("RUNTIME_ADDRESS_EXHAUSTED", "实验 Runtime 地址已用尽", status_code=409)


def _create_device(command: Command, experiment: Experiment) -> dict[str, object]:
    model_id = _require_payload_id(command.payload, "model_release_id")
    model = DeviceModelRelease.objects.filter(pk=model_id, publication_status="PUBLISHED").first()
    if model is None:
        raise SimlabError("MODEL_UNAVAILABLE", "设备型号不存在或尚未发布")
    name = str(command.payload.get("name") or model.name)
    position = command.payload.get("position", {"x": 0, "y": 0, "z": 0})
    if not isinstance(position, dict):
        raise SimlabError("INVALID_PAYLOAD", "position 必须是对象")
    device = DeviceInstance.objects.create(
        experiment=experiment,
        model_release=model,
        name=name,
        position=position,
        rotation={"x": 0, "y": 0, "z": 0},
        observed_json={"source": "configured", "runtime_mode": settings.RUNTIME_MODE},
    )
    profile_release_id = _runtime_profile_id(model)
    runtime_unit: RuntimeUnit | None = None
    if settings.RUNTIME_MODE == "runtime_real" and profile_release_id:
        runtime_unit = RuntimeUnit.objects.create(
            experiment=experiment,
            device=device,
            profile_release_id=profile_release_id,
            ipv4_address=_allocate_runtime_ipv4(experiment),
            desired_json={"memory_mib": 1024, "vcpu_count": 1, "disk_gib": 8},
        )
    for port in model.manifest_json.get("ports", []):
        guest_identity: dict[str, object] = {"stable_alias": f"simlab-{port['port_key']}"}
        if runtime_unit is not None and port["port_key"] == "eth0":
            guest_identity["runtime_unit_id"] = str(runtime_unit.id)
        DevicePort.objects.create(
            experiment=experiment,
            device=device,
            port_key=port["port_key"],
            connector_type=port["connector_type"],
            protocol=port["protocol"],
            guest_identity=guest_identity,
        )
    result = {"device_id": str(device.id)}
    if runtime_unit is not None:
        result["runtime_unit_id"] = str(runtime_unit.id)
        result["runtime_fidelity"] = "REAL_RUNTIME"
    return result


def _move_device(command: Command, experiment: Experiment) -> dict[str, object]:
    device = DeviceInstance.objects.filter(
        pk=_require_payload_id(command.payload, "device_id"), experiment=experiment
    ).first()
    position = command.payload.get("position")
    if device is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "设备不存在", status_code=404)
    if not isinstance(position, dict) or not all(axis in position for axis in ("x", "y", "z")):
        raise SimlabError("INVALID_PAYLOAD", "position 必须包含 x、y、z")
    device.position = {axis: float(position[axis]) for axis in ("x", "y", "z")}
    device.save(update_fields=("position",))
    return {"device_id": str(device.id), "position": device.position}


def _update_device(command: Command, experiment: Experiment) -> dict[str, object]:
    """更新不影响 Runtime 身份的设备显示属性。"""
    device = DeviceInstance.objects.filter(
        pk=_require_payload_id(command.payload, "device_id"), experiment=experiment
    ).first()
    if device is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "设备不存在", status_code=404)
    name = str(command.payload.get("name", "")).strip()
    if not name or len(name) > 120:
        raise SimlabError("INVALID_DEVICE_NAME", "设备名称长度必须为 1 到 120 个字符")
    if (
        DeviceInstance.objects.filter(experiment=experiment, name=name)
        .exclude(pk=device.pk)
        .exists()
    ):
        raise SimlabError("DEVICE_NAME_CONFLICT", "实验中已存在同名设备", status_code=409)
    device.name = name
    device.save(update_fields=("name",))
    return {"device_id": str(device.id), "name": device.name}


def _delete_device(command: Command, experiment: Experiment) -> dict[str, object]:
    """仅删除停止且从未被线缆引用的设备。"""
    device = DeviceInstance.objects.filter(
        pk=_require_payload_id(command.payload, "device_id"), experiment=experiment
    ).first()
    if device is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "设备不存在", status_code=404)
    if device.runtime_state != "STOPPED":
        raise SimlabError("DEVICE_MUST_BE_STOPPED", "删除设备前必须先关机", status_code=409)
    if PortAttachment.objects.filter(device_port__device=device).exists():
        raise SimlabError(
            "DEVICE_HAS_CABLE_HISTORY",
            "该设备存在接线记录；当前版本为保护审计历史而拒绝删除",
            status_code=409,
        )
    if settings.RUNTIME_MODE == "runtime_real" and hasattr(device, "runtime_unit"):
        unit = device.runtime_unit
        if unit.state != "UNDEFINED":
            try:
                _runtime_client().delete_unit(
                    _runtime_operation_id(command, "delete-unit"), _runtime_target(unit)
                )
            except HostAgentClientError as error:
                _raise_runtime_error(error)
    device_id = str(device.id)
    device.delete()
    return {"device_id": device_id, "deleted": True}


def _compile_runtime_spec(device: DeviceInstance, unit: RuntimeUnit) -> dict[str, object]:
    """把已验证领域状态编译为有限 Host Agent 规格。"""
    return {
        "profile_release_id": unit.profile_release_id,
        "memory_mib": int(unit.desired_json.get("memory_mib", 1024)),
        "vcpu_count": int(unit.desired_json.get("vcpu_count", 1)),
        "disk_gib": int(unit.desired_json.get("disk_gib", 8)),
        "ipv4_address": str(unit.ipv4_address),
        "hostname": f"simlab-{device.id.hex[:10]}",
        "link_up": device.ports.filter(port_key="eth0", physical_connected=True).exists(),
        "nic_model": "virtio",
        "nic_aliases": ["eth0"],
        "gpu_model": "virtio",
    }


def _set_power_real(command: Command, device: DeviceInstance) -> dict[str, object]:
    """通过 Host Agent 执行并观测真实电源动作。"""
    try:
        unit = device.runtime_unit
    except RuntimeUnit.DoesNotExist as error:
        raise SimlabError("RUNTIME_PROFILE_MISSING", "设备没有可用的 Runtime Profile") from error
    client = _runtime_client()
    target = _runtime_target(unit)
    try:
        if command.type in {"device.power_on", "device.restart", "device.reset"}:
            if unit.state == "UNDEFINED":
                observation = client.ensure_defined(
                    _runtime_operation_id(command, "ensure-defined"),
                    target,
                    _compile_runtime_spec(device, unit),
                )
                unit.state = "DEFINED"
                unit.domain_name = str(observation["domain_name"])
                unit.observed_json = observation
                unit.save(update_fields=("state", "domain_name", "observed_json", "updated_at"))
            if command.type == "device.restart" and unit.state == "RUNNING":
                client.shutdown(_runtime_operation_id(command, "shutdown"), target)
                observation = client.start(_runtime_operation_id(command, "start"), target)
            elif command.type == "device.reset" and unit.state == "RUNNING":
                observation = client.reset(_runtime_operation_id(command, "reset"), target)
            else:
                observation = client.start(_runtime_operation_id(command, "start"), target)
        elif command.type == "device.shutdown":
            observation = client.shutdown(_runtime_operation_id(command, "shutdown"), target)
        else:
            observation = client.force_off(_runtime_operation_id(command, "force-off"), target)
    except HostAgentClientError as error:
        _raise_runtime_error(error)
    power_state = str(observation["power_state"])
    unit.state = power_state
    unit.domain_name = str(observation["domain_name"])
    unit.observed_json = observation
    unit.save(update_fields=("state", "domain_name", "observed_json", "updated_at"))
    device.power_state = "ON" if power_state == "RUNNING" else "DEENERGIZED"
    device.runtime_state = power_state
    device.boot_state = "BOOTING" if power_state == "RUNNING" else "UNKNOWN"
    device.observed_json = observation
    device.save(update_fields=("power_state", "runtime_state", "boot_state", "observed_json"))
    return {
        "device_id": str(device.id),
        "runtime_unit_id": str(unit.id),
        "power_state": device.power_state,
        "runtime_state": device.runtime_state,
        "observation": observation,
    }


def _set_power(command: Command, experiment: Experiment) -> dict[str, object]:
    device = DeviceInstance.objects.filter(
        pk=_require_payload_id(command.payload, "device_id"), experiment=experiment
    ).first()
    if device is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "设备不存在", status_code=404)
    power_on = command.type in {"device.power_on", "device.restart", "device.reset"}
    if power_on and device.assembly_state != "VALID":
        raise SimlabError("ASSEMBLY_INVALID", "装配不完整，无法上电")
    if settings.RUNTIME_MODE == "runtime_real":
        return _set_power_real(command, device)
    device.power_state = "ON" if power_on else "DEENERGIZED"
    device.runtime_state = "EXECUTING" if power_on else "STOPPED"
    device.boot_state = "OS_READY" if power_on else "UNKNOWN"
    device.observed_json = {
        "source": "configured",
        "quality": "development_mock",
        "observed_at": timezone.now().isoformat(),
    }
    device.save(update_fields=("power_state", "runtime_state", "boot_state", "observed_json"))
    return {
        "device_id": str(device.id),
        "power_state": device.power_state,
        "runtime_state": device.runtime_state,
    }


def _set_runtime_links(command: Command, ports: list[DevicePort], *, up: bool) -> None:
    """对已经定义的真实运行单元改变链路并在半失败时补偿。"""
    if settings.RUNTIME_MODE != "runtime_real":
        return
    client = _runtime_client()
    changed_units: list[tuple[RuntimeUnit, str]] = []
    try:
        for port in ports:
            try:
                unit = port.device.runtime_unit
            except RuntimeUnit.DoesNotExist:
                continue
            if unit.state == "UNDEFINED":
                continue
            alias = str(port.guest_identity.get("stable_alias", "")).removeprefix("simlab-")
            observation = client.set_link(
                _runtime_operation_id(command, f"link-{port.id}-{up}"),
                _runtime_target(unit),
                alias,
                up=up,
            )
            unit.observed_json = observation
            unit.save(update_fields=("observed_json", "updated_at"))
            changed_units.append((unit, alias))
    except HostAgentClientError as error:
        for changed_unit, alias in reversed(changed_units):
            try:
                compensation_observation = client.set_link(
                    _runtime_operation_id(command, f"link-compensate-{changed_unit.id}-{not up}"),
                    _runtime_target(changed_unit),
                    alias,
                    up=not up,
                )
                changed_unit.observed_json = compensation_observation
                changed_unit.save(update_fields=("observed_json", "updated_at"))
            except HostAgentClientError as compensation_error:
                LOGGER.error(
                    "runtime link compensation failed: unit_id=%s code=%s",
                    changed_unit.id,
                    compensation_error.code,
                )
        _raise_runtime_error(error)


def _connect_cable(command: Command, experiment: Experiment) -> dict[str, object]:
    first_id = _require_payload_id(command.payload, "port_a_id")
    second_id = _require_payload_id(command.payload, "port_b_id")
    if first_id == second_id:
        raise SimlabError("SAME_PORT", "线缆两端不能连接同一端口")
    ordered_ids = sorted((first_id, second_id), key=str)
    ports = list(
        DevicePort.objects.select_for_update()
        .filter(id__in=ordered_ids, experiment=experiment)
        .order_by("id")
    )
    if len(ports) != 2:
        raise SimlabError("RESOURCE_NOT_FOUND", "端口不存在或不属于当前实验", status_code=404)
    by_id = {port.id: port for port in ports}
    first, second = by_id[first_id], by_id[second_id]
    if first.protocol != second.protocol or first.connector_type != second.connector_type:
        raise SimlabError("PORT_INCOMPATIBLE", "端口协议或连接器不兼容", status_code=409)
    if PortAttachment.objects.filter(
        device_port_id__in=(first.id, second.id),
        state__in=(PortAttachment.State.RESERVED, PortAttachment.State.ACTIVE),
    ).exists():
        raise SimlabError("PORT_OCCUPIED", "至少一个端口已被占用", status_code=409)
    cable = Cable.objects.create(experiment=experiment, cable_type=first.protocol)
    attachments: list[PortAttachment] = []
    for end_name, port in (("A", first), ("B", second)):
        cable_end = CableEnd.objects.create(cable=cable, end=end_name)
        attachments.append(
            PortAttachment.objects.create(
                experiment=experiment,
                cable_end=cable_end,
                device_port=port,
                state=PortAttachment.State.RESERVED,
            )
        )
    try:
        _set_runtime_links(command, [first, second], up=True)
    except SimlabError:
        PortAttachment.objects.filter(pk__in=[item.pk for item in attachments]).update(
            state=PortAttachment.State.RELEASED,
            released_at=timezone.now(),
        )
        raise
    PortAttachment.objects.filter(pk__in=[item.pk for item in attachments]).update(
        state=PortAttachment.State.ACTIVE
    )
    DevicePort.objects.filter(pk__in=(first.id, second.id)).update(
        physical_connected=True,
        carrier_state="UP",
        forwarding_state="FORWARDING",
    )
    return {"cable_id": str(cable.id), "port_a_id": str(first.id), "port_b_id": str(second.id)}


def _disconnect_cable(command: Command, experiment: Experiment) -> dict[str, object]:
    cable = Cable.objects.filter(
        pk=_require_payload_id(command.payload, "cable_id"), experiment=experiment
    ).first()
    if cable is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "线缆不存在", status_code=404)
    attachments = list(
        PortAttachment.objects.select_for_update()
        .select_related("device_port__device")
        .filter(cable_end__cable=cable, state=PortAttachment.State.ACTIVE)
    )
    _set_runtime_links(command, [item.device_port for item in attachments], up=False)
    port_ids = [attachment.device_port_id for attachment in attachments]
    PortAttachment.objects.filter(pk__in=[item.pk for item in attachments]).update(
        state=PortAttachment.State.RELEASED, released_at=timezone.now()
    )
    DevicePort.objects.filter(pk__in=port_ids).update(
        physical_connected=False, carrier_state="DOWN", forwarding_state="BLOCKED"
    )
    return {"cable_id": str(cable.id), "released_port_ids": [str(item) for item in port_ids]}


def _create_snapshot(command: Command, experiment: Experiment) -> dict[str, object]:
    if experiment.devices.exclude(runtime_state="STOPPED").exists():
        raise SimlabError(
            "COLD_SNAPSHOT_REQUIRES_STOPPED", "冷快照要求所有设备已停止", status_code=409
        )
    devices = [
        {"id": str(device.id), "name": device.name, "position": device.position}
        for device in experiment.devices.all()
    ]
    cables = [
        {"id": str(cable.id), "type": cable.cable_type}
        for cable in experiment.cables.filter(
            ends__attachments__state=PortAttachment.State.ACTIVE
        ).distinct()
    ]
    snapshot = ExperimentSnapshot.objects.create(
        experiment=experiment,
        name=str(command.payload.get("name") or f"保存点 {timezone.now():%Y-%m-%d %H:%M}"),
        source_revision=experiment.config_revision,
        source_generation=experiment.generation,
        manifest_json={
            "devices": devices,
            "cables": cables,
            "fidelity": (
                "metadata_only_development_mock"
                if settings.RUNTIME_MODE == "development_mock"
                else "metadata_only_runtime_real"
            ),
        },
        created_by=command.actor,
    )
    return {"snapshot_id": str(snapshot.id), "status": snapshot.status}


def _validate_experiment_document(
    experiment: Experiment, document: object
) -> dict[str, object]:
    """校验 Web 三维实验文档，阻止超大或跨实验内容写入。"""
    if not isinstance(document, dict):
        raise SimlabError("EXP_DOCUMENT_INVALID", "实验文档必须是对象")
    if document.get("schema_version") != "1.0":
        raise SimlabError("EXP_SCHEMA_UNSUPPORTED", "仅支持 1.0 版实验文档")
    if str(document.get("experiment_id", "")) != str(experiment.id):
        raise SimlabError("EXP_ID_MISMATCH", "实验文档 ID 与服务器实验不一致", status_code=409)
    name = str(document.get("name", "")).strip()
    devices = document.get("devices")
    cables = document.get("cables")
    scene = document.get("scene")
    if not name or len(name) > 120:
        raise SimlabError("EXP_NAME_INVALID", "实验名称长度必须为 1 到 120 个字符")
    if not isinstance(devices, list) or len(devices) > 500:
        raise SimlabError("EXP_DEVICES_INVALID", "实验设备必须是最多 500 项的数组")
    if not isinstance(cables, list) or len(cables) > 2000:
        raise SimlabError("EXP_CABLES_INVALID", "实验线缆必须是最多 2000 项的数组")
    associations = document.get("wireless_associations", [])
    if not isinstance(associations, list) or len(associations) > 500:
        raise SimlabError(
            "WIRELESS_ASSOC_INVALID", "无线关联清单无效；请刷新无线面板后重试"
        )
    device_types = {
        item.get("device_id"): item.get("device_type")
        for item in devices if isinstance(item, dict)
    }
    for device in devices:
        if not isinstance(device, dict) or "ap_radio" not in device:
            continue
        radio = device["ap_radio"]
        if not isinstance(radio, dict) or device.get("device_type") != "ap":
            raise SimlabError(
                "AP_RADIO_INVALID", "射频配置只能用于 AP；请检查设备类型后重试"
            )
        ssid = radio.get("ssid")
        channel = radio.get("channel")
        power = radio.get("tx_power_dbm")
        if (
            not isinstance(ssid, str) or not 1 <= len(ssid.encode("utf-8")) <= 32
            or not isinstance(channel, int) or isinstance(channel, bool)
            or channel not in {1, 6, 11, 36, 40, 44, 48}
            or not isinstance(power, int) or isinstance(power, bool)
            or not 0 <= power <= 30
        ):
            raise SimlabError(
                "AP_RADIO_INVALID",
                "AP 参数无效；SSID 须为 1–32 字节，信道选 1/6/11/36/40/44/48，功率 0–30 dBm",
            )
    seen_clients: set[str] = set()
    for association in associations:
        if not isinstance(association, dict):
            raise SimlabError(
                "WIRELESS_ASSOC_INVALID", "无线关联格式无效；请刷新无线面板后重试"
            )
        client_id = association.get("sta_device_id")
        ap_id = association.get("ap_device_id")
        if (
            not isinstance(client_id, str) or not isinstance(ap_id, str)
            or client_id in seen_clients
            or device_types.get(client_id) not in {"laptop", "phone"}
            or device_types.get(ap_id) != "ap"
        ):
            raise SimlabError(
                "WIRELESS_ASSOC_INVALID",
                "无线关联必须指向本实验中的唯一客户端和 AP；请重新选择",
            )
        seen_clients.add(client_id)
    if not isinstance(scene, dict):
        raise SimlabError("EXP_SCENE_INVALID", "实验场景设置必须是对象")
    encoded_size = len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode())
    if encoded_size > 5 * 1024 * 1024:
        raise SimlabError("EXP_DOCUMENT_TOO_LARGE", "实验文档不能超过 5 MiB")
    return document


def _save_experiment_document(command: Command, experiment: Experiment) -> dict[str, object]:
    """通过命令服务保存 Web 三维实验文档。"""
    document = _validate_experiment_document(experiment, command.payload.get("document"))
    from apps.experiments.desktop_network import sync_experiment_network

    try:
        links = sync_experiment_network(experiment, document, command.id)
    except HostAgentClientError as error:
        raise SimlabError(
            error.code, f"虚拟网卡接线失败：{error.message}；请检查 Host Agent 后重试保存",
            status_code=503, retryable=error.retryable,
        ) from error
    experiment.name = str(document["name"]).strip()
    experiment.document_json = document
    experiment.save(update_fields=("name", "document_json", "updated_at"))
    return {
        "experiment_id": str(experiment.id),
        "device_count": len(document["devices"]),
        "cable_count": len(document["cables"]),
        "runtime_network_ports": links,
    }


def _archive_experiment(command: Command, experiment: Experiment) -> dict[str, object]:
    """仅允许所有者通过命令服务归档实验。"""
    membership = require_member(command.actor, experiment, write=True)
    if membership.role != MemberRole.OWNER:
        raise SimlabError("PERMISSION_DENIED", "只有实验所有者可以删除实验", status_code=403)
    if settings.RUNTIME_MODE == "runtime_real" and isinstance(experiment.document_json, dict):
        from apps.experiments.desktop_network import sync_experiment_network

        try:
            sync_experiment_network(
                experiment, {"devices": [], "cables": []}, command.id
            )
        except HostAgentClientError as error:
            raise SimlabError(
                error.code,
                f"归档前断开 Cloud/虚拟网卡失败：{error.message}；请检查 Host Agent 后重试",
                status_code=503, retryable=error.retryable,
            ) from error
    experiment.status = "ARCHIVED"
    experiment.save(update_fields=("status", "updated_at"))
    return {"experiment_id": str(experiment.id), "archived": True}


def _require_experiment_owner(command: Command, experiment: Experiment) -> None:
    """要求命令执行者是实验所有者。"""
    membership = require_member(command.actor, experiment, write=True)
    if membership.role != MemberRole.OWNER:
        raise SimlabError("PERMISSION_DENIED", "只有实验所有者可以管理成员", status_code=403)


def _set_experiment_member(command: Command, experiment: Experiment) -> dict[str, object]:
    """由所有者添加或修改实验成员权限。"""
    _require_experiment_owner(command, experiment)
    username = str(command.payload.get("username", "")).strip()
    role = str(command.payload.get("role", "")).upper()
    if role not in {MemberRole.EDITOR, MemberRole.VIEWER}:
        raise SimlabError("MEMBER_ROLE_INVALID", "成员权限只能是 EDITOR 或 VIEWER")
    user = get_user_model().objects.filter(username=username, is_active=True).first()
    if user is None:
        raise SimlabError("USER_NOT_FOUND", "指定账户不存在", status_code=404)
    if user.pk == experiment.owner_id:
        raise SimlabError("OWNER_ROLE_IMMUTABLE", "不能修改实验所有者权限", status_code=409)
    membership, _ = ExperimentMember.objects.update_or_create(
        experiment=experiment,
        user=user,
        defaults={"role": role},
    )
    return {"user_id": user.pk, "username": user.get_username(), "role": membership.role}


def _remove_experiment_member(command: Command, experiment: Experiment) -> dict[str, object]:
    """由所有者移除非 OWNER 成员。"""
    _require_experiment_owner(command, experiment)
    try:
        user_id = int(command.payload.get("user_id", 0))
    except (TypeError, ValueError) as error:
        raise SimlabError("USER_ID_INVALID", "用户 ID 无效") from error
    membership = ExperimentMember.objects.filter(experiment=experiment, user_id=user_id).first()
    if membership is None:
        raise SimlabError("MEMBER_NOT_FOUND", "实验成员不存在", status_code=404)
    if membership.role == MemberRole.OWNER:
        raise SimlabError("OWNER_REMOVE_FORBIDDEN", "不能移除实验所有者", status_code=409)
    membership.delete()
    return {"user_id": user_id, "removed": True}


HANDLERS: dict[str, Callable[[Command, Experiment], dict[str, object]]] = {
    "experiment.document.save": _save_experiment_document,
    "experiment.archive": _archive_experiment,
    "experiment.member.set": _set_experiment_member,
    "experiment.member.remove": _remove_experiment_member,
    "device.create": _create_device,
    "device.update": _update_device,
    "device.delete": _delete_device,
    "device.move": _move_device,
    "device.power_on": _set_power,
    "device.shutdown": _set_power,
    "device.force_off": _set_power,
    "device.restart": _set_power,
    "device.reset": _set_power,
    "cable.connect": _connect_cable,
    "cable.disconnect": _disconnect_cable,
    "snapshot.create_cold": _create_snapshot,
}


@transaction.atomic
def execute_command(command_id: UUID) -> Command:
    """在单实验锁内执行命令并记录实际或开发模式结果。"""
    command = (
        Command.objects.select_for_update().select_related("experiment", "actor").get(pk=command_id)
    )
    if command.status in (Command.Status.SUCCEEDED, Command.Status.FAILED):
        return command
    experiment = Experiment.objects.select_for_update().get(pk=command.experiment_id)
    if command.expected_config_revision != experiment.config_revision:
        command.status = Command.Status.FAILED
        command.error = SimlabError(
            "CONFIG_REVISION_CONFLICT", "执行前配置版本已变更", status_code=409
        ).as_dict()
    else:
        command.status = Command.Status.RUNNING
        command.started_at = timezone.now()
        command.save(update_fields=("status", "started_at"))
        try:
            handler = HANDLERS.get(command.type)
            if handler is None:
                raise SimlabError("COMMAND_NOT_IMPLEMENTED", "该命令尚无执行器")
            result = handler(command, experiment)
        except SimlabError as error:
            command.status = Command.Status.FAILED
            command.error = error.as_dict()
        else:
            if command.type in CONFIGURING_COMMANDS:
                experiment.config_revision += 1
                experiment.save(update_fields=("config_revision", "updated_at"))
            command.status = Command.Status.SUCCEEDED
            command.result = {
                **command.result,
                **result,
                "config_revision": experiment.config_revision,
            }
    command.completed_at = timezone.now()
    command.save(update_fields=("status", "result", "error", "completed_at"))
    append_event(
        experiment,
        "command.succeeded" if command.status == Command.Status.SUCCEEDED else "command.failed",
        {
            "command_id": str(command.id),
            "type": command.type,
            "result": command.result,
            "error": command.error,
        },
        command,
    )
    return command
