# -*- coding: utf-8 -*-
"""Celery 应用配置。"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.local")
app = Celery("simlab")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
