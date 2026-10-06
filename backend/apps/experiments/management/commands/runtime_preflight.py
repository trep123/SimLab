# -*- coding: utf-8 -*-
"""从 Django 入口执行只读 Runtime 预检。"""

import json
from dataclasses import asdict

from django.core.management.base import BaseCommand, CommandError
from ops.linux.preflight import collect_checks


class Command(BaseCommand):
    """检查目标节点能力，不执行安装或修复。"""

    help = "检查 Runtime Host 的 KVM、QEMU、libvirt 与 OVS 能力"

    def handle(self, *args: object, **options: object) -> None:
        """执行共享预检函数并输出结构化结果。"""
        checks = collect_checks()
        payload = {
            "passed": all(check.ok for check in checks),
            "checks": [asdict(check) for check in checks],
        }
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
        if not payload["passed"]:
            raise CommandError("Runtime Host 未通过预检")
