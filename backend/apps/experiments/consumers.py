# -*- coding: utf-8 -*-
"""实验事件 WebSocket Consumer。"""

import asyncio
import json
import uuid
from urllib.parse import parse_qs

from django.conf import settings
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer, AsyncWebsocketConsumer

from apps.experiments.desktop_runtime import verify_runtime_console_token, verify_vnc_token
from apps.experiments.models import Experiment, ExperimentMember, MemberRole, VirtualRuntimeInstance

CURSOR_INTERVAL_SECONDS = 10


class ExperimentConsumer(AsyncJsonWebsocketConsumer):
    """仅允许实验成员订阅增量通知。"""

    group_name: str
    experiment_id: str
    cursor_task: asyncio.Task[None]

    @database_sync_to_async
    def _can_view(self, experiment_id: str, user_id: int) -> bool:
        return ExperimentMember.objects.filter(
            experiment_id=experiment_id, user_id=user_id
        ).exists()

    @database_sync_to_async
    def _cursor(self, experiment_id: str, user_id: int) -> dict[str, object] | None:
        """重新核对权限并返回权威事件游标。"""
        experiment = Experiment.objects.filter(pk=experiment_id, members__user_id=user_id).first()
        if experiment is None:
            return None
        return {
            "type": "subscription.cursor",
            "experiment_id": str(experiment.id),
            "latest_seq": experiment.last_event_seq,
            "generation": experiment.generation,
            "control_epoch": experiment.control_epoch,
        }

    async def _send_cursor_loop(self) -> None:
        """定期公布尾部游标并撤销失效权限。"""
        while True:
            await asyncio.sleep(CURSOR_INTERVAL_SECONDS)
            cursor = await self._cursor(self.experiment_id, self.scope["user"].pk)
            if cursor is None:
                await self.close(code=4403)
                return
            await self.send_json(cursor)

    async def connect(self) -> None:
        """鉴权后加入实验通知组。"""
        user = self.scope["user"]
        self.experiment_id = str(self.scope["url_route"]["kwargs"]["experiment_id"])
        if not user.is_authenticated or not await self._can_view(self.experiment_id, user.pk):
            await self.close(code=4403)
            return
        self.group_name = f"experiment.{self.experiment_id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        cursor = await self._cursor(self.experiment_id, user.pk)
        assert cursor is not None
        await self.send_json({**cursor, "type": "subscription.ready"})
        self.cursor_task = asyncio.create_task(
            self._send_cursor_loop(), name=f"cursor-{self.experiment_id}"
        )

    async def disconnect(self, code: int) -> None:
        """离开通知组。"""
        if hasattr(self, "cursor_task"):
            self.cursor_task.cancel()
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def experiment_event(self, event: dict[str, object]) -> None:
        """转发已经持久化的事件。"""
        await self.send_json(event["payload"])


class RuntimeVncConsumer(AsyncWebsocketConsumer):
    """把签名后的 noVNC WebSocket 二进制帧中继到本机 VNC socket。"""

    upstream_writer: asyncio.StreamWriter
    upstream_task: asyncio.Task[None]

    @database_sync_to_async
    def _target(self, runtime_id: str, token: str, user_id: int) -> tuple[str, int] | None:
        """核对签名、绑定状态和最近一次 Host Agent VNC 观测。"""
        try:
            instance_id = uuid.UUID(runtime_id)
        except ValueError:
            return None
        if not verify_vnc_token(instance_id, token):
            return None
        instance = VirtualRuntimeInstance.objects.filter(
            pk=instance_id,
            frontend_device_id__isnull=False,
            bound_experiment__members__user_id=user_id,
            bound_experiment__members__role__in=[MemberRole.OWNER, MemberRole.EDITOR],
            provision_state=VirtualRuntimeInstance.ProvisionState.READY,
        ).first()
        if instance is None:
            return None
        vnc = instance.observed_json.get("vnc", {})
        port = vnc.get("port") if isinstance(vnc, dict) else None
        if (
            instance.observed_json.get("power_state") != "RUNNING"
            or isinstance(port, bool)
            or not isinstance(port, int)
            or not 1 <= port <= 65_535
        ):
            return None
        return "127.0.0.1", port

    async def _pump_upstream(self, reader: asyncio.StreamReader) -> None:
        """持续把 VNC socket 数据发送给 noVNC。"""
        try:
            while True:
                payload = await reader.read(65_536)
                if not payload:
                    break
                await self.send(bytes_data=payload)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            try:
                await self.close()
            except RuntimeError:
                # 浏览器先断开时 ASGI 响应已经完成，避免重复发送 websocket.close。
                pass

    async def connect(self) -> None:
        """验证资源令牌后建立本机 TCP 中继。"""
        user = self.scope["user"]
        if not user.is_authenticated:
            await self.close(code=4403)
            return
        runtime_id = str(self.scope["url_route"]["kwargs"]["runtime_id"])
        query = parse_qs(self.scope.get("query_string", b"").decode("ascii", errors="ignore"))
        token = query.get("token", [""])[0]
        target = await self._target(runtime_id, token, user.pk)
        if target is None:
            await self.close(code=4403)
            return
        try:
            reader, self.upstream_writer = await asyncio.open_connection(*target)
        except OSError:
            await self.close(code=4503)
            return
        offered = self.scope.get("subprotocols", [])
        await self.accept(subprotocol="binary" if "binary" in offered else None)
        self.upstream_task = asyncio.create_task(
            self._pump_upstream(reader), name=f"vnc-{runtime_id}"
        )

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        """只接受 noVNC 的二进制 RFB 数据。"""
        if bytes_data is None or not hasattr(self, "upstream_writer"):
            await self.close(code=4400)
            return
        self.upstream_writer.write(bytes_data)
        try:
            await self.upstream_writer.drain()
        except ConnectionError:
            await self.close(code=4503)

    async def disconnect(self, code: int) -> None:
        """关闭中继任务和 TCP socket。"""
        if hasattr(self, "upstream_task"):
            self.upstream_task.cancel()
        if hasattr(self, "upstream_writer"):
            self.upstream_writer.close()
            try:
                await self.upstream_writer.wait_closed()
            except ConnectionError:
                pass


class RuntimeConsoleConsumer(AsyncWebsocketConsumer):
    """鉴权 xterm WebSocket，并经 Host Agent 专用通道转发真实客体串口。"""

    @database_sync_to_async
    def _target(self, runtime_id: str, token: str, user_id: int) -> dict[str, object] | None:
        try:
            instance_id = uuid.UUID(runtime_id)
        except ValueError:
            return None
        instance = VirtualRuntimeInstance.objects.filter(
            pk=instance_id,
            frontend_device_id__isnull=False,
            bound_experiment__members__user_id=user_id,
            bound_experiment__members__role__in=[MemberRole.OWNER, MemberRole.EDITOR],
            provision_state=VirtualRuntimeInstance.ProvisionState.READY,
        ).first()
        if (
            instance is None or instance.observed_json.get("power_state") != "RUNNING"
            or not verify_runtime_console_token(
                instance.id, user_id, str(instance.frontend_device_id), token
            )
        ):
            return None
        return {
            "experiment_id": str(instance.experiment_id),
            "unit_id": str(instance.unit_id),
            "generation": instance.generation,
            "domain_name": instance.domain_name if instance.source == "EXTERNAL" else None,
        }

    async def connect(self) -> None:
        user = self.scope["user"]
        if not user.is_authenticated:
            await self.close(code=4403)
            return
        runtime_id = str(self.scope["url_route"]["kwargs"]["runtime_id"])
        query = parse_qs(self.scope.get("query_string", b"").decode("ascii", errors="ignore"))
        token = query.get("token", [""])[0]
        target = await self._target(runtime_id, token, user.pk)
        if target is None:
            await self.close(code=4403)
            return
        try:
            reader, self.upstream_writer = await asyncio.open_unix_connection(
                str(settings.HOST_AGENT_CONSOLE_SOCKET)
            )
            operation_id = str(uuid.uuid4())
            request = {
                "schema_version": "1.0", "operation_id": operation_id,
                "action": "CONSOLE_ATTACH", "experiment_id": target["experiment_id"],
                "unit_id": target["unit_id"], "generation": target["generation"],
                "payload": {"domain_name": target["domain_name"]}
                if target["domain_name"] else {},
            }
            self.upstream_writer.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
            await self.upstream_writer.drain()
            reply = json.loads(await asyncio.wait_for(reader.readline(), timeout=10))
            if reply.get("ok") is not True or reply.get("operation_id") != operation_id:
                detail = reply.get("error") or {}
                await self.accept()
                await self.send(text_data=(
                    f"\r\n{detail.get('code', 'CONSOLE_UNAVAILABLE')}："
                    f"{detail.get('message', '串口连接失败；请检查设备状态。')}\r\n"
                ))
                await self.close(code=4503)
                return
        except (OSError, ValueError, asyncio.TimeoutError):
            await self.accept()
            await self.send(text_data="\r\nCONSOLE_UNAVAILABLE：无法连接 Host Agent 串口；请检查服务状态。\r\n")
            await self.close(code=4503)
            return
        await self.accept()
        self.upstream_task = asyncio.create_task(self._pump(reader), name=f"console-{runtime_id}")

    async def _pump(self, reader: asyncio.StreamReader) -> None:
        try:
            while True:
                data = await reader.read(8192)
                if not data:
                    break
                await self.send(bytes_data=data)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            try:
                await self.close()
            except RuntimeError:
                pass

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        data = bytes_data if bytes_data is not None else (text_data or "").encode()
        if len(data) > 4096 or not hasattr(self, "upstream_writer"):
            await self.close(code=4400)
            return
        self.upstream_writer.write(data)
        try:
            await self.upstream_writer.drain()
        except ConnectionError:
            await self.close(code=4503)

    async def disconnect(self, code: int) -> None:
        if hasattr(self, "upstream_task"):
            self.upstream_task.cancel()
        if hasattr(self, "upstream_writer"):
            self.upstream_writer.close()
            try:
                await self.upstream_writer.wait_closed()
            except ConnectionError:
                pass
