# -*- coding: utf-8 -*-
"""通过受权限保护的 Unix Socket 提供串行 Host Agent 服务。"""

from __future__ import annotations

import argparse
import grp
import json
import logging
import os
import select
import socketserver
import subprocess
import sys
import threading
from pathlib import Path
from typing import Final

import libvirt

from runtime.host_agent.adapters.qemu import QemuOvsAdapter
from runtime.host_agent.errors import HostAgentError
from runtime.host_agent.journal import OperationJournal
from runtime.host_agent.protocol import (
    MAX_REQUEST_BYTES,
    AgentRequest,
    HostAction,
    error_response,
    parse_request,
    success_response,
)

LOGGER = logging.getLogger("simlab.host_agent")
DEFAULT_SOCKET: Final = Path("/run/simlab/host-agent.sock")
DEFAULT_CONSOLE_SOCKET: Final = Path("/run/simlab/console.sock")
DEFAULT_JOURNAL: Final = Path("/var/lib/simlab/host-agent/journal.sqlite3")
DEFAULT_RUNTIME_ROOT: Final = Path("/var/lib/simlab/experiments")
DEFAULT_BASE_IMAGE: Final = Path("/var/lib/simlab/image-store/ubuntu-noble-20260725/base.qcow2")


class AgentApplication:
    """串行分派白名单动作并记录最终响应。"""

    def __init__(self, adapter: QemuOvsAdapter, journal: OperationJournal) -> None:
        self._adapter = adapter
        self._journal = journal

    def _execute(self, request: AgentRequest) -> dict[str, object]:
        """调用动作对应的固定 adapter 方法。"""
        if request.action is HostAction.CONSOLE_ATTACH:
            raise HostAgentError("ACTION_NOT_ALLOWED", "串口会话只能使用专用控制台通道。")
        handlers = {
            HostAction.PREFLIGHT: lambda: self._adapter.preflight(),
            HostAction.BIND_EXTERNAL: lambda: self._adapter.bind_external(request),
            HostAction.ENSURE_DEFINED: lambda: self._adapter.ensure_defined(request),
            HostAction.START: lambda: self._adapter.start(request),
            HostAction.SHUTDOWN: lambda: self._adapter.shutdown(request),
            HostAction.FORCE_OFF: lambda: self._adapter.force_off(request),
            HostAction.RESET: lambda: self._adapter.reset(request),
            HostAction.OBSERVE: lambda: self._adapter.observe(request),
            HostAction.SET_LINK: lambda: self._adapter.set_link(request),
            HostAction.WIRE_PORT: lambda: self._adapter.wire_port(request),
            HostAction.CLOUD_WIRE: lambda: self._adapter.wire_cloud(request),
            HostAction.DELETE_UNIT: lambda: self._adapter.delete_unit(request),
            HostAction.DELETE_FABRIC: lambda: self._adapter.delete_fabric(request),
        }
        return handlers[request.action]()

    def handle(self, raw_request: bytes) -> dict[str, object]:
        """验证、幂等执行并返回一条响应。"""
        request: AgentRequest | None = None
        should_record = False
        try:
            request = parse_request(raw_request)
            if request.action in {
                HostAction.PREFLIGHT,
                HostAction.BIND_EXTERNAL,
                HostAction.OBSERVE,
            }:
                return success_response(request.operation_id, self._execute(request))
            decision = self._journal.begin(
                request.operation_id, request.request_hash(), request.action.value
            )
            if not decision.should_execute:
                assert decision.response is not None
                return decision.response
            should_record = True
            result = self._execute(request)
            response = success_response(request.operation_id, result)
        except HostAgentError as error:
            response = error_response(request.operation_id if request else None, error)
        except (OSError, ValueError, SyntaxError, libvirt.libvirtError):
            LOGGER.exception(
                "host action failed: operation_id=%s", request.operation_id if request else None
            )
            safe_error = HostAgentError(
                "HOST_OPERATION_FAILED", "宿主机操作失败，请查看 Host Agent 日志", retryable=True
            )
            response = error_response(request.operation_id if request else None, safe_error)
        except Exception:
            # 协议边界必须始终返回结构化错误；完整堆栈只进入本机 journal。
            LOGGER.exception(
                "unexpected host action failure: operation_id=%s",
                request.operation_id if request else None,
            )
            safe_error = HostAgentError(
                "HOST_AGENT_INTERNAL_ERROR",
                "Host Agent 内部错误，请查看本机服务日志",
                retryable=True,
            )
            response = error_response(request.operation_id if request else None, safe_error)
        if request is not None and should_record:
            error_payload = response.get("error", {})
            is_retryable = isinstance(error_payload, dict) and bool(
                error_payload.get("retryable", False)
            )
            if is_retryable:
                self._journal.mark_retryable(request.operation_id, response)
            else:
                self._journal.complete(request.operation_id, response)
        return response


class AgentRequestHandler(socketserver.StreamRequestHandler):
    """每个连接只处理一条 JSON Lines 请求。"""

    def handle(self) -> None:
        """限制输入大小并写回单行 JSON。"""
        raw_request = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(raw_request) > MAX_REQUEST_BYTES:
            response = error_response(
                None, HostAgentError("REQUEST_SIZE_INVALID", "请求超过大小限制")
            )
        else:
            assert isinstance(self.server, AgentUnixServer)
            response = self.server.application.handle(raw_request)
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode()
        self.wfile.write(encoded + b"\n")


class AgentUnixServer(socketserver.UnixStreamServer):
    """单进程单 writer Unix Socket 服务。"""

    application: AgentApplication


class ConsoleRequestHandler(socketserver.StreamRequestHandler):
    """在专用 Unix Socket 上验证目标后中继客体串口字节。"""

    def handle(self) -> None:
        assert isinstance(self.server, ConsoleUnixServer)
        if not self.server.slots.acquire(blocking=False):
            self._reply(error_response(None, HostAgentError(
                "CONSOLE_LIMIT_REACHED", "串口会话已达上限；请关闭闲置终端后重试。"
            )))
            return
        process: subprocess.Popen[bytes] | None = None
        try:
            raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
            request = parse_request(raw)
            if request.action is not HostAction.CONSOLE_ATTACH:
                raise HostAgentError("ACTION_NOT_ALLOWED", "仅允许建立受控串口会话。")
            domain_name = self.server.application._adapter.console_domain_name(request)
            process = subprocess.Popen(
                [sys.executable, "-m", "runtime.host_agent.console_bridge", domain_name],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                bufsize=0, env={
                    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
                    "PYTHONPATH": str(Path(__file__).resolve().parents[2]),
                },
            )
            self._reply(success_response(request.operation_id, {"console": "serial"}))
            assert process.stdin is not None and process.stdout is not None
            while process.poll() is None:
                readable, _, _ = select.select([self.connection, process.stdout], [], [], 0.5)
                if self.connection in readable:
                    data = self.connection.recv(4096)
                    if not data:
                        break
                    try:
                        process.stdin.write(data)
                        process.stdin.flush()
                    except BrokenPipeError:
                        break
                if process.stdout in readable:
                    data = os.read(process.stdout.fileno(), 65_536)
                    if not data:
                        break
                    self.connection.sendall(data)
        except HostAgentError as error:
            self._reply(error_response(None, error))
        except (OSError, ValueError, BrokenPipeError):
            LOGGER.exception("console relay failed")
            try:
                self._reply(error_response(None, HostAgentError(
                    "CONSOLE_UNAVAILABLE", "串口连接失败；请检查虚拟机状态与 Host Agent 日志。"
                )))
            except OSError:
                pass
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            self.server.slots.release()

    def _reply(self, response: dict[str, object]) -> None:
        self.wfile.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
        self.wfile.flush()


class ConsoleUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """仅串口会话并发；命令 Socket 仍保持单 writer。"""

    daemon_threads = True
    block_on_close = False
    application: AgentApplication
    slots = threading.BoundedSemaphore(16)


def parse_args() -> argparse.Namespace:
    """读取服务启动参数。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, default=DEFAULT_SOCKET)
    parser.add_argument("--console-socket", type=Path, default=DEFAULT_CONSOLE_SOCKET)
    parser.add_argument("--journal", type=Path, default=DEFAULT_JOURNAL)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--base-image", type=Path, default=DEFAULT_BASE_IMAGE)
    parser.add_argument(
        "--base-image-sha256",
        default=os.environ.get("SIMLAB_BASE_IMAGE_SHA256", ""),
    )
    parser.add_argument("--socket-group", default=os.environ.get("SIMLAB_SOCKET_GROUP", "simlab"))
    return parser.parse_args()


def main() -> int:
    """启动 Host Agent，并由 systemd 管理生命周期。"""
    arguments = parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    if len(arguments.base_image_sha256) != 64:
        LOGGER.error("SIMLAB_BASE_IMAGE_SHA256 未配置为 64 位哈希")
        return 2
    arguments.socket.parent.mkdir(parents=True, exist_ok=True)
    if arguments.socket.exists():
        arguments.socket.unlink()
    if arguments.console_socket.exists():
        arguments.console_socket.unlink()
    adapter = QemuOvsAdapter(
        arguments.base_image, arguments.base_image_sha256, arguments.runtime_root
    )
    journal = OperationJournal(arguments.journal)
    with AgentUnixServer(str(arguments.socket), AgentRequestHandler) as server, ConsoleUnixServer(
        str(arguments.console_socket), ConsoleRequestHandler
    ) as console_server:
        server.application = AgentApplication(adapter, journal)
        console_server.application = server.application
        socket_group = grp.getgrnam(arguments.socket_group)
        os.chown(arguments.socket, -1, socket_group.gr_gid)
        arguments.socket.chmod(0o660)
        os.chown(arguments.console_socket, -1, socket_group.gr_gid)
        arguments.console_socket.chmod(0o660)
        threading.Thread(target=console_server.serve_forever, daemon=True, name="console-relay").start()
        LOGGER.info("host agent listening: socket=%s", arguments.socket)
        server.serve_forever(poll_interval=0.5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
