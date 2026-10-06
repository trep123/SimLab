# -*- coding: utf-8 -*-
"""SimLab 通用 Django 设置。"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parents[2]
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "development-only-change-me")
DEBUG = False
ALLOWED_HOSTS = [
    item
    for item in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if item
]
CSRF_TRUSTED_ORIGINS = [
    item for item in os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if item
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "channels",
    "apps.experiments",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if DATABASE_URL.startswith(("postgres://", "postgresql://")):
    parsed_database_url = urlparse(DATABASE_URL)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": parsed_database_url.path.lstrip("/"),
            "USER": parsed_database_url.username,
            "PASSWORD": parsed_database_url.password,
            "HOST": parsed_database_url.hostname,
            "PORT": parsed_database_url.port or 5432,
            "CONN_MAX_AGE": 60,
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR.parent / "runtime-data" / "simlab.sqlite3",
        }
    }
AUTH_PASSWORD_VALIDATORS = []
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = Path(os.environ.get("SIMLAB_STATIC_ROOT", "/var/lib/simlab/app/static"))
RUNTIME_IMAGE_IMPORT_ROOT = Path(
    os.environ.get("SIMLAB_IMAGE_IMPORT_ROOT", "/var/lib/simlab/image-store/imported")
)
RUNTIME_VENDOR_IMAGE_ROOT = Path(
    os.environ.get("SIMLAB_VENDOR_IMAGE_ROOT", "/var/lib/simlab/image-store/vendor")
)
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "EXCEPTION_HANDLER": "apps.experiments.api.simlab_exception_handler",
}
CSRF_FAILURE_VIEW = "apps.experiments.api.csrf_failure"
RUNTIME_MODE = os.environ.get("SIMLAB_RUNTIME_MODE", "development_mock")
CLOUD_UPLINK_BRIDGES = tuple(
    name.strip() for name in os.environ.get("SIMLAB_CLOUD_UPLINK_BRIDGES", "").split(",")
    if name.strip()
)
HOST_AGENT_SOCKET = Path(os.environ.get("SIMLAB_HOST_AGENT_SOCKET", "/run/simlab/host-agent.sock"))
HOST_AGENT_CONSOLE_SOCKET = Path(
    os.environ.get("SIMLAB_HOST_AGENT_CONSOLE_SOCKET", "/run/simlab/console.sock")
)
HOST_AGENT_TIMEOUT_SECONDS = float(os.environ.get("SIMLAB_HOST_AGENT_TIMEOUT_SECONDS", "180"))
APPROVED_RUNTIME_PROFILE_RELEASES = frozenset({
    "linux-cloud-profile-v1",
    "linux-switch-profile-v1",
    "linux-router-profile-v1",
    "linux-firewall-profile-v1",
})
G0_PC1_BRIDGE_ENABLED = False
DESKTOP_RUNTIME_BRIDGE_ENABLED = False
G0_PC1_DOMAIN = os.environ.get("SIMLAB_G0_PC1_DOMAIN", "simlab-g0-pc1")
G0_PC1_NOVNC_URL = os.environ.get(
    "SIMLAB_G0_PC1_NOVNC_URL",
    "/g0-novnc/vnc.html?autoconnect=1&resize=scale&path=g0-novnc/websockify",
)
DESKTOP_EXTERNAL_DOMAINS = tuple(
    item.strip()
    for item in os.environ.get(
        "SIMLAB_DESKTOP_EXTERNAL_DOMAINS", "simlab-g0-pc1,simlab-g0-pc2"
    ).split(",")
    if item.strip()
)
NETWORK_EXTERNAL_DOMAINS = tuple(
    entry.strip()
    for entry in os.environ.get("SIMLAB_NETWORK_EXTERNAL_DOMAINS", "").split(",")
    if entry.strip()
)
DESKTOP_NOVNC_BASE_URL = os.environ.get("SIMLAB_DESKTOP_NOVNC_BASE_URL", "/novnc/vnc.html")
CELERY_BROKER_URL = os.environ.get(
    "CELERY_BROKER_URL", os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
)
CHANNEL_REDIS_URL = os.environ.get("CHANNEL_REDIS_URL", "redis://127.0.0.1:6379/1")
EVENT_STREAM_REDIS_URL = os.environ.get("EVENT_STREAM_REDIS_URL", "redis://127.0.0.1:6379/2")
EVENT_STREAM_KEY = os.environ.get("SIMLAB_EVENT_STREAM_KEY", "simlab:events:v1")
EVENT_STREAM_GROUP = os.environ.get("SIMLAB_EVENT_STREAM_GROUP", "simlab-event-relay-v1")
CHANNEL_LAYER_PREFIX = os.environ.get("SIMLAB_CHANNEL_PREFIX", "simlab")
if RUNTIME_MODE == "runtime_real" or os.environ.get("SIMLAB_CHANNEL_LAYER") == "redis":
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [CHANNEL_REDIS_URL], "prefix": CHANNEL_LAYER_PREFIX},
        }
    }
else:
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
CELERY_TASK_ALWAYS_EAGER = RUNTIME_MODE == "development_mock"
CSRF_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SAMESITE = "Lax"
LOGIN_RATE_LIMIT_PER_MINUTE = 10
