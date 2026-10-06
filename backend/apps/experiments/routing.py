# -*- coding: utf-8 -*-
"""实验 WebSocket 路由。"""

from django.urls import path

from apps.experiments.consumers import (
    ExperimentConsumer, RuntimeConsoleConsumer, RuntimeVncConsumer,
)

websocket_urlpatterns = [
    path("ws/experiments/<uuid:experiment_id>/", ExperimentConsumer.as_asgi()),
    path("ws/runtime-vnc/<uuid:runtime_id>/", RuntimeVncConsumer.as_asgi()),
    path("ws/runtime-console/<uuid:runtime_id>/", RuntimeConsoleConsumer.as_asgi()),
]
