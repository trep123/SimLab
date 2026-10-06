#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# @File: preflight.py
# @Description: 只读检查 Linux Runtime Host 的必需能力。
"""只读检查 Linux Runtime Host 的必需能力。"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path


REQUIRED_COMMANDS = ("qemu-system-x86_64", "qemu-img", "virsh", "ovs-vsctl")
COMMAND_TIMEOUT_SECONDS = 4


@dataclass(frozen=True)
class CheckResult:
    """表示单项预检结果。"""

    name: str
    ok: bool
    detail: str
    code: str


def command_version(command: str) -> CheckResult:
    """检查命令是否存在，并读取首行版本。"""
    executable = shutil.which(command)
    if executable is None:
        return CheckResult(command, False, "未找到可执行文件", "COMMAND_MISSING")
    try:
        completed = subprocess.run(
            [executable, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return CheckResult(command, False, "版本查询超时", "COMMAND_TIMEOUT")
    output = (completed.stdout or completed.stderr).splitlines()
    detail = output[0] if output else executable
    return CheckResult(
        command,
        completed.returncode == 0,
        detail,
        "OK" if completed.returncode == 0 else "VERSION_FAILED",
    )


def collect_checks() -> list[CheckResult]:
    """收集所有只读预检结果。"""
    architecture = platform.machine()
    kvm_path = Path("/dev/kvm")
    checks = [
        CheckResult(
            "architecture",
            architecture == "x86_64",
            architecture,
            "OK" if architecture == "x86_64" else "ARCH_UNSUPPORTED",
        ),
        CheckResult(
            "kvm",
            kvm_path.exists() and os.access(kvm_path, os.R_OK | os.W_OK),
            "可读写"
            if kvm_path.exists() and os.access(kvm_path, os.R_OK | os.W_OK)
            else "不存在或当前用户不可读写",
            "OK"
            if kvm_path.exists() and os.access(kvm_path, os.R_OK | os.W_OK)
            else "KVM_UNAVAILABLE",
        ),
    ]
    checks.extend(command_version(command) for command in REQUIRED_COMMANDS)
    return checks


def main() -> int:
    """执行预检并可选写出 JSON 证据。"""
    parser = argparse.ArgumentParser(description="SimLab Runtime Host 只读预检")
    parser.add_argument("--json", type=Path, dest="json_path", help="写出 JSON 结果")
    arguments = parser.parse_args()
    checks = collect_checks()
    payload = {
        "schema_version": "1.0",
        "observed_at": datetime.now(UTC).isoformat(),
        "passed": all(check.ok for check in checks),
        "checks": [asdict(check) for check in checks],
    }
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if arguments.json_path is not None:
        arguments.json_path.parent.mkdir(parents=True, exist_ok=True)
        arguments.json_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
