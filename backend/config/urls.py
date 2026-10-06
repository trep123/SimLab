# -*- coding: utf-8 -*-
"""SimLab HTTP 路由。"""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("apps.experiments.urls")),
]
