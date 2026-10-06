# -*- coding: utf-8 -*-
"""Runtime 预检的纯函数测试。"""

from ops.linux.preflight import collect_checks


def test_preflight_reports_each_required_command() -> None:
    checks = collect_checks()
    names = {check.name for check in checks}
    assert {
        "architecture",
        "kvm",
        "qemu-system-x86_64",
        "qemu-img",
        "virsh",
        "ovs-vsctl",
    } <= names
