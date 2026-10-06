# -*- coding: utf-8 -*-
"""实验应用配置。"""

from django.apps import AppConfig


class ExperimentsConfig(AppConfig):
    """注册实验领域应用。"""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.experiments"
