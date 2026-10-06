# -*- coding: utf-8 -*-
"""本地开发设置。"""

import os

from config.settings.base import *  # noqa: F403

DEBUG = True
G0_PC1_BRIDGE_ENABLED = os.environ.get("SIMLAB_G0_PC1_BRIDGE_ENABLED", "1") == "1"
DESKTOP_RUNTIME_BRIDGE_ENABLED = os.environ.get("SIMLAB_DESKTOP_RUNTIME_BRIDGE_ENABLED", "1") == "1"
CSRF_TRUSTED_ORIGINS = [
    origin
    for origin in os.environ.get(
        "DJANGO_CSRF_TRUSTED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5181,http://127.0.0.1:5181",
    ).split(",")
    if origin
]
