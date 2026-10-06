# -*- coding: utf-8 -*-
"""只读诊断所需的管理后台注册。"""

from django.contrib import admin

from apps.experiments.models import (
    Command,
    DeviceInstance,
    DeviceModelRelease,
    Experiment,
    ExperimentEvent,
    RuntimeUnit,
)

admin.site.register(
    (Experiment, DeviceModelRelease, DeviceInstance, RuntimeUnit, Command, ExperimentEvent)
)
