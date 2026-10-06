# -*- coding: utf-8 -*-
"""认证、查询与统一 Command HTTP API。"""

from __future__ import annotations

import ipaddress
import re
from uuid import UUID, uuid4

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.exceptions import NotAuthenticated
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView, exception_handler

from apps.experiments.desktop_runtime import (
    bind_runtime_instance,
    delete_runtime_instance,
    destroy_bound_runtime_instance,
    issue_runtime_console_ticket,
    provision_runtime_instance,
    release_bound_runtime_instances,
    runtime_instance_json,
    runtime_inventory_json,
    set_runtime_power,
    unbind_runtime_instance,
)
from apps.experiments.image_import import import_runtime_image, register_vendor_image
from apps.experiments.models import (
    Command,
    DeviceModelRelease,
    Experiment,
    ExperimentEvent,
    ExperimentMember,
    ExperimentSnapshot,
    ExternalRuntimeBinding,
    VirtualRuntimeInstance,
)
from apps.experiments.services import (
    G0_COMMAND_BIND,
    G0_COMMAND_POWER_ON,
    G0_COMMAND_SHUTDOWN,
    G0_COMMAND_UNBIND,
    CommandEnvelope,
    SimlabError,
    create_experiment,
    execute_command,
    execute_g0_command,
    observe_g0_runtime,
    require_member,
    submit_command,
)
from apps.experiments.tasks import execute_command_task
from runtime.real_client import HostAgentClientError, RealRuntimeClient

G0_FRONTEND_DEVICE_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$")


def _require_local_g0_bridge(request: Request) -> None:
    """限制 G0 诊断桥只在显式启用且请求来自本机时使用。"""
    if not settings.G0_PC1_BRIDGE_ENABLED:
        raise SimlabError("G0_BRIDGE_DISABLED", "G0 PC1 本机桥未启用", status_code=404)
    forwarded_addresses = request.META.get("HTTP_X_FORWARDED_FOR", "")
    remote_address = (
        forwarded_addresses.split(",")[-1].strip()
        if forwarded_addresses
        else request.META.get("REMOTE_ADDR", "")
    )
    try:
        is_loopback = ipaddress.ip_address(remote_address).is_loopback
    except ValueError:
        is_loopback = False
    if not is_loopback:
        raise SimlabError("G0_BRIDGE_LOCAL_ONLY", "G0 PC1 桥仅允许本机访问", status_code=403)


def _require_local_desktop_bridge(request: Request) -> None:
    """资源池必须显式启用；身份与实验权限由 API/服务继续校验。"""
    if not settings.DESKTOP_RUNTIME_BRIDGE_ENABLED:
        raise SimlabError("DESKTOP_BRIDGE_DISABLED", "桌面虚拟机资源池未启用", status_code=404)


def _desktop_experiment(request: Request, payload: dict[str, object]) -> Experiment:
    """核对桌面虚拟机操作的服务器实验和编辑权限。"""
    try:
        experiment_id = UUID(str(payload.get("experiment_id", "")))
    except ValueError as error:
        raise SimlabError("EXP_ID_INVALID", "请先选择服务器实验") from error
    experiment = Experiment.objects.filter(pk=experiment_id).exclude(status="ARCHIVED").first()
    if experiment is None:
        raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
    require_member(request.user, experiment, write=True)
    return experiment


def _check_desktop_device(experiment: Experiment, device_id: str) -> None:
    """确认前端设备 ID 来自当前实验的新设备或已保存文档。"""
    namespace = re.sub(r"[^A-Za-z0-9]", "", str(experiment.id))[:12]
    documents = experiment.document_json if isinstance(experiment.document_json, dict) else {}
    devices = documents.get("devices", [])
    saved = isinstance(devices, list) and any(
        isinstance(item, dict) and item.get("device_id") == device_id for item in devices
    )
    if not saved and not device_id.startswith(f"dev-{namespace}-"):
        raise SimlabError("DEVICE_NOT_IN_EXPERIMENT", "设备不属于当前实验", status_code=403)


def _bound_desktop_instance(
    request: Request, runtime_id: UUID, *, write: bool = True
) -> VirtualRuntimeInstance:
    """核对绑定虚拟机所在实验的成员权限。"""
    instance = VirtualRuntimeInstance.objects.filter(pk=runtime_id).first()
    if instance is None:
        raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
    if instance.bound_experiment_id is None:
        raise SimlabError("RUNTIME_NOT_BOUND", "虚拟机未绑定当前实验", status_code=403)
    require_member(request.user, instance.bound_experiment, write=write)
    return instance


def _g0_binding_json(
    binding: ExternalRuntimeBinding | None, observation: dict[str, object]
) -> dict[str, object]:
    """生成前端所需的固定域绑定与 VNC 投影。"""
    return {
        "success": True,
        "available": True,
        "domain_name": settings.G0_PC1_DOMAIN,
        "bound_device_id": binding.frontend_device_id if binding else None,
        "model_id": binding.model_id if binding else None,
        "display_name": binding.display_name if binding else None,
        "power_state": observation.get("power_state", "UNKNOWN"),
        "vnc": observation.get("vnc", {}),
        "novnc_url": settings.G0_PC1_NOVNC_URL,
        "source": observation.get("source", "unavailable"),
        "quality": observation.get("quality", "real_runtime"),
    }


def csrf_failure(request: object, reason: str = "") -> JsonResponse:
    """将 CSRF 中间件拒绝统一为安全 JSON。"""
    return JsonResponse(
        {
            "error": {
                "code": "CSRF_FAILED",
                "message": "安全令牌已失效，请刷新页面后重试",
                "retryable": True,
            }
        },
        status=403,
    )


def simlab_exception_handler(exc: Exception, context: dict[str, object]) -> Response | None:
    """把领域与 DRF 异常转换为稳定 JSON。"""
    if isinstance(exc, SimlabError):
        return Response({"error": exc.as_dict()}, status=exc.status_code)
    if isinstance(exc, NotAuthenticated):
        return Response(
            {"error": {"code": "AUTH_REQUIRED", "message": "请先登录", "retryable": False}},
            status=status.HTTP_403_FORBIDDEN,
        )
    response = exception_handler(exc, context)
    if response is not None:
        response.data = {
            "error": {"code": "REQUEST_INVALID", "message": response.data, "retryable": False}
        }
    return response


def _experiment_json(experiment: Experiment, user: object | None = None) -> dict[str, object]:
    document = experiment.document_json if isinstance(experiment.document_json, dict) else {}
    devices = document.get("devices", [])
    cables = document.get("cables", [])
    membership = (
        experiment.members.filter(user=user).first() if user is not None else None
    )
    return {
        "id": str(experiment.id),
        "name": experiment.name,
        "owner": experiment.owner.get_username(),
        "role": membership.role if membership is not None else None,
        "mode": experiment.mode,
        "status": experiment.status,
        "config_revision": experiment.config_revision,
        "last_event_seq": experiment.last_event_seq,
        "generation": experiment.generation,
        "has_document": bool(document),
        "device_count": len(devices) if isinstance(devices, list) else 0,
        "cable_count": len(cables) if isinstance(cables, list) else 0,
        "created_at": experiment.created_at.isoformat(),
        "updated_at": experiment.updated_at.isoformat(),
    }


def _execute_experiment_command(
    request: Request,
    experiment: Experiment,
    command_type: str,
    payload: dict[str, object],
    expected_revision: int,
) -> Command:
    """经统一 Command 服务同步执行服务器实验文档操作。"""
    envelope = CommandEnvelope(uuid4(), command_type, expected_revision, payload)
    command, _ = submit_command(request.user, experiment.id, envelope)
    command = execute_command(command.id)
    if command.status == Command.Status.FAILED:
        error = command.error if isinstance(command.error, dict) else {}
        raise SimlabError(
            str(error.get("code", "COMMAND_FAILED")),
            str(error.get("message", "实验命令执行失败")),
            status_code=409,
            retryable=bool(error.get("retryable", False)),
        )
    return command


def _command_json(command: Command) -> dict[str, object]:
    return {
        "command_id": str(command.id),
        "type": command.type,
        "status": command.status,
        "config_revision": command.result.get("config_revision", command.expected_config_revision),
        "accepted_event_seq": command.result.get("accepted_event_seq"),
        "result": command.result,
        "error": command.error,
        "status_url": f"/api/v1/experiments/{command.experiment_id}/commands/{command.id}/",
    }


class LiveHealthView(APIView):
    """仅表示 HTTP 进程存活。"""

    permission_classes = (AllowAny,)

    def get(self, request: Request) -> Response:
        """返回无敏感信息的存活状态。"""
        return Response({"status": "ok"})


class ReadyHealthView(APIView):
    """检查数据库可查询。"""

    permission_classes = (AllowAny,)

    def get(self, request: Request) -> Response:
        """返回控制平面就绪状态。"""
        Experiment.objects.only("id").first()
        return Response({"status": "ready"})


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    """为 SPA 设置并返回 masked CSRF token。"""

    permission_classes = (AllowAny,)

    def get(self, request: Request) -> Response:
        """返回当前 CSRF token。"""
        return Response({"csrf_token": get_token(request._request)})


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    """使用 Django Session 登录。"""

    permission_classes = (AllowAny,)
    authentication_classes: tuple[()] = ()

    def post(self, request: Request) -> Response:
        """验证账号并建立 Session。"""
        username = str(request.data.get("username", ""))
        password = str(request.data.get("password", ""))
        user = authenticate(request._request, username=username, password=password)
        if user is None:
            return Response(
                {
                    "error": {
                        "code": "INVALID_CREDENTIALS",
                        "message": "用户名或密码错误",
                        "retryable": False,
                    }
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        login(request._request, user)
        return Response(
            {
                "user": {
                    "id": user.pk,
                    "username": user.get_username(),
                    "is_staff": user.is_staff,
                    "is_superuser": user.is_superuser,
                },
                "csrf_token": get_token(request._request),
            }
        )


class LogoutView(APIView):
    """销毁当前 Session。"""

    def post(self, request: Request) -> Response:
        """退出并返回空响应。"""
        logout(request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    """查询当前用户。"""

    def get(self, request: Request) -> Response:
        """返回最小用户信息。"""
        return Response(
            {
                "id": request.user.pk,
                "username": request.user.get_username(),
                "is_staff": request.user.is_staff,
                "is_superuser": request.user.is_superuser,
            }
        )


class ExperimentListView(APIView):
    """列出或创建当前用户可见实验。"""

    def get(self, request: Request) -> Response:
        """列出成员实验。"""
        experiments = (
            Experiment.objects.filter(members__user=request.user)
            .exclude(status="ARCHIVED")
            .select_related("owner")
            .distinct()
        )
        return Response([_experiment_json(experiment, request.user) for experiment in experiments])

    def post(self, request: Request) -> Response:
        """创建新实验。"""
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = create_experiment(request.user, str(request.data.get("name", "新实验")))
        return Response(
            _experiment_json(experiment, request.user), status=status.HTTP_201_CREATED
        )


class ExperimentDocumentView(APIView):
    """读取、保存或归档当前用户有权访问的服务器实验文档。"""

    @staticmethod
    def _experiment(experiment_id: UUID) -> Experiment:
        experiment = (
            Experiment.objects.filter(pk=experiment_id)
            .exclude(status="ARCHIVED")
            .select_related("owner")
            .first()
        )
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        return experiment

    def get(self, request: Request, experiment_id: UUID) -> Response:
        """读取服务器保存的三维实验文档。"""
        experiment = self._experiment(experiment_id)
        require_member(request.user, experiment)
        if not experiment.document_json:
            raise SimlabError("EXP_DOCUMENT_EMPTY", "实验尚未保存内容", status_code=404)
        return Response(
            {
                "experiment": _experiment_json(experiment, request.user),
                "document": experiment.document_json,
            }
        )

    def put(self, request: Request, experiment_id: UUID) -> Response:
        """通过 Command 服务覆盖保存三维实验文档。"""
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = self._experiment(experiment_id)
        try:
            expected_revision = int(request.data.get("expected_config_revision"))
        except (TypeError, ValueError) as error:
            raise SimlabError("INVALID_ENVELOPE", "expected_config_revision 无效") from error
        command = _execute_experiment_command(
            request,
            experiment,
            "experiment.document.save",
            {"document": request.data.get("document")},
            expected_revision,
        )
        experiment.refresh_from_db()
        return Response(
            {
                "experiment": _experiment_json(experiment, request.user),
                "document": experiment.document_json,
                "command": _command_json(command),
            }
        )

    def delete(self, request: Request, experiment_id: UUID) -> Response:
        """通过 Command 服务归档实验，仅所有者可执行。"""
        experiment = self._experiment(experiment_id)
        _execute_experiment_command(
            request,
            experiment,
            "experiment.archive",
            {},
            experiment.config_revision,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


def _member_json(membership: ExperimentMember) -> dict[str, object]:
    """生成不暴露敏感账户字段的实验成员摘要。"""
    return {
        "user_id": membership.user_id,
        "username": membership.user.get_username(),
        "role": membership.role,
    }


class ExperimentMemberListView(APIView):
    """列出成员，或由所有者添加、修改成员权限。"""

    @staticmethod
    def _experiment(experiment_id: UUID) -> Experiment:
        experiment = Experiment.objects.filter(pk=experiment_id).exclude(status="ARCHIVED").first()
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        return experiment

    def get(self, request: Request, experiment_id: UUID) -> Response:
        """成员均可查看当前实验的成员清单。"""
        experiment = self._experiment(experiment_id)
        require_member(request.user, experiment)
        memberships = experiment.members.select_related("user").order_by("role", "user__username")
        return Response([_member_json(item) for item in memberships])

    def post(self, request: Request, experiment_id: UUID) -> Response:
        """添加成员或设置 EDITOR/VIEWER 权限。"""
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = self._experiment(experiment_id)
        command = _execute_experiment_command(
            request,
            experiment,
            "experiment.member.set",
            {
                "username": request.data.get("username"),
                "role": request.data.get("role"),
            },
            experiment.config_revision,
        )
        experiment.refresh_from_db()
        return Response(
            {
                "member": command.result,
                "experiment": _experiment_json(experiment, request.user),
            }
        )


class ExperimentMemberDetailView(APIView):
    """由实验所有者移除一个非 OWNER 成员。"""

    def delete(self, request: Request, experiment_id: UUID, user_id: int) -> Response:
        """移除指定成员。"""
        experiment = Experiment.objects.filter(pk=experiment_id).exclude(status="ARCHIVED").first()
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        _execute_experiment_command(
            request,
            experiment,
            "experiment.member.remove",
            {"user_id": user_id},
            experiment.config_revision,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ExperimentStateView(APIView):
    """返回一次一致的实验投影。"""

    def get(self, request: Request, experiment_id: UUID) -> Response:
        """返回设备、端口、线缆与游标。"""
        experiment = Experiment.objects.filter(pk=experiment_id).first()
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        require_member(request.user, experiment)
        devices = [
            {
                "id": str(device.id),
                "model_release_id": str(device.model_release_id),
                "type": device.model_release.device_type,
                "name": device.name,
                "position": device.position,
                "rotation": device.rotation,
                "assembly_state": device.assembly_state,
                "power_state": device.power_state,
                "runtime_state": device.runtime_state,
                "boot_state": device.boot_state,
                "observed": device.observed_json,
                "runtime": (
                    {
                        "unit_id": str(device.runtime_unit.id),
                        "generation": device.runtime_unit.generation,
                        "profile_release_id": device.runtime_unit.profile_release_id,
                        "ipv4_address": str(device.runtime_unit.ipv4_address),
                        "state": device.runtime_unit.state,
                        "source": device.runtime_unit.observed_json.get("source", "configured"),
                        "quality": device.runtime_unit.observed_json.get(
                            "quality", settings.RUNTIME_MODE
                        ),
                    }
                    if hasattr(device, "runtime_unit")
                    else None
                ),
                "ports": [
                    {
                        "id": str(port.id),
                        "port_key": port.port_key,
                        "connector_type": port.connector_type,
                        "protocol": port.protocol,
                        "physical_connected": port.physical_connected,
                        "carrier_state": port.carrier_state,
                        "forwarding_state": port.forwarding_state,
                    }
                    for port in device.ports.all()
                ],
            }
            for device in experiment.devices.select_related(
                "model_release", "runtime_unit"
            ).prefetch_related("ports")
        ]
        cables = []
        for cable in experiment.cables.prefetch_related("ends__attachments__device_port"):
            port_ids = [
                str(attachment.device_port_id)
                for end in cable.ends.all()
                for attachment in end.attachments.all()
                if attachment.state == "ACTIVE"
            ]
            if not port_ids:
                continue
            cables.append(
                {
                    "id": str(cable.id),
                    "type": cable.cable_type,
                    "port_ids": port_ids,
                    "fault_state": cable.fault_state,
                }
            )
        return Response(
            {"experiment": _experiment_json(experiment), "devices": devices, "cables": cables}
        )


class CommandSubmitView(APIView):
    """接收所有实验状态变更命令。"""

    def post(self, request: Request, experiment_id: UUID) -> Response:
        """校验 Idempotency-Key 并持久化命令。"""
        try:
            command_id = UUID(str(request.data.get("command_id")))
            expected_revision = int(request.data.get("expected_config_revision"))
        except (ValueError, TypeError) as error:
            raise SimlabError(
                "INVALID_ENVELOPE", "command_id 或 expected_config_revision 无效"
            ) from error
        idempotency_key = request.headers.get("Idempotency-Key")
        if idempotency_key != str(command_id):
            raise SimlabError("IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key 必须等于 command_id")
        payload = request.data.get("payload", {})
        if not isinstance(payload, dict):
            raise SimlabError("INVALID_ENVELOPE", "payload 必须是对象")
        envelope = CommandEnvelope(
            command_id, str(request.data.get("type", "")), expected_revision, payload
        )
        command, created = submit_command(request.user, experiment_id, envelope)
        if created:
            transaction.on_commit(lambda: execute_command_task.delay(str(command.id)))
        return Response(_command_json(command), status=status.HTTP_202_ACCEPTED)


class CommandDetailView(APIView):
    """查询单个命令的当前结果。"""

    def get(self, request: Request, experiment_id: UUID, command_id: UUID) -> Response:
        """仅向实验成员返回命令。"""
        command = (
            Command.objects.filter(pk=command_id, experiment_id=experiment_id)
            .select_related("experiment")
            .first()
        )
        if command is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "命令不存在", status_code=404)
        require_member(request.user, command.experiment)
        return Response(_command_json(command))


class EventListView(APIView):
    """按序返回可补齐的持久事件。"""

    def get(self, request: Request, experiment_id: UUID) -> Response:
        """返回指定游标之后的事件。"""
        experiment = Experiment.objects.filter(pk=experiment_id).first()
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        require_member(request.user, experiment)
        after_seq = max(int(request.query_params.get("after_seq", 0)), 0)
        limit = min(max(int(request.query_params.get("limit", 200)), 1), 500)
        events = ExperimentEvent.objects.filter(experiment=experiment, seq__gt=after_seq)[:limit]
        return Response(
            [
                {
                    "schema_version": "1.0",
                    "experiment_id": str(experiment.id),
                    "seq": event.seq,
                    "generation": event.generation,
                    "type": event.type,
                    "command_id": str(event.command_id) if event.command_id else None,
                    "payload": event.payload,
                    "occurred_at": event.occurred_at.isoformat(),
                }
                for event in events
            ]
        )


class ModelListView(APIView):
    """返回已发布设备目录。"""

    def get(self, request: Request) -> Response:
        """返回设备 manifest 摘要。"""
        models = list(DeviceModelRelease.objects.filter(publication_status="PUBLISHED"))
        if settings.RUNTIME_MODE == "runtime_real":
            filtered_models = []
            for item in models:
                profiles = item.manifest_json.get("runtime_profiles", [])
                qemu_profiles = [
                    profile
                    for profile in profiles
                    if isinstance(profile, dict) and profile.get("backend") == "qemu"
                ]
                if qemu_profiles and not all(
                    profile.get("profile_release_id") in settings.APPROVED_RUNTIME_PROFILE_RELEASES
                    for profile in qemu_profiles
                ):
                    continue
                filtered_models.append(item)
            models = filtered_models
        return Response(
            [
                {
                    "id": str(item.id),
                    "model_id": item.model_id,
                    "release_version": item.release_version,
                    "name": item.name,
                    "device_type": item.device_type,
                    "manifest": item.manifest_json,
                }
                for item in models
            ]
        )


class SnapshotListView(APIView):
    """列出冷快照元数据。"""

    def get(self, request: Request, experiment_id: UUID) -> Response:
        """返回有权查看的保存点。"""
        experiment = Experiment.objects.filter(pk=experiment_id).first()
        if experiment is None:
            raise SimlabError("RESOURCE_NOT_FOUND", "实验不存在", status_code=404)
        require_member(request.user, experiment)
        snapshots = ExperimentSnapshot.objects.filter(experiment=experiment)
        return Response(
            [
                {
                    "id": str(item.id),
                    "name": item.name,
                    "status": item.status,
                    "created_at": item.created_at.isoformat(),
                }
                for item in snapshots
            ]
        )


class G0Pc1BindingView(APIView):
    """绑定固定的 simlab-g0-pc1 到 web 前端选择的 PC。"""

    def get(self, request: Request) -> Response:
        """返回当前绑定、真实电源状态和 noVNC 入口。"""
        _require_local_g0_bridge(request)
        instance = VirtualRuntimeInstance.objects.filter(domain_name=settings.G0_PC1_DOMAIN).first()
        if instance is not None and instance.bound_experiment_id is not None:
            require_member(request.user, instance.bound_experiment)
        binding = ExternalRuntimeBinding.objects.filter(domain_name=settings.G0_PC1_DOMAIN).first()
        observation = observe_g0_runtime()
        return Response(_g0_binding_json(binding, observation))

    def put(self, request: Request) -> Response:
        """把固定 domain 原子地改绑到所选前端 PC。"""
        _require_local_g0_bridge(request)
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = _desktop_experiment(request, request.data)
        frontend_device_id = str(request.data.get("device_id", "")).strip()
        _check_desktop_device(experiment, frontend_device_id)
        existing = VirtualRuntimeInstance.objects.filter(domain_name=settings.G0_PC1_DOMAIN).first()
        if existing is not None and existing.frontend_device_id and (
            existing.bound_experiment_id != experiment.id
        ):
            raise SimlabError("RUNTIME_ALREADY_BOUND", "该虚拟机已绑定其他实验", status_code=409)
        model_id = str(request.data.get("model_id", "")).strip()
        display_name = str(request.data.get("display_name", "")).strip()
        if not G0_FRONTEND_DEVICE_PATTERN.fullmatch(frontend_device_id):
            raise SimlabError("INVALID_DEVICE_ID", "前端设备 ID 格式无效")
        if model_id != "generic-atx-pc":
            raise SimlabError("MODEL_NOT_BINDABLE", "simlab-g0-pc1 只能绑定到通用 PC 型号")
        if not display_name or len(display_name) > 120:
            raise SimlabError("INVALID_DEVICE_NAME", "PC 名称长度必须为 1 到 120 个字符")
        binding, observation, _ = execute_g0_command(
            G0_COMMAND_BIND,
            {
                "device_id": frontend_device_id,
                "model_id": model_id,
                "display_name": display_name,
            },
        )
        VirtualRuntimeInstance.objects.filter(domain_name=settings.G0_PC1_DOMAIN).update(
            bound_experiment=experiment
        )
        return Response(_g0_binding_json(binding, observation))

    def delete(self, request: Request) -> Response:
        """解除画面/控制绑定；不改变虚拟机电源状态。"""
        _require_local_g0_bridge(request)
        instance = VirtualRuntimeInstance.objects.filter(domain_name=settings.G0_PC1_DOMAIN).first()
        if instance is None:
            raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
        _bound_desktop_instance(request, instance.id)
        _, observation, _ = execute_g0_command(G0_COMMAND_UNBIND, {})
        return Response(_g0_binding_json(None, observation))


class G0Pc1PowerView(APIView):
    """只控制已绑定 PC 对应的固定 G0 domain 电源。"""

    def post(self, request: Request) -> Response:
        """按 on=true/false 启动或正常关闭 simlab-g0-pc1。"""
        _require_local_g0_bridge(request)
        instance = VirtualRuntimeInstance.objects.filter(domain_name=settings.G0_PC1_DOMAIN).first()
        if instance is None:
            raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
        _bound_desktop_instance(request, instance.id)
        frontend_device_id = str(request.data.get("device_id", "")).strip()
        power_on = request.data.get("on")
        if not isinstance(power_on, bool):
            raise SimlabError("INVALID_POWER_STATE", "on 必须是布尔值")
        binding, observation, _ = execute_g0_command(
            G0_COMMAND_POWER_ON if power_on else G0_COMMAND_SHUTDOWN,
            {"device_id": frontend_device_id},
        )
        return Response(_g0_binding_json(binding, observation))


class DesktopRuntimeListView(APIView):
    """列出已有桌面虚拟机，或按前端规格创建一台受管虚拟机。"""

    def get(self, request: Request) -> Response:
        """返回所有白名单已有域和平台创建的虚拟机。"""
        _require_local_desktop_bridge(request)
        inventory = runtime_inventory_json()
        allowed_experiments = set(
            Experiment.objects.filter(members__user=request.user)
            .exclude(status="ARCHIVED")
            .values_list("id", flat=True)
        )
        visible_ids = set(
            VirtualRuntimeInstance.objects.filter(
                bound_experiment_id__in=allowed_experiments
            ).values_list("id", flat=True)
        )
        visible_ids.update(
            VirtualRuntimeInstance.objects.filter(
                frontend_device_id__isnull=True, owner_user__isnull=True
            ).values_list("id", flat=True)
        )
        visible_ids.update(
            VirtualRuntimeInstance.objects.filter(
                frontend_device_id__isnull=True, owner_user=request.user
            ).values_list("id", flat=True)
        )
        inventory["instances"] = [
            item for item in inventory["instances"] if UUID(str(item["id"])) in visible_ids
        ]
        return Response(inventory)

    def post(self, request: Request) -> Response:
        """创建后端虚拟机并立即绑定到新建前端设备。"""
        _require_local_desktop_bridge(request)
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = _desktop_experiment(request, request.data)
        _check_desktop_device(experiment, str(request.data.get("device_id", "")))
        instance = provision_runtime_instance(dict(request.data), experiment)
        return Response(
            {"success": True, "instance": runtime_instance_json(instance)},
            status=status.HTTP_201_CREATED,
        )


class RuntimeImageImportView(APIView):
    """管理员从创建表单上传并登记独立 qcow2 网络镜像。"""

    parser_classes = (MultiPartParser,)

    def post(self, request: Request) -> Response:
        _require_local_desktop_bridge(request)
        if not request.user.is_staff:
            raise SimlabError(
                "IMAGE_IMPORT_FORBIDDEN", "只有管理员可导入镜像；请联系平台管理员。",
                status_code=403,
            )
        uploaded = request.FILES.get("image")
        if uploaded is None:
            raise SimlabError("IMAGE_REQUIRED", "请选择 qcow2 文件后再导入。")
        image = import_runtime_image(
            uploaded, str(request.data.get("display_name", "")),
            str(request.data.get("appliance_role", "")), request.user,
            model_id=str(request.data.get("model_id", "")),
            vendor_id=str(request.data.get("vendor_id", "")),
        )
        return Response(
            {"success": True, "image_release": image.image_release,
             "display_name": image.display_name, "appliance_role": image.appliance_role},
            status=status.HTTP_201_CREATED,
        )


class RuntimeVendorImageRegisterView(APIView):
    """管理员登记只读发现的 Vendor/model-version 镜像候选。"""

    def post(self, request: Request) -> Response:
        _require_local_desktop_bridge(request)
        if not request.user.is_staff:
            raise SimlabError(
                "IMAGE_IMPORT_FORBIDDEN", "只有管理员可登记目录镜像；请联系平台管理员。",
                status_code=403,
            )
        image = register_vendor_image(str(request.data.get("folder", "")), request.user)
        return Response({
            "success": True, "image_release": image.image_release,
            "display_name": image.display_name, "model_id": image.model_id,
        }, status=status.HTTP_201_CREATED)


class RuntimeConsoleTicketView(APIView):
    """按当前实验成员权限签发短期真实串口连接。"""

    def post(self, request: Request, runtime_id: UUID) -> Response:
        _require_local_desktop_bridge(request)
        instance = _bound_desktop_instance(request, runtime_id, write=True)
        device_id = str(request.data.get("device_id", ""))
        return Response({
            "success": True,
            "quality": "real_runtime",
            "console_url": issue_runtime_console_ticket(instance, request.user.pk, device_id),
        })


class DesktopRuntimeDetailView(APIView):
    """删除平台创建且不再绑定的桌面虚拟机。"""

    def delete(self, request: Request, runtime_id: UUID) -> Response:
        """精确删除一台已停止的受管虚拟机。"""
        _require_local_desktop_bridge(request)
        instance = VirtualRuntimeInstance.objects.filter(pk=runtime_id).first()
        if instance is None:
            raise SimlabError("RUNTIME_NOT_FOUND", "虚拟机不存在", status_code=404)
        if instance.owner_user_id != request.user.pk:
            raise SimlabError("RUNTIME_NOT_OWNED", "只有创建者能删除该虚拟机", status_code=403)
        delete_runtime_instance(runtime_id)
        return Response({"success": True, "deleted_runtime_id": str(runtime_id)})


class DesktopRuntimeLifecycleView(APIView):
    """处理前端设备删除触发的后端虚拟机生命周期联动。"""

    def delete(self, request: Request, runtime_id: UUID) -> Response:
        """关闭、解绑并销毁绑定的平台创建虚拟机。"""
        _require_local_desktop_bridge(request)
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        _bound_desktop_instance(request, runtime_id)
        frontend_device_id = str(request.data.get("device_id", "")).strip()
        result = destroy_bound_runtime_instance(runtime_id, frontend_device_id)
        return Response({"success": True, **result})


class DesktopRuntimeReleaseView(APIView):
    """实验关闭时批量关闭并解绑桌面虚拟机。"""

    def post(self, request: Request) -> Response:
        """按前端设备 ID 精确释放当前实验的绑定。"""
        _require_local_desktop_bridge(request)
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        raw_device_ids = request.data.get("device_ids", [])
        if not isinstance(raw_device_ids, list) or any(
            not isinstance(device_id, str) for device_id in raw_device_ids
        ):
            raise SimlabError("INVALID_DEVICE_IDS", "device_ids 必须是字符串数组")
        experiment = _desktop_experiment(request, request.data)
        for device_id in raw_device_ids:
            instance = VirtualRuntimeInstance.objects.filter(frontend_device_id=device_id).first()
            if instance is not None and instance.bound_experiment_id != experiment.id:
                raise SimlabError("DEVICE_NOT_IN_EXPERIMENT", "设备不属于当前实验", status_code=403)
        released = release_bound_runtime_instances(raw_device_ids)
        return Response({"success": True, "released": released})


class DesktopRuntimeBindingView(APIView):
    """管理一台虚拟机与一个前端 PC/笔记本的一对一绑定。"""

    def put(self, request: Request, runtime_id: UUID) -> Response:
        """把资源池中的已有虚拟机绑定到前端设备。"""
        _require_local_desktop_bridge(request)
        if not isinstance(request.data, dict):
            raise SimlabError("INVALID_PAYLOAD", "请求体必须是对象")
        experiment = _desktop_experiment(request, request.data)
        _check_desktop_device(experiment, str(request.data.get("device_id", "")))
        instance = bind_runtime_instance(runtime_id, dict(request.data), experiment)
        return Response({"success": True, "instance": runtime_instance_json(instance)})

    def delete(self, request: Request, runtime_id: UUID) -> Response:
        """解除映射但保留后端虚拟机。"""
        _require_local_desktop_bridge(request)
        _bound_desktop_instance(request, runtime_id)
        instance = unbind_runtime_instance(runtime_id)
        return Response({"success": True, "instance": runtime_instance_json(instance)})


class DesktopRuntimePowerView(APIView):
    """控制已绑定桌面虚拟机的实际电源。"""

    def post(self, request: Request, runtime_id: UUID) -> Response:
        """启动或正常关闭指定虚拟机。"""
        _require_local_desktop_bridge(request)
        _bound_desktop_instance(request, runtime_id)
        frontend_device_id = str(request.data.get("device_id", "")).strip()
        is_on = request.data.get("on")
        if not isinstance(is_on, bool):
            raise SimlabError("INVALID_POWER_STATE", "on 必须是布尔值")
        instance = set_runtime_power(runtime_id, frontend_device_id, is_on)
        return Response({"success": True, "instance": runtime_instance_json(instance)})


class CloudUplinkListView(APIView):
    """列出管理员批准的宿主 OVS 上联桥名称。"""

    def get(self, request: Request) -> Response:
        return Response({
            "uplinks": [{"bridge": name, "label": name} for name in settings.CLOUD_UPLINK_BRIDGES],
            "quality": (
                "runtime_real_configured"
                if settings.RUNTIME_MODE == "runtime_real" else "development_mock"
            ),
        })


class CapabilityView(APIView):
    """显示实际可用能力及其保真度。"""

    def get(self, request: Request) -> Response:
        """从 Host Agent 实际读回能力，失败时不回退为成功。"""
        real = settings.RUNTIME_MODE == "runtime_real"
        observation: dict[str, object] = {}
        agent_status = "disabled"
        if real:
            try:
                observation = RealRuntimeClient(
                    settings.HOST_AGENT_SOCKET, settings.HOST_AGENT_TIMEOUT_SECONDS
                ).preflight(uuid4())
                agent_status = "ready"
            except HostAgentClientError as error:
                agent_status = "unavailable"
                observation = {
                    "source": "unavailable",
                    "quality": "real_runtime",
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable,
                    },
                }
        available = real and agent_status == "ready"
        return Response(
            {
                "runtime_mode": settings.RUNTIME_MODE,
                "fidelity": "REAL_RUNTIME" if available else "VISUAL",
                "host_agent_status": agent_status,
                "qemu": available,
                "ovs": available,
                "cold_snapshot": "metadata_only",
                "observation": observation,
            }
        )
