# -*- coding: utf-8 -*-
"""核对真实 Runtime、Host Agent 与已保存闭环证据。"""

import json
import uuid
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from runtime.real_client import HostAgentClientError, RealRuntimeClient

EXPECTED_IMAGE_RELEASE = "ubuntu-noble-20260725"
REQUIRED_EVIDENCE = (
    "docs/poc/g0-evidence.json",
    "docs/poc/host-agent-evidence.json",
    "docs/poc/control-plane-runtime-evidence.json",
    "docs/poc/event-pipeline-evidence.json",
    "docs/poc/websocket-pipeline-evidence.json",
)


class Command(BaseCommand):
    """阻止把开发 mock 当作真实 Runtime 证据。"""

    help = "验证真实 Runtime 回路已启用"

    def add_arguments(self, parser: object) -> None:
        """限制为当前已登记的本机节点和固定镜像版本。"""
        parser.add_argument("--host", default="local")
        parser.add_argument("--image-release", default=EXPECTED_IMAGE_RELEASE)

    def handle(self, *args: object, **options: object) -> None:
        """实际查询 Agent，并校验三个不可由 mock 代替的证据文件。"""
        if settings.RUNTIME_MODE != "runtime_real":
            raise CommandError("当前为 development_mock；不能生成真实 Runtime 验收结果")
        if options["host"] != "local":
            raise CommandError("当前版本只登记 local Unix Socket Runtime Host")
        if options["image_release"] != EXPECTED_IMAGE_RELEASE:
            raise CommandError("image-release 与当前固定验收镜像不一致")
        try:
            preflight = RealRuntimeClient(
                settings.HOST_AGENT_SOCKET, settings.HOST_AGENT_TIMEOUT_SECONDS
            ).preflight(uuid.uuid4())
        except HostAgentClientError as error:
            raise CommandError(f"Host Agent 预检失败 [{error.code}]：{error.message}") from error
        evidence_summary: list[dict[str, object]] = []
        project_root = Path(settings.BASE_DIR).parent
        for relative_path in REQUIRED_EVIDENCE:
            evidence_path = project_root / relative_path
            try:
                evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise CommandError(f"无法读取 Runtime 证据：{relative_path}") from error
            if evidence.get("passed") is not True:
                raise CommandError(f"Runtime 证据未通过：{relative_path}")
            evidence_summary.append(
                {
                    "path": relative_path,
                    "gate": evidence.get("gate"),
                    "completed_at": evidence.get("completed_at"),
                }
            )
        report = {
            "passed": True,
            "host": options["host"],
            "image_release": options["image_release"],
            "preflight": preflight,
            "evidence": evidence_summary,
        }
        self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
