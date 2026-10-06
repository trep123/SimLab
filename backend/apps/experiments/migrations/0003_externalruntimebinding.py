# -*- coding: utf-8 -*-
"""新增 G0 外部运行单元绑定与命令记录。"""

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    """创建外部 Runtime 绑定表与命令表。"""

    dependencies = [("experiments", "0002_runtimeunit")]

    operations = [
        migrations.CreateModel(
            name="ExternalRuntimeBinding",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("domain_name", models.CharField(max_length=80, unique=True)),
                ("frontend_device_id", models.CharField(max_length=80)),
                ("model_id", models.CharField(max_length=80)),
                ("display_name", models.CharField(max_length=120)),
                ("observed_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
        ),
        migrations.CreateModel(
            name="ExternalRuntimeCommand",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("domain_name", models.CharField(max_length=80)),
                ("frontend_device_id", models.CharField(blank=True, max_length=80)),
                ("type", models.CharField(max_length=40)),
                ("payload", models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("QUEUED", "已排队"),
                            ("RUNNING", "执行中"),
                            ("SUCCEEDED", "成功"),
                            ("FAILED", "失败"),
                        ],
                        default="QUEUED",
                        max_length=20,
                    ),
                ),
                ("result", models.JSONField(default=dict)),
                ("error", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={"ordering": ("-created_at",)},
        ),
    ]
