# -*- coding: utf-8 -*-
"""生产环境设置与安全断言。"""

import os

from django.core.exceptions import ImproperlyConfigured

from config.settings.base import *  # noqa: F403

if os.environ.get("SIMLAB_RUNTIME_MODE") != "runtime_real":
    raise ImproperlyConfigured("生产环境必须设置 SIMLAB_RUNTIME_MODE=runtime_real")
if SECRET_KEY == "development-only-change-me":  # noqa: F405
    raise ImproperlyConfigured("生产环境必须配置 DJANGO_SECRET_KEY")
if DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":  # noqa: F405
    raise ImproperlyConfigured("生产环境必须配置 PostgreSQL DATABASE_URL")

DEBUG = False
G0_PC1_BRIDGE_ENABLED = os.environ.get("SIMLAB_G0_PC1_BRIDGE_ENABLED", "0") == "1"
DESKTOP_RUNTIME_BRIDGE_ENABLED = (
    os.environ.get("SIMLAB_DESKTOP_RUNTIME_BRIDGE_ENABLED", "0") == "1"
)
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [CHANNEL_REDIS_URL], "prefix": CHANNEL_LAYER_PREFIX},  # noqa: F405
    }
}
