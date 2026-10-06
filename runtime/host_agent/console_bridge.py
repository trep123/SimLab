# -*- coding: utf-8 -*-
"""为 virsh console 提供控制 PTY；仅由 Host Agent 在完成资源校验后启动。"""

from __future__ import annotations

import errno
import os
import pty
import re
import selectors
import signal
import sys

DOMAIN_PATTERN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\Z")


def _write_all(fd: int, data: bytes) -> None:
    """PTY 与管道允许短写，确保串口字节不会被截断。"""
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def main() -> int:
    if len(sys.argv) != 2 or not DOMAIN_PATTERN.fullmatch(sys.argv[1]):
        return 2
    domain_name = sys.argv[1]
    child_pid, master = pty.fork()
    if child_pid == 0:
        os.execve(
            "/usr/bin/virsh",
            ["virsh", "-c", "qemu:///system", "console", domain_name],
            {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
        )
    selector = selectors.DefaultSelector()
    selector.register(0, selectors.EVENT_READ)
    selector.register(master, selectors.EVENT_READ)
    try:
        while True:
            for key, _mask in selector.select(timeout=1):
                if key.fd == 0:
                    data = os.read(0, 4096)
                    if not data:
                        return 0
                    _write_all(master, data)
                else:
                    try:
                        data = os.read(master, 65_536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            return 0
                        raise
                    if not data:
                        return 0
                    _write_all(1, data)
            exited, _status = os.waitpid(child_pid, os.WNOHANG)
            if exited:
                return 0
    finally:
        selector.close()
        os.close(master)
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(child_pid, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
