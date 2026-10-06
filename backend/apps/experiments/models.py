# -*- coding: utf-8 -*-
"""实验、拓扑、命令与事件的权威数据模型。"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class MemberRole(models.TextChoices):
    """实验对象权限。"""

    OWNER = "OWNER", "所有者"
    EDITOR = "EDITOR", "编辑者"
    VIEWER = "VIEWER", "查看者"


class Experiment(models.Model):
    """实验聚合根及其并发版本。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="owned_experiments"
    )
    mode = models.CharField(max_length=32, default="VISUAL")
    status = models.CharField(max_length=32, default="STOPPED")
    config_revision = models.PositiveBigIntegerField(default=0)
    last_event_seq = models.PositiveBigIntegerField(default=0)
    generation = models.PositiveIntegerField(default=1)
    control_epoch = models.PositiveIntegerField(default=1)
    document_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at",)

    def __str__(self) -> str:
        """返回实验名称。"""
        return self.name


class ExperimentMember(models.Model):
    """用户在单个实验中的授权。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="experiment_memberships"
    )
    role = models.CharField(max_length=16, choices=MemberRole.choices)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("experiment", "user"), name="unique_experiment_member")
        ]

    def __str__(self) -> str:
        """返回实验成员摘要。"""
        return f"{self.experiment_id}:{self.user_id}:{self.role}"


class DeviceModelRelease(models.Model):
    """发布后不可修改的设备定义。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    model_id = models.SlugField(max_length=64)
    release_version = models.CharField(max_length=32)
    schema_version = models.CharField(max_length=16, default="1.1")
    name = models.CharField(max_length=120)
    device_type = models.CharField(max_length=32)
    manifest_hash = models.CharField(max_length=64)
    manifest_json = models.JSONField()
    publication_status = models.CharField(max_length=16, default="DRAFT")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("model_id", "release_version"), name="unique_model_release"
            )
        ]

    def __str__(self) -> str:
        """返回型号及发布版本。"""
        return f"{self.model_id}@{self.release_version}"

    def save(self, *args: object, **kwargs: object) -> None:
        """阻止修改已发布版本内容。"""
        if (
            self.pk
            and DeviceModelRelease.objects.filter(
                pk=self.pk, publication_status="PUBLISHED"
            ).exists()
        ):
            raise ValidationError("已发布的设备版本不可原地修改")
        super().save(*args, **kwargs)


class DeviceInstance(models.Model):
    """实验中的设备实例。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="devices")
    model_release = models.ForeignKey(
        DeviceModelRelease, on_delete=models.PROTECT, related_name="instances"
    )
    name = models.CharField(max_length=120)
    position = models.JSONField(default=dict)
    rotation = models.JSONField(default=dict)
    desired_json = models.JSONField(default=dict)
    observed_json = models.JSONField(default=dict)
    model_estimates_json = models.JSONField(default=dict)
    assembly_state = models.CharField(max_length=20, default="VALID")
    power_state = models.CharField(max_length=20, default="DEENERGIZED")
    runtime_state = models.CharField(max_length=20, default="STOPPED")
    boot_state = models.CharField(max_length=20, default="UNKNOWN")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("experiment", "name"), name="unique_device_name_in_experiment"
            )
        ]

    def __str__(self) -> str:
        """返回设备显示名。"""
        return self.name


class RuntimeUnit(models.Model):
    """设备到受管 Runtime 资源的稳定映射。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(
        Experiment, on_delete=models.CASCADE, related_name="runtime_units"
    )
    device = models.OneToOneField(
        DeviceInstance, on_delete=models.CASCADE, related_name="runtime_unit"
    )
    generation = models.PositiveIntegerField(default=1)
    profile_release_id = models.CharField(max_length=80)
    ipv4_address = models.GenericIPAddressField(protocol="IPv4")
    state = models.CharField(max_length=20, default="UNDEFINED")
    domain_name = models.CharField(max_length=80, blank=True)
    desired_json = models.JSONField(default=dict)
    observed_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("experiment", "ipv4_address"), name="unique_runtime_ipv4_in_experiment"
            )
        ]

    def __str__(self) -> str:
        """返回运行单元标识与代次。"""
        return f"{self.id}:g{self.generation}"

    def clean(self) -> None:
        """确保运行单元和设备属于同一实验。"""
        if self.device_id and self.experiment_id != self.device.experiment_id:
            raise ValidationError("运行单元和设备必须属于同一实验")


class ExternalRuntimeBinding(models.Model):
    """本机 G0 外部虚拟机与前端设备实例之间的唯一绑定。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    domain_name = models.CharField(max_length=80, unique=True)
    frontend_device_id = models.CharField(max_length=80)
    model_id = models.CharField(max_length=80)
    display_name = models.CharField(max_length=120)
    observed_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        """返回外部 domain 与前端设备的绑定摘要。"""
        return f"{self.domain_name}->{self.frontend_device_id}"


class ExternalRuntimeCommand(models.Model):
    """本机 G0 外部运行单元的持久化状态变更命令。"""

    class Status(models.TextChoices):
        """外部 Runtime 命令状态。"""

        QUEUED = "QUEUED", "已排队"
        RUNNING = "RUNNING", "执行中"
        SUCCEEDED = "SUCCEEDED", "成功"
        FAILED = "FAILED", "失败"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    domain_name = models.CharField(max_length=80)
    frontend_device_id = models.CharField(max_length=80, blank=True)
    type = models.CharField(max_length=40)
    payload = models.JSONField(default=dict)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.QUEUED)
    result = models.JSONField(default=dict)
    error = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-created_at",)

    def __str__(self) -> str:
        """返回外部 Runtime 命令类型与状态。"""
        return f"{self.type}:{self.status}"


class RuntimeImage(models.Model):
    """经管理员上传并校验的只读网络设备 qcow2 镜像。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    image_release = models.CharField(max_length=80, unique=True)
    display_name = models.CharField(max_length=120)
    appliance_role = models.CharField(max_length=16)
    vendor_id = models.CharField(max_length=32, blank=True)
    model_id = models.CharField(max_length=100, blank=True)
    source_folder = models.CharField(max_length=220, blank=True)
    sha256 = models.CharField(max_length=64)
    size_bytes = models.PositiveBigIntegerField()
    virtual_size_bytes = models.PositiveBigIntegerField()
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="uploaded_runtime_images"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)


class VirtualRuntimeInstance(models.Model):
    """可供前端 PC/笔记本绑定的受管或白名单虚拟机。"""

    class Source(models.TextChoices):
        """虚拟机来源。"""

        EXTERNAL = "EXTERNAL", "宿主机已有"
        MANAGED = "MANAGED", "平台创建"

    class ProvisionState(models.TextChoices):
        """宿主资源创建状态。"""

        READY = "READY", "可用"
        PROVISIONING = "PROVISIONING", "创建中"
        ERROR = "ERROR", "创建失败"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.CharField(max_length=16, choices=Source.choices)
    domain_name = models.CharField(max_length=80, unique=True, null=True, blank=True)
    experiment_id = models.UUIDField()
    unit_id = models.UUIDField(unique=True)
    generation = models.PositiveIntegerField(default=1)
    profile_release_id = models.CharField(max_length=80)
    image_release = models.CharField(max_length=80)
    compatible_device_types = models.JSONField(default=list)
    desired_json = models.JSONField(default=dict)
    observed_json = models.JSONField(default=dict)
    provision_state = models.CharField(
        max_length=20,
        choices=ProvisionState.choices,
        default=ProvisionState.READY,
    )
    frontend_device_id = models.CharField(max_length=80, unique=True, null=True, blank=True)
    bound_experiment = models.ForeignKey(
        Experiment,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="desktop_bindings",
    )
    owner_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="owned_desktop_runtimes",
    )
    model_id = models.CharField(max_length=80, blank=True)
    display_name = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("source", "domain_name", "created_at")

    def __str__(self) -> str:
        """返回虚拟机来源、域名和前端绑定。"""
        return f"{self.source}:{self.domain_name or self.unit_id}->{self.frontend_device_id or '-'}"


class DevicePort(models.Model):
    """具有稳定身份的设备端口。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="ports")
    device = models.ForeignKey(DeviceInstance, on_delete=models.CASCADE, related_name="ports")
    port_key = models.CharField(max_length=64)
    connector_type = models.CharField(max_length=32)
    protocol = models.CharField(max_length=32)
    physical_connected = models.BooleanField(default=False)
    admin_state = models.CharField(max_length=16, default="UP")
    carrier_state = models.CharField(max_length=16, default="DOWN")
    forwarding_state = models.CharField(max_length=16, default="BLOCKED")
    guest_identity = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("device", "port_key"), name="unique_device_port_key"),
        ]

    def __str__(self) -> str:
        """返回设备端口标识。"""
        return f"{self.device_id}:{self.port_key}"

    def clean(self) -> None:
        """确保端口与设备属于同一实验。"""
        if self.device_id and self.experiment_id != self.device.experiment_id:
            raise ValidationError("端口和设备必须属于同一实验")


class Cable(models.Model):
    """允许半连接的物理线缆。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="cables")
    cable_type = models.CharField(max_length=32, default="ethernet")
    fault_state = models.CharField(max_length=16, default="CLEAR")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        """返回线缆标识。"""
        return str(self.id)


class CableEnd(models.Model):
    """线缆的 A 或 B 端。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    cable = models.ForeignKey(Cable, on_delete=models.CASCADE, related_name="ends")
    end = models.CharField(max_length=1, choices=(("A", "A"), ("B", "B")))

    class Meta:
        constraints = [models.UniqueConstraint(fields=("cable", "end"), name="unique_cable_end")]

    def __str__(self) -> str:
        """返回线端标识。"""
        return f"{self.cable_id}:{self.end}"


class PortAttachment(models.Model):
    """端口与线端的占用记录。"""

    class State(models.TextChoices):
        RESERVED = "RESERVED", "预留"
        ACTIVE = "ACTIVE", "有效"
        RELEASED = "RELEASED", "已释放"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="attachments")
    cable_end = models.ForeignKey(CableEnd, on_delete=models.PROTECT, related_name="attachments")
    device_port = models.ForeignKey(
        DevicePort, on_delete=models.PROTECT, related_name="attachments"
    )
    state = models.CharField(max_length=16, choices=State.choices, default=State.RESERVED)
    created_at = models.DateTimeField(auto_now_add=True)
    released_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("cable_end",),
                condition=Q(state__in=("RESERVED", "ACTIVE")),
                name="unique_active_cable_end",
            ),
            models.UniqueConstraint(
                fields=("device_port",),
                condition=Q(state__in=("RESERVED", "ACTIVE")),
                name="unique_active_device_port",
            ),
        ]

    def __str__(self) -> str:
        """返回端口占用摘要。"""
        return f"{self.device_port_id}:{self.state}"


class Command(models.Model):
    """持久化、可幂等读取的状态变更请求。"""

    class Status(models.TextChoices):
        QUEUED = "QUEUED", "已排队"
        RUNNING = "RUNNING", "执行中"
        SUCCEEDED = "SUCCEEDED", "成功"
        FAILED = "FAILED", "失败"
        RECONCILING = "RECONCILING", "核对中"

    id = models.UUIDField(primary_key=True, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="commands")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="simlab_commands"
    )
    type = models.CharField(max_length=64)
    payload = models.JSONField(default=dict)
    request_hash = models.CharField(max_length=64)
    expected_config_revision = models.PositiveBigIntegerField()
    accepted_order = models.PositiveBigIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.QUEUED)
    result = models.JSONField(default=dict)
    error = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("experiment", "accepted_order"), name="unique_command_order"
            )
        ]
        ordering = ("accepted_order",)

    def __str__(self) -> str:
        """返回命令类型与状态。"""
        return f"{self.type}:{self.status}"


class ExperimentEvent(models.Model):
    """实验内有序、持久化的事实事件。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.CASCADE, related_name="events")
    seq = models.PositiveBigIntegerField()
    generation = models.PositiveIntegerField()
    type = models.CharField(max_length=100)
    command = models.ForeignKey(
        Command, on_delete=models.SET_NULL, null=True, blank=True, related_name="events"
    )
    payload = models.JSONField(default=dict)
    occurred_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("experiment", "seq"), name="unique_event_seq")
        ]
        ordering = ("seq",)

    def __str__(self) -> str:
        """返回事件序号与类型。"""
        return f"{self.seq}:{self.type}"


class OutboxMessage(models.Model):
    """等待发布到 Channels/Streams 的事务外消息。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event = models.OneToOneField(ExperimentEvent, on_delete=models.CASCADE, related_name="outbox")
    published_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        """返回关联事件标识。"""
        return str(self.event_id)


class ExperimentSnapshot(models.Model):
    """冷快照的不可变元数据清单。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    experiment = models.ForeignKey(Experiment, on_delete=models.PROTECT, related_name="snapshots")
    name = models.CharField(max_length=120)
    source_revision = models.PositiveBigIntegerField()
    source_generation = models.PositiveIntegerField()
    manifest_json = models.JSONField(default=dict)
    status = models.CharField(max_length=20, default="COMPLETE")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        """返回保存点名称。"""
        return self.name
