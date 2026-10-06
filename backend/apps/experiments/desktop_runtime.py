# -*- coding: utf-8 -*-
"""本机桌面虚拟机资源池、绑定和受控创建服务。"""

from __future__ import annotations

import re
import uuid
from urllib.parse import urlencode

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from apps.experiments.models import (
    Experiment,
    ExternalRuntimeBinding,
    ExternalRuntimeCommand,
    RuntimeUnit,
    RuntimeImage,
    VirtualRuntimeInstance,
)
from apps.experiments.services import SimlabError
from apps.experiments.vendor_image_catalog import discover_vendor_images
from runtime.real_client import HostAgentClientError, RealRuntimeClient, RuntimeTarget

DESKTOP_DEVICE_TYPES = frozenset({"pc", "laptop"})
NETWORK_DEVICE_TYPES = frozenset({"switch", "l3switch", "router", "firewall"})
RUNTIME_DEVICE_TYPES = DESKTOP_DEVICE_TYPES | NETWORK_DEVICE_TYPES
APPLIANCE_PROFILES = {
    "linux-switch-profile-v1": ("switch", ("switch", "l3switch")),
    "linux-router-profile-v1": ("router", ("router",)),
    "linux-firewall-profile-v1": ("firewall", ("firewall",)),
}
DESKTOP_FRONTEND_ID_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$"
DESKTOP_POOL_EXPERIMENT_ID = uuid.uuid5(uuid.NAMESPACE_URL, "simlab:desktop-runtime-pool")
DESKTOP_PROFILE_RELEASE_ID = "linux-cloud-profile-v1"
DESKTOP_IMAGE_RELEASE = "ubuntu-noble-20260725"
DESKTOP_MEMORY_MIN_MIB = 512
DESKTOP_MEMORY_MAX_MIB = 4096
DESKTOP_VCPU_MIN = 1
DESKTOP_VCPU_MAX = 4
DESKTOP_DISK_MIN_GIB = 4
DESKTOP_DISK_MAX_GIB = 32
APPLIANCE_MEMORY_MAX_MIB = 16_384
APPLIANCE_VCPU_MAX = 8
APPLIANCE_DISK_MAX_GIB = 64
APPLIANCE_NIC_MAX = 32
DESKTOP_HOSTNAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,61}[a-z0-9]?$", re.IGNORECASE)
DESKTOP_IPV4_FIRST_HOST = 10
DESKTOP_IPV4_LAST_HOST = 250
VNC_TOKEN_SALT = "simlab.desktop-vnc"
CONSOLE_TOKEN_SALT = "simlab.runtime-console"


def _runtime_client() -> RealRuntimeClient:
    """构造真实 Runtime 客户端。"""
    return RealRuntimeClient(settings.HOST_AGENT_SOCKET, settings.HOST_AGENT_TIMEOUT_SECONDS)


def _runtime_target(instance: VirtualRuntimeInstance) -> RuntimeTarget:
    """从持久资源身份生成 Host Agent 目标。"""
    return RuntimeTarget(instance.experiment_id, instance.unit_id, instance.generation)


def _operation_id(command: ExternalRuntimeCommand, label: str) -> uuid.UUID:
    """为命令子步骤生成稳定 operation_id。"""
    return uuid.uuid5(command.id, label)


def _start_command(
    command_type: str,
    payload: dict[str, object],
    *,
    domain_name: str = "",
    frontend_device_id: str = "",
) -> ExternalRuntimeCommand:
    """创建并启动一条桌面 Runtime 审计命令。"""
    command = ExternalRuntimeCommand.objects.create(
        domain_name=domain_name,
        frontend_device_id=frontend_device_id,
        type=command_type,
        payload=payload,
        status=ExternalRuntimeCommand.Status.RUNNING,
        started_at=timezone.now(),
    )
    return command


def _complete_command(command: ExternalRuntimeCommand, result: dict[str, object]) -> None:
    """持久化成功命令结果。"""
    command.status = ExternalRuntimeCommand.Status.SUCCEEDED
    command.result = result
    command.completed_at = timezone.now()
    command.save(update_fields=("status", "result", "completed_at"))


def _fail_command(
    command: ExternalRuntimeCommand,
    code: str,
    message: str,
    *,
    retryable: bool = False,
) -> None:
    """持久化失败命令结果。"""
    command.status = ExternalRuntimeCommand.Status.FAILED
    command.error = {"code": code, "message": message, "retryable": retryable}
    command.completed_at = timezone.now()
    command.save(update_fields=("status", "error", "completed_at"))


def _raise_runtime_error(command: ExternalRuntimeCommand, error: HostAgentClientError) -> None:
    """记录 Host Agent 错误并转换成稳定领域错误。"""
    _fail_command(command, error.code, error.message, retryable=error.retryable)
    raise SimlabError(
        error.code,
        error.message,
        status_code=503,
        retryable=error.retryable,
    ) from error


def _external_target(domain_name: str) -> tuple[uuid.UUID, uuid.UUID]:
    """为白名单外部 domain 生成不可由浏览器指定的稳定身份。"""
    experiment_id = uuid.uuid5(uuid.NAMESPACE_URL, "simlab:external-desktop-pool")
    unit_id = uuid.uuid5(uuid.NAMESPACE_URL, f"simlab:external-domain:{domain_name}")
    return experiment_id, unit_id


@transaction.atomic
def ensure_external_runtime_instances() -> list[VirtualRuntimeInstance]:
    """把节点配置中允许的已有 domain 投影到虚拟机资源池。"""
    instances: list[VirtualRuntimeInstance] = []
    configured: dict[str, list[str]] = {
        domain_name: ["pc", "laptop"] for domain_name in settings.DESKTOP_EXTERNAL_DOMAINS
    }
    for entry in settings.NETWORK_EXTERNAL_DOMAINS:
        domain_name, separator, device_type = entry.partition(":")
        if (
            not separator or device_type not in NETWORK_DEVICE_TYPES
            or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", domain_name)
        ):
            raise SimlabError(
                "EXTERNAL_DOMAIN_CONFIG_INVALID",
                "网络设备已有虚拟机白名单配置无效；请检查 "
                "SIMLAB_NETWORK_EXTERNAL_DOMAINS，使用 domain:switch、domain:l3switch、"
                "domain:router 或 domain:firewall 格式。",
                status_code=503,
            )
        configured[domain_name] = [device_type]
    for domain_name, compatible_types in configured.items():
        experiment_id, unit_id = _external_target(domain_name)
        instance = VirtualRuntimeInstance.objects.filter(domain_name=domain_name).first()
        if instance is None:
            instance = VirtualRuntimeInstance.objects.create(
                id=uuid.uuid5(uuid.NAMESPACE_URL, f"simlab:desktop-instance:{domain_name}"),
                source=VirtualRuntimeInstance.Source.EXTERNAL,
                domain_name=domain_name,
                experiment_id=experiment_id,
                unit_id=unit_id,
                generation=1,
                profile_release_id="external-libvirt-domain",
                image_release="host-existing",
                compatible_device_types=compatible_types,
                provision_state=VirtualRuntimeInstance.ProvisionState.READY,
            )
        if not instance.frontend_device_id and instance.compatible_device_types != compatible_types:
            instance.compatible_device_types = compatible_types
            instance.save(update_fields=("compatible_device_types", "updated_at"))
        legacy = ExternalRuntimeBinding.objects.filter(domain_name=domain_name).first()
        if legacy is not None and (
            instance.frontend_device_id != legacy.frontend_device_id
            or instance.model_id != legacy.model_id
            or instance.display_name != legacy.display_name
        ):
            instance.frontend_device_id = legacy.frontend_device_id
            instance.model_id = legacy.model_id
            instance.display_name = legacy.display_name
            instance.observed_json = legacy.observed_json
            instance.save(
                update_fields=(
                    "frontend_device_id",
                    "model_id",
                    "display_name",
                    "observed_json",
                    "updated_at",
                )
            )
        elif legacy is None and instance.frontend_device_id:
            instance.frontend_device_id = None
            instance.bound_experiment = None
            instance.model_id = ""
            instance.display_name = ""
            instance.save(
                update_fields=(
                    "frontend_device_id", "bound_experiment", "model_id", "display_name",
                    "updated_at",
                )
            )
        instances.append(instance)
    return instances


def _observe_instance(instance: VirtualRuntimeInstance) -> dict[str, object]:
    """通过 Host Agent 读取一个资源池实例。"""
    client = _runtime_client()
    operation_id = uuid.uuid4()
    target = _runtime_target(instance)
    if instance.source == VirtualRuntimeInstance.Source.EXTERNAL:
        assert instance.domain_name is not None
        observation = client.bind_external(operation_id, target, instance.domain_name)
    else:
        observation = client.observe(operation_id, target)
    instance.domain_name = str(observation.get("domain_name") or instance.domain_name or "") or None
    previous_network_ports = instance.observed_json.get("network_ports")
    if isinstance(previous_network_ports, dict):
        interfaces = {
            str(item.get("port_alias")): item
            for item in observation.get("interfaces", [])
            if isinstance(item, dict) and item.get("port_alias")
        }
        reconciled = {}
        for key, mapping in previous_network_ports.items():
            if not isinstance(mapping, dict):
                continue
            actual = interfaces.get(str(mapping.get("runtime_alias")), {})
            status = str(mapping.get("status", "UNKNOWN"))
            expected_bridge = str(mapping.get("bridge", ""))
            if observation.get("power_state") == "RUNNING":
                if status == "WIRED" and (
                    actual.get("link_state") == "DOWN" or
                    (actual.get("ovs_bridge") is not None and actual.get("ovs_bridge") != expected_bridge)
                ):
                    status = "DRIFTED"
            elif status == "WIRED":
                status = "PENDING_POWER_ON"
            reconciled[key] = {**mapping, "status": status}
        observation["network_ports"] = reconciled
    instance.observed_json = observation
    instance.provision_state = VirtualRuntimeInstance.ProvisionState.READY
    instance.save(update_fields=("domain_name", "observed_json", "provision_state", "updated_at"))
    return observation


def refresh_runtime_inventory() -> list[VirtualRuntimeInstance]:
    """同步外部清单并逐台刷新实际电源和 VNC 状态。"""
    ensure_external_runtime_instances()
    instances = list(VirtualRuntimeInstance.objects.all())
    for instance in instances:
        try:
            instance.refresh_from_db()
            previous_power_state = str(instance.observed_json.get("power_state", "UNKNOWN")).upper()
            observation = _observe_instance(instance)
            power_state = str(observation.get("power_state", "UNKNOWN")).upper()
            # 新绑定的关机域必须保持绑定，才能由前端完成首次开机。
            # 手动关机会在 Command 中解绑；这里仅处理宿主机侧发生的运行→关机变化。
            if (
                instance.frontend_device_id
                and previous_power_state == "RUNNING"
                and power_state in {"STOPPED", "SHUTOFF", "OFF"}
            ):
                unbind_runtime_instance(instance.id)
                instance.refresh_from_db()
            elif (
                instance.frontend_device_id
                and power_state == "RUNNING"
                and instance.bound_experiment_id
                and (
                    previous_power_state != "RUNNING"
                    or any(
                        isinstance(port, dict) and port.get("status") == "DRIFTED"
                        for port in (observation.get("network_ports") or {}).values()
                    )
                )
            ):
                from apps.experiments.desktop_network import sync_experiment_network

                sync_experiment_network(
                    instance.bound_experiment,
                    instance.bound_experiment.document_json or {},
                    uuid.uuid4(),
                )
                instance.refresh_from_db()
        except HostAgentClientError as error:
            observed = dict(instance.observed_json)
            observed["error"] = {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            }
            observed["source"] = "unavailable"
            observed["quality"] = "real_runtime"
            instance.observed_json = observed
            instance.save(update_fields=("observed_json", "updated_at"))
    return instances


def _vnc_token(instance_id: uuid.UUID) -> str:
    """签发不暴露 VNC 端口的确定性代理令牌。"""
    return signing.Signer(salt=VNC_TOKEN_SALT).sign(str(instance_id))


def verify_vnc_token(instance_id: uuid.UUID, token: str) -> bool:
    """验证 VNC WebSocket 请求与资源 ID 一致。"""
    try:
        value = signing.Signer(salt=VNC_TOKEN_SALT).unsign(token)
    except signing.BadSignature:
        return False
    return value == str(instance_id)


def issue_runtime_console_ticket(
    instance: VirtualRuntimeInstance, user_id: int, device_id: str
) -> str:
    """为一台已开机且已绑定的设备签发 60 秒串口握手地址。"""
    if instance.frontend_device_id != device_id or not instance.bound_experiment_id:
        raise SimlabError("CONSOLE_DEVICE_MISMATCH", "设备与虚拟机绑定不匹配；请刷新资源池。", status_code=409)
    if instance.provision_state != VirtualRuntimeInstance.ProvisionState.READY:
        raise SimlabError("CONSOLE_NOT_READY", "虚拟机尚未就绪；请稍后刷新状态。", status_code=409)
    if instance.observed_json.get("power_state") != "RUNNING":
        raise SimlabError("CONSOLE_POWER_OFF", "设备未开机；请先在实验中开机。", status_code=409)
    token = signing.dumps(
        {"runtime_id": str(instance.id), "user_id": user_id, "device_id": device_id},
        salt=CONSOLE_TOKEN_SALT,
    )
    return f"/ws/runtime-console/{instance.id}/?{urlencode({'token': token})}"


def verify_runtime_console_token(
    instance_id: uuid.UUID, user_id: int, device_id: str, token: str
) -> bool:
    """令牌绑定到登录用户、资源和设备，超过 60 秒不可用于新连接。"""
    try:
        payload = signing.loads(token, salt=CONSOLE_TOKEN_SALT, max_age=60)
    except (signing.BadSignature, signing.SignatureExpired):
        return False
    return payload == {
        "runtime_id": str(instance_id), "user_id": user_id, "device_id": device_id,
    }


def _novnc_url(instance: VirtualRuntimeInstance) -> str:
    """生成只指向受控 WebSocket 中继的 noVNC 页面 URL。"""
    observation = instance.observed_json
    vnc = observation.get("vnc", {})
    vnc_port = vnc.get("port", -1) if isinstance(vnc, dict) else -1
    if (
        not instance.frontend_device_id
        or observation.get("power_state") != "RUNNING"
        or not isinstance(vnc_port, int)
        or vnc_port < 1
    ):
        return ""
    # vnc.html 使用 URL(path, location.href)；必须以 / 开头，避免被解析成 /novnc/ws/…。
    websocket_path = f"/ws/runtime-vnc/{instance.id}/?token={_vnc_token(instance.id)}"
    query = urlencode(
        {
            "autoconnect": "1",
            "reconnect": "1",
            "reconnect_delay": "1000",
            "resize": "scale",
            "path": websocket_path,
        }
    )
    return f"{settings.DESKTOP_NOVNC_BASE_URL}?{query}"


def runtime_instance_json(instance: VirtualRuntimeInstance) -> dict[str, object]:
    """生成前端虚拟机资源池条目。"""
    observation = instance.observed_json
    aliases = instance.desired_json.get("nic_aliases") or [
        str(item.get("port_alias", "")) for item in (observation.get("interfaces") or [])
        if isinstance(item, dict) and item.get("port_alias")
    ]
    port_keys = instance.desired_json.get("frontend_port_keys", [])
    observed_interfaces = {
        str(item.get("port_alias")): item for item in (observation.get("interfaces") or [])
        if isinstance(item, dict) and item.get("port_alias")
    }
    port_bindings = [
        {
            "frontend_port_key": key,
            "runtime_alias": alias,
            "mac_address": observed_interfaces.get(alias, {}).get("mac_address", ""),
            "tap": observed_interfaces.get(alias, {}).get("target", ""),
            "network_status": (observation.get("network_ports") or {}).get(key, {}).get("status", "UNWIRED"),
            "network_bridge": (observation.get("network_ports") or {}).get(key, {}).get("bridge", ""),
        }
        for key, alias in zip(port_keys, aliases, strict=False)
    ] if instance.frontend_device_id else []
    return {
        "id": str(instance.id),
        "source_type": instance.source,
        "managed": instance.source == VirtualRuntimeInstance.Source.MANAGED,
        "domain_name": instance.domain_name,
        "bound_device_id": instance.frontend_device_id,
        "model_id": instance.model_id or None,
        "display_name": instance.display_name or None,
        "compatible_device_types": instance.compatible_device_types,
        "profile_release_id": instance.profile_release_id,
        "image_release": instance.image_release,
        "resource_config": instance.desired_json,
        "available_nic_aliases": aliases,
        "port_bindings": port_bindings,
        "provision_state": instance.provision_state,
        "power_state": observation.get("power_state", "UNKNOWN"),
        "vnc": observation.get("vnc", {}),
        "novnc_url": _novnc_url(instance),
        "source": observation.get("source", "configured"),
        "quality": observation.get("quality", "real_runtime"),
        "error": observation.get("error"),
    }


def runtime_inventory_json(*, refresh: bool = True) -> dict[str, object]:
    """生成资源池、可创建镜像和参数边界。"""
    instances = (
        refresh_runtime_inventory() if refresh else list(VirtualRuntimeInstance.objects.all())
    )
    registered_folders = set(RuntimeImage.objects.exclude(source_folder="").values_list(
        "source_folder", "vendor_id", "appliance_role"
    ))
    try:
        vendor_candidates = discover_vendor_images()
        vendor_scan_error = None
    except OSError:
        vendor_candidates = []
        vendor_scan_error = {
            "code": "IMAGE_DIRECTORY_UNREADABLE",
            "message": "无法读取厂商镜像目录；请检查 API 用户的目录权限并刷新资源池。",
        }
    return {
        "success": True,
        "available": True,
        "instances": [runtime_instance_json(instance) for instance in instances],
        "vendor_image_candidates": [
            {**candidate, "registered": (
                candidate["folder"], candidate["vendor_id"], candidate["appliance_role"]
            ) in registered_folders}
            for candidate in vendor_candidates
        ],
        "vendor_image_scan_error": vendor_scan_error,
        "profiles": [
            {
                "profile_release_id": DESKTOP_PROFILE_RELEASE_ID,
                "image_release": DESKTOP_IMAGE_RELEASE,
                "display_name": "Ubuntu 24.04 LTS 教学桌面",
                "device_types": ["pc", "laptop"],
                "limits": {
                    "memory_mib": [DESKTOP_MEMORY_MIN_MIB, DESKTOP_MEMORY_MAX_MIB],
                    "vcpu_count": [DESKTOP_VCPU_MIN, DESKTOP_VCPU_MAX],
                    "disk_gib": [DESKTOP_DISK_MIN_GIB, DESKTOP_DISK_MAX_GIB],
                },
                "defaults": {"memory_mib": 2048, "vcpu_count": 2, "disk_gib": 16},
                "capabilities": {
                    "nic_models": ["virtio", "e1000"],
                    "nic_count": [1, 8],
                    "gpu_models": ["virtio"],
                },
            },
            *[
                {
                    "profile_release_id": next(
                        profile_id for profile_id, (role, _types) in APPLIANCE_PROFILES.items()
                        if role == image.appliance_role
                    ),
                    "image_release": image.image_release,
                    "display_name": f"已导入：{image.display_name}",
                    "vendor_id": image.vendor_id,
                    "model_id": image.model_id,
                    "source_folder": image.source_folder,
                    "device_types": ["switch", "l3switch"] if image.appliance_role == "switch"
                        else [image.appliance_role],
                    "appliance_role": image.appliance_role,
                    "limits": {
                        "memory_mib": [DESKTOP_MEMORY_MIN_MIB, APPLIANCE_MEMORY_MAX_MIB],
                        "vcpu_count": [DESKTOP_VCPU_MIN, APPLIANCE_VCPU_MAX],
                        "disk_gib": [max(DESKTOP_DISK_MIN_GIB,
                                     (image.virtual_size_bytes + 1024**3 - 1) // 1024**3),
                                     APPLIANCE_DISK_MAX_GIB],
                    },
                    "defaults": {
                        "memory_mib": 2048, "vcpu_count": 2,
                        "disk_gib": max(16, (image.virtual_size_bytes + 1024**3 - 1) // 1024**3),
                    },
                    "capabilities": {
                        "nic_models": ["virtio", "e1000"],
                        "nic_count": [1, APPLIANCE_NIC_MAX],
                        "gpu_models": ["virtio"],
                    },
                }
                for image in RuntimeImage.objects.all()
            ],
        ],
        "quality": "real_runtime",
    }


def _bounded_integer(payload: dict[str, object], key: str, minimum: int, maximum: int) -> int:
    """读取前端资源整数并执行双端一致的边界校验。"""
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise SimlabError("RUNTIME_SPEC_INVALID", f"{key} 必须是 {minimum} 到 {maximum} 的整数")
    return value


def _validate_binding_payload(payload: dict[str, object]) -> tuple[str, str, str, str]:
    """校验前端设备身份与可绑定类型。"""
    device_id = str(payload.get("device_id", "")).strip()
    model_id = str(payload.get("model_id", "")).strip()
    display_name = str(payload.get("display_name", "")).strip()
    device_type = str(payload.get("device_type", "")).strip()
    if not re.fullmatch(DESKTOP_FRONTEND_ID_PATTERN, device_id):
        raise SimlabError("INVALID_DEVICE_ID", "前端设备 ID 格式无效")
    if not model_id or len(model_id) > 80:
        raise SimlabError("INVALID_MODEL_ID", "设备型号格式无效")
    if not display_name or len(display_name) > 120:
        raise SimlabError("INVALID_DEVICE_NAME", "设备名称长度必须为 1 到 120 个字符")
    if device_type not in RUNTIME_DEVICE_TYPES:
        raise SimlabError("MODEL_NOT_BINDABLE", "当前设备类型不支持绑定后端虚拟机")
    return device_id, model_id, display_name, device_type


def _frontend_port_keys(payload: dict[str, object], aliases: list[str]) -> list[str]:
    """把前端实体网口逐个映射到稳定的虚拟网卡别名。"""
    keys = payload.get("port_keys", aliases)
    if (
        not isinstance(keys, list)
        or len(keys) != len(aliases)
        or any(
            not isinstance(key, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,63}", key)
            for key in keys
        )
        or len(set(keys)) != len(keys)
    ):
        raise SimlabError(
            "NIC_PORT_MAPPING_INVALID",
            "前端网口与虚拟网卡未能一一对应；请检查模块端口名和虚拟网卡数量",
            status_code=409,
        )
    return keys


def _allocate_ipv4() -> str:
    """从桌面资源池网段分配不与实验 Runtime 重复的 IPv4。"""
    used_addresses = {
        str(address) for address in RuntimeUnit.objects.values_list("ipv4_address", flat=True)
    }
    for desired in VirtualRuntimeInstance.objects.filter(
        source=VirtualRuntimeInstance.Source.MANAGED
    ).values_list("desired_json", flat=True):
        if isinstance(desired, dict) and desired.get("ipv4_address"):
            used_addresses.add(str(desired["ipv4_address"]))
    for host_number in range(DESKTOP_IPV4_FIRST_HOST, DESKTOP_IPV4_LAST_HOST + 1):
        candidate = f"10.88.0.{host_number}"
        if candidate not in used_addresses:
            return candidate
    raise SimlabError("RUNTIME_ADDRESS_EXHAUSTED", "桌面虚拟机地址池已用尽", status_code=409)


def _bind_instance(
    instance: VirtualRuntimeInstance,
    device_id: str,
    model_id: str,
    display_name: str,
    device_type: str,
    experiment: Experiment | None = None,
    port_keys: list[str] | None = None,
) -> None:
    """执行一对一绑定并同步旧 G0 投影。"""
    if device_type not in instance.compatible_device_types:
        raise SimlabError("RUNTIME_INCOMPATIBLE", "该虚拟机与所选设备类型不兼容")
    if instance.frontend_device_id and instance.frontend_device_id != device_id:
        raise SimlabError("RUNTIME_ALREADY_BOUND", "该虚拟机已绑定其他前端设备", status_code=409)
    if experiment is not None and instance.owner_user_id not in (None, experiment.owner_id):
        raise SimlabError("RUNTIME_NOT_OWNED", "该虚拟机属于其他账户", status_code=403)
    previous_instances = list(
        VirtualRuntimeInstance.objects.filter(frontend_device_id=device_id).exclude(pk=instance.pk)
    )
    if experiment is not None and any(
        previous.bound_experiment_id != experiment.id for previous in previous_instances
    ):
        raise SimlabError("RUNTIME_BINDING_CONFLICT", "设备 ID 已被其他实验占用", status_code=409)
    for previous in previous_instances:
        _clear_instance_binding(previous)
    instance.frontend_device_id = device_id
    instance.bound_experiment = experiment
    if experiment is not None and instance.source == VirtualRuntimeInstance.Source.MANAGED:
        instance.owner_user = experiment.owner
    instance.model_id = model_id
    instance.display_name = display_name
    instance.desired_json = {
        **instance.desired_json,
        "frontend_port_keys": port_keys or [],
    }
    instance.save(
        update_fields=(
            "frontend_device_id", "bound_experiment", "owner_user", "model_id",
            "display_name", "desired_json", "updated_at",
        )
    )
    if instance.source == VirtualRuntimeInstance.Source.EXTERNAL and instance.domain_name:
        ExternalRuntimeBinding.objects.update_or_create(
            domain_name=instance.domain_name,
            defaults={
                "frontend_device_id": device_id,
                "model_id": model_id,
                "display_name": display_name,
                "observed_json": instance.observed_json,
            },
        )


def _clear_instance_binding(instance: VirtualRuntimeInstance) -> str | None:
    """清除一台虚拟机的前端投影并返回原设备 ID。"""
    frontend_device_id = instance.frontend_device_id
    instance.frontend_device_id = None
    instance.bound_experiment = None
    instance.model_id = ""
    instance.display_name = ""
    instance.desired_json = {key: value for key, value in instance.desired_json.items()
                             if key != "frontend_port_keys"}
    instance.save(
        update_fields=(
            "frontend_device_id", "bound_experiment", "model_id", "display_name",
            "desired_json", "updated_at",
        )
    )
    if instance.source == VirtualRuntimeInstance.Source.EXTERNAL and instance.domain_name:
        ExternalRuntimeBinding.objects.filter(domain_name=instance.domain_name).delete()
    return frontend_device_id


def _isolate_bound_ports(
    instance: VirtualRuntimeInstance, command: ExternalRuntimeCommand, label: str
) -> None:
    """解绑前把持久 libvirt 虚拟网卡载波置为 down。"""
    aliases = instance.desired_json.get("nic_aliases") or [
        item.get("port_alias") for item in instance.observed_json.get("interfaces", [])
        if isinstance(item, dict) and item.get("port_alias")
    ]
    keys = instance.desired_json.get("frontend_port_keys") or aliases
    network_ports = dict(instance.observed_json.get("network_ports") or {})
    for key, alias in zip(keys, aliases, strict=False):
        observed = _runtime_client().wire_port(
            _operation_id(command, f"{label}:{alias}"), _runtime_target(instance),
            str(alias), uuid.uuid5(instance.id, f"isolated:{alias}"), up=False,
            domain_name=instance.domain_name
            if instance.source == VirtualRuntimeInstance.Source.EXTERNAL else None,
        )
        network_ports[str(key)] = {"runtime_alias": alias, "status": "DISCONNECTED", "bridge": ""}
        instance.observed_json = {
            **observed, "network_ports": network_ports,
        }
        instance.save(update_fields=("observed_json", "updated_at"))


def bind_runtime_instance(
    instance_id: uuid.UUID, payload: dict[str, object], experiment: Experiment | None = None
) -> VirtualRuntimeInstance:
    """把已有虚拟机绑定到前端 PC 或笔记本。"""
    device_id, model_id, display_name, device_type = _validate_binding_payload(payload)
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    expected_aliases = payload.get("nic_aliases", ["eth0"])
    if (
        not isinstance(expected_aliases, list)
        or not 1 <= len(expected_aliases) <= (
            APPLIANCE_NIC_MAX if device_type in NETWORK_DEVICE_TYPES else 8
        )
        or expected_aliases != [f"eth{index}" for index in range(len(expected_aliases))]
    ):
        raise SimlabError("NIC_PORTS_INVALID", "设备网口必须从 eth0 连续编号并符合当前设备限额")
    if (
        not instance.desired_json.get("nic_aliases")
        and not instance.observed_json.get("interfaces")
    ):
        try:
            _observe_instance(instance)
        except HostAgentClientError as error:
            _raise_runtime_error(error)
    actual_aliases = instance.desired_json.get("nic_aliases")
    if not actual_aliases:
        actual_aliases = [
            str(item.get("port_alias"))
            for item in instance.observed_json.get("interfaces", [])
            if isinstance(item, dict) and item.get("port_alias")
        ]
    # 兼容旧版 Host Agent：其观测只有首张 TAP/MAC，没有 interfaces 数组。
    # 只在实际观测到 TAP 与 MAC 时认定为单网卡 eth0，不推断额外网卡。
    if (
        not actual_aliases
        and instance.observed_json.get("tap")
        and instance.observed_json.get("mac_address")
    ):
        actual_aliases = ["eth0"]
    if not actual_aliases:
        raise SimlabError(
            "NIC_INVENTORY_UNAVAILABLE",
            "无法读取虚拟机网口清单；刷新虚拟机资源池状态后再绑定",
            status_code=409,
        )
    if actual_aliases and list(actual_aliases) != list(expected_aliases):
        raise SimlabError(
            "NIC_PORTS_MISMATCH",
            f"虚拟机网口为 {', '.join(actual_aliases)}，设备模块要求 {', '.join(expected_aliases)}；请选择接口数量匹配的虚拟机",
            status_code=409,
        )
    port_keys = _frontend_port_keys(payload, expected_aliases)
    command = _start_command(
        "runtime.bind",
        payload,
        domain_name=instance.domain_name or "",
        frontend_device_id=device_id,
    )
    try:
        if instance.frontend_device_id and instance.frontend_device_id != device_id:
            raise SimlabError("RUNTIME_ALREADY_BOUND", "该虚拟机已绑定其他前端设备", status_code=409)
        if device_type not in instance.compatible_device_types:
            raise SimlabError("RUNTIME_INCOMPATIBLE", "该虚拟机与设备类型不兼容")
        previous_instances = VirtualRuntimeInstance.objects.filter(
            frontend_device_id=device_id
        ).exclude(pk=instance.pk)
        if experiment is not None and (
            instance.owner_user_id not in (None, experiment.owner_id)
            or any(previous.bound_experiment_id != experiment.id for previous in previous_instances)
        ):
            raise SimlabError("RUNTIME_BINDING_CONFLICT", "设备或虚拟机属于其他实验", status_code=409)
        for previous in previous_instances:
            previous_aliases = previous.desired_json.get("nic_aliases") or [
                item.get("port_alias") for item in previous.observed_json.get("interfaces", [])
                if isinstance(item, dict) and item.get("port_alias")
            ]
            for alias in previous_aliases:
                _runtime_client().wire_port(
                    _operation_id(command, f"release:{previous.id}:{alias}"),
                    _runtime_target(previous), str(alias),
                    uuid.uuid5(previous.id, f"isolated:{alias}"), up=False,
                    domain_name=previous.domain_name
                    if previous.source == VirtualRuntimeInstance.Source.EXTERNAL else None,
                )
        if instance.source == VirtualRuntimeInstance.Source.EXTERNAL:
            client = _runtime_client()
            network_ports = {}
            for key, alias in zip(port_keys, expected_aliases, strict=False):
                isolated_network = uuid.uuid5(instance.id, f"isolated:{alias}")
                observation = client.wire_port(
                    _operation_id(command, f"isolate:{alias}"), _runtime_target(instance),
                    alias, isolated_network, up=False, domain_name=instance.domain_name,
                )
                network_ports[key] = {
                    "runtime_alias": alias, "status": "DISCONNECTED", "bridge": "",
                }
                instance.observed_json = {**observation, "network_ports": network_ports}
                instance.save(update_fields=("observed_json", "updated_at"))
        with transaction.atomic():
            _bind_instance(instance, device_id, model_id, display_name, device_type, experiment,
                           port_keys)
        _complete_command(command, runtime_instance_json(instance))
        return instance
    except SimlabError as error:
        _fail_command(command, error.code, error.message, retryable=error.retryable)
        raise
    except HostAgentClientError as error:
        _raise_runtime_error(command, error)


def unbind_runtime_instance(instance_id: uuid.UUID) -> VirtualRuntimeInstance:
    """解除前端映射，不改变虚拟机电源。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    command = _start_command(
        "runtime.unbind",
        {"runtime_id": str(instance.id)},
        domain_name=instance.domain_name or "",
        frontend_device_id=instance.frontend_device_id or "",
    )
    if instance.frontend_device_id:
        try:
            _isolate_bound_ports(instance, command, "unbind")
        except HostAgentClientError as error:
            _raise_runtime_error(command, error)
    bound_experiment = instance.bound_experiment
    frontend_device_id = _clear_instance_binding(instance)
    result = runtime_instance_json(instance)
    result["unbound_device_id"] = frontend_device_id
    if bound_experiment is not None:
        from apps.experiments.desktop_network import sync_experiment_network

        try:
            sync_experiment_network(
                bound_experiment, bound_experiment.document_json or {},
                _operation_id(command, "peer-network"),
            )
        except HostAgentClientError as error:
            result["network_warning"] = {"code": error.code, "message": error.message}
    _complete_command(command, result)
    return instance


def provision_runtime_instance(
    payload: dict[str, object], experiment: Experiment | None = None
) -> VirtualRuntimeInstance:
    """按前端受限参数创建、定义并绑定一台后端虚拟机。"""
    device_id, model_id, display_name, device_type = _validate_binding_payload(payload)
    spec = payload.get("spec")
    if not isinstance(spec, dict):
        raise SimlabError("RUNTIME_SPEC_INVALID", "spec 必须是对象")
    profile_release_id = str(spec.get("profile_release_id", ""))
    image_release = str(spec.get("image_release", ""))
    appliance_profile = APPLIANCE_PROFILES.get(profile_release_id)
    if device_type in DESKTOP_DEVICE_TYPES:
        if profile_release_id != DESKTOP_PROFILE_RELEASE_ID:
            raise SimlabError("PROFILE_NOT_ALLOWED", "PC/笔记本必须使用已批准的桌面 Profile")
        appliance_role = "desktop"
        compatible_device_types = ["pc", "laptop"]
    elif appliance_profile is not None and device_type in appliance_profile[1]:
        appliance_role = appliance_profile[0]
        compatible_device_types = list(appliance_profile[1])
    else:
        raise SimlabError("PROFILE_NOT_ALLOWED", "设备类型与网络 Runtime Profile 不匹配")
    imported_image = None
    if image_release != DESKTOP_IMAGE_RELEASE:
        imported_image = RuntimeImage.objects.filter(image_release=image_release).first()
        if imported_image is None or imported_image.appliance_role != appliance_role:
            raise SimlabError(
                "IMAGE_NOT_ALLOWED", "镜像未经登记或与设备类型不匹配；请重新选择已导入镜像。"
            )
        if imported_image.model_id and imported_image.model_id != model_id:
            raise SimlabError(
                "IMAGE_MODEL_MISMATCH", "镜像只适用于登记的设备型号；请选择当前型号对应的镜像。",
                status_code=409,
            )
        if imported_image.vendor_id:
            from apps.experiments.vendor_image_catalog import model_catalog

            model = model_catalog().get(model_id)
            model_role = "switch" if model and model["device_type"] == "l3switch" else (
                model["device_type"] if model else None
            )
            if (model is None or model["vendor_id"] != imported_image.vendor_id or
                    model_role != appliance_role):
                raise SimlabError(
                    "IMAGE_VENDOR_MISMATCH", "镜像与设备厂商或类型不匹配；请选择该厂商同类型镜像。",
                    status_code=409,
                )
    elif appliance_role != "desktop":
        raise SimlabError(
            "IMAGE_REQUIRED", "网络设备没有默认系统镜像；请导入并选择对应厂商类型的 qcow2。",
            status_code=409,
        )
    memory_mib = _bounded_integer(
        spec, "memory_mib", DESKTOP_MEMORY_MIN_MIB,
        APPLIANCE_MEMORY_MAX_MIB if appliance_role != "desktop" else DESKTOP_MEMORY_MAX_MIB,
    )
    vcpu_count = _bounded_integer(
        spec, "vcpu_count", DESKTOP_VCPU_MIN,
        APPLIANCE_VCPU_MAX if appliance_role != "desktop" else DESKTOP_VCPU_MAX,
    )
    disk_gib = _bounded_integer(
        spec, "disk_gib", DESKTOP_DISK_MIN_GIB,
        APPLIANCE_DISK_MAX_GIB if appliance_role != "desktop" else DESKTOP_DISK_MAX_GIB,
    )
    if imported_image and disk_gib * 1024**3 < imported_image.virtual_size_bytes:
        raise SimlabError(
            "IMAGE_DISK_TOO_SMALL", "磁盘容量小于导入镜像虚拟容量；请增大磁盘后重试。"
        )
    vm_name = str(spec.get("vm_name", f"simlab-{device_id[-8:]}")).strip().lower()
    if not DESKTOP_HOSTNAME_PATTERN.fullmatch(vm_name):
        raise SimlabError("VM_NAME_INVALID", "虚拟机名称必须以字母开头，仅使用字母、数字和连字符")
    nic_model = str(spec.get("nic_model", "virtio"))
    if nic_model not in {"virtio", "e1000"}:
        raise SimlabError(
            "NIC_MODEL_NOT_ALLOWED", "当前 Runtime Profile 仅支持 virtio 或 e1000 网卡"
        )
    nic_aliases = spec.get("nic_aliases", ["eth0"])
    if (
        not isinstance(nic_aliases, list)
        or not 1 <= len(nic_aliases) <= (
            APPLIANCE_NIC_MAX if appliance_role != "desktop" else 8
        )
        or nic_aliases != [f"eth{index}" for index in range(len(nic_aliases))]
    ):
        raise SimlabError(
            "NIC_PORTS_INVALID", "虚拟网口必须从 eth0 连续命名，且数量符合 Profile 限额"
        )
    port_keys = _frontend_port_keys(payload, nic_aliases)
    gpu_model = str(spec.get("gpu_model", "virtio"))
    if gpu_model != "virtio":
        raise SimlabError(
            "GPU_MODEL_NOT_ALLOWED", "当前 Runtime Profile 仅批准 virtio 虚拟显示适配器"
        )
    instance_id = uuid.uuid4()
    desired = {
        "profile_release_id": profile_release_id,
        "image_release": image_release,
        "memory_mib": memory_mib,
        "vcpu_count": vcpu_count,
        "disk_gib": disk_gib,
        "vm_name": vm_name,
        "nic_model": nic_model,
        "nic_aliases": nic_aliases,
        "radio_nic_alias": (
            nic_aliases[port_keys.index("RADIO0")] if "RADIO0" in port_keys else ""
        ),
        "appliance_role": appliance_role,
        "gpu_model": gpu_model,
        "ipv4_address": _allocate_ipv4(),
    }
    command = _start_command(
        "runtime.provision",
        payload,
        frontend_device_id=device_id,
    )
    instance = VirtualRuntimeInstance.objects.create(
        id=instance_id,
        source=VirtualRuntimeInstance.Source.MANAGED,
        owner_user=experiment.owner if experiment is not None else None,
        experiment_id=DESKTOP_POOL_EXPERIMENT_ID,
        unit_id=instance_id,
        generation=1,
        profile_release_id=profile_release_id,
        image_release=image_release,
        compatible_device_types=compatible_device_types,
        desired_json=desired,
        provision_state=VirtualRuntimeInstance.ProvisionState.PROVISIONING,
    )
    compiled_spec = {
        "profile_release_id": profile_release_id,
        "image_release": image_release,
        "memory_mib": memory_mib,
        "vcpu_count": vcpu_count,
        "disk_gib": disk_gib,
        "ipv4_address": desired["ipv4_address"],
        "hostname": vm_name,
        "link_up": False,
        "nic_model": nic_model,
        "nic_aliases": nic_aliases,
        "radio_nic_alias": desired["radio_nic_alias"],
        "appliance_role": appliance_role,
        "gpu_model": gpu_model,
    }
    try:
        observation = _runtime_client().ensure_defined(
            _operation_id(command, "ensure-defined"),
            _runtime_target(instance),
            compiled_spec,
        )
    except HostAgentClientError as error:
        instance.provision_state = VirtualRuntimeInstance.ProvisionState.ERROR
        instance.observed_json = {
            "source": "unavailable",
            "quality": "real_runtime",
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            },
        }
        instance.save(update_fields=("provision_state", "observed_json", "updated_at"))
        _raise_runtime_error(command, error)
    instance.domain_name = str(observation["domain_name"])
    instance.observed_json = observation
    instance.provision_state = VirtualRuntimeInstance.ProvisionState.READY
    instance.save(update_fields=("domain_name", "observed_json", "provision_state", "updated_at"))
    try:
        _bind_instance(instance, device_id, model_id, display_name, device_type, experiment,
                       port_keys)
    except SimlabError as error:
        _fail_command(command, error.code, error.message, retryable=error.retryable)
        raise
    command.domain_name = instance.domain_name or ""
    command.save(update_fields=("domain_name",))
    _complete_command(command, runtime_instance_json(instance))
    return instance


def set_runtime_power(
    instance_id: uuid.UUID, frontend_device_id: str, is_on: bool
) -> VirtualRuntimeInstance:
    """控制已绑定虚拟机的实际电源。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    if instance.frontend_device_id != frontend_device_id:
        raise SimlabError("RUNTIME_BINDING_MISMATCH", "当前设备未绑定该虚拟机", status_code=409)
    command_type = "runtime.power_on" if is_on else "runtime.shutdown"
    command = _start_command(
        command_type,
        {"runtime_id": str(instance.id), "device_id": frontend_device_id, "on": is_on},
        domain_name=instance.domain_name or "",
        frontend_device_id=frontend_device_id,
    )
    client = _runtime_client()
    target = _runtime_target(instance)
    try:
        if is_on:
            observation = client.start(
                _operation_id(command, "power"),
                target,
                instance.domain_name
                if instance.source == VirtualRuntimeInstance.Source.EXTERNAL
                else None,
            )
        else:
            observation = client.shutdown(
                _operation_id(command, "power"),
                target,
                instance.domain_name
                if instance.source == VirtualRuntimeInstance.Source.EXTERNAL
                else None,
            )
    except HostAgentClientError as error:
        _raise_runtime_error(command, error)
    instance.observed_json = observation
    instance.domain_name = str(observation.get("domain_name") or instance.domain_name or "") or None
    instance.save(update_fields=("observed_json", "domain_name", "updated_at"))
    if instance.source == VirtualRuntimeInstance.Source.EXTERNAL and instance.domain_name:
        ExternalRuntimeBinding.objects.filter(domain_name=instance.domain_name).update(
            observed_json=observation
        )
    if is_on and instance.bound_experiment_id:
        from apps.experiments.desktop_network import sync_experiment_network

        try:
            sync_experiment_network(
                instance.bound_experiment,
                instance.bound_experiment.document_json or {},
                _operation_id(command, "network"),
            )
            instance.refresh_from_db()
        except HostAgentClientError as error:
            _raise_runtime_error(command, error)
    network_warning = None
    if not is_on:
        try:
            _isolate_bound_ports(instance, command, "shutdown")
        except HostAgentClientError as error:
            _raise_runtime_error(command, error)
        bound_experiment = instance.bound_experiment
        _clear_instance_binding(instance)
        if bound_experiment is not None:
            from apps.experiments.desktop_network import sync_experiment_network

            try:
                sync_experiment_network(
                    bound_experiment, bound_experiment.document_json or {},
                    _operation_id(command, "peer-network"),
                )
            except HostAgentClientError as error:
                network_warning = {"code": error.code, "message": error.message}
    result = runtime_instance_json(instance)
    if network_warning:
        result["network_warning"] = network_warning
    _complete_command(command, result)
    return instance


def release_runtime_instance(
    instance_id: uuid.UUID, frontend_device_id: str
) -> VirtualRuntimeInstance:
    """正常关闭并自动解绑一台虚拟机；已关机时只清除绑定。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    if instance.frontend_device_id != frontend_device_id:
        raise SimlabError("RUNTIME_BINDING_MISMATCH", "当前设备未绑定该虚拟机", status_code=409)
    power_state = str(instance.observed_json.get("power_state", "UNKNOWN")).upper()
    if power_state in {"STOPPED", "SHUTOFF", "OFF"}:
        return unbind_runtime_instance(instance.id)
    return set_runtime_power(instance.id, frontend_device_id, False)


def release_bound_runtime_instances(frontend_device_ids: list[str]) -> list[dict[str, object]]:
    """实验关闭时按设备 ID 精确关闭并解绑全部桌面虚拟机。"""
    if len(frontend_device_ids) > 500:
        raise SimlabError("TOO_MANY_DEVICE_IDS", "单次最多释放 500 台虚拟机")
    released: list[dict[str, object]] = []
    for frontend_device_id in dict.fromkeys(frontend_device_ids):
        if not re.fullmatch(DESKTOP_FRONTEND_ID_PATTERN, frontend_device_id):
            raise SimlabError("INVALID_DEVICE_ID", "前端设备 ID 格式无效")
        instance = VirtualRuntimeInstance.objects.filter(
            frontend_device_id=frontend_device_id
        ).first()
        if instance is None:
            continue
        released_instance = release_runtime_instance(instance.id, frontend_device_id)
        released.append(runtime_instance_json(released_instance))
    return released


def destroy_bound_runtime_instance(
    instance_id: uuid.UUID, frontend_device_id: str
) -> dict[str, object]:
    """删除前端设备时关闭、解绑并销毁其平台创建虚拟机。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    if instance.frontend_device_id != frontend_device_id:
        raise SimlabError("RUNTIME_BINDING_MISMATCH", "当前设备未绑定该虚拟机", status_code=409)
    source = instance.source
    runtime_id = str(instance.id)
    domain_name = instance.domain_name
    release_runtime_instance(instance.id, frontend_device_id)
    backend_destroyed = source == VirtualRuntimeInstance.Source.MANAGED
    if backend_destroyed:
        delete_runtime_instance(instance.id)
    return {
        "runtime_id": runtime_id,
        "domain_name": domain_name,
        "source_type": source,
        "backend_destroyed": backend_destroyed,
        "external_runtime_preserved": not backend_destroyed,
        "unbound_device_id": frontend_device_id,
    }


def delete_runtime_instance(instance_id: uuid.UUID) -> None:
    """精确删除已停止、未绑定的平台创建虚拟机。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=instance_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    if instance.source != VirtualRuntimeInstance.Source.MANAGED:
        raise SimlabError("EXTERNAL_RUNTIME_PROTECTED", "宿主机已有虚拟机不能从平台删除")
    if instance.frontend_device_id:
        raise SimlabError("RUNTIME_STILL_BOUND", "删除虚拟机前必须解除设备绑定", status_code=409)
    if instance.observed_json.get("power_state") == "RUNNING":
        raise SimlabError("RUNTIME_MUST_BE_STOPPED", "删除虚拟机前必须先关机", status_code=409)
    command = _start_command(
        "runtime.delete",
        {"runtime_id": str(instance.id)},
        domain_name=instance.domain_name or "",
    )
    try:
        result = _runtime_client().delete_unit(
            _operation_id(command, "delete-unit"), _runtime_target(instance)
        )
    except HostAgentClientError as error:
        _raise_runtime_error(command, error)
    instance.delete()
    _complete_command(command, result)
