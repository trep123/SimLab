# -*- coding: utf-8 -*-
"""实验 API 路由。"""

from django.urls import path

from apps.experiments.api import (
    CapabilityView,
    CloudUplinkListView,
    CommandDetailView,
    CommandSubmitView,
    CsrfView,
    DesktopRuntimeBindingView,
    DesktopRuntimeDetailView,
    DesktopRuntimeLifecycleView,
    DesktopRuntimeListView,
    RuntimeImageImportView,
    RuntimeVendorImageRegisterView,
    RuntimeConsoleTicketView,
    DesktopRuntimePowerView,
    DesktopRuntimeReleaseView,
    EventListView,
    ExperimentDocumentView,
    ExperimentListView,
    ExperimentMemberDetailView,
    ExperimentMemberListView,
    ExperimentStateView,
    G0Pc1BindingView,
    G0Pc1PowerView,
    LiveHealthView,
    LoginView,
    LogoutView,
    MeView,
    ModelListView,
    ReadyHealthView,
    SnapshotListView,
)

urlpatterns = [
    path("health/live/", LiveHealthView.as_view()),
    path("health/ready/", ReadyHealthView.as_view()),
    path("auth/csrf/", CsrfView.as_view()),
    path("auth/login/", LoginView.as_view()),
    path("auth/logout/", LogoutView.as_view()),
    path("auth/me/", MeView.as_view()),
    path("experiments/", ExperimentListView.as_view()),
    path(
        "experiments/<uuid:experiment_id>/document/",
        ExperimentDocumentView.as_view(),
    ),
    path(
        "experiments/<uuid:experiment_id>/members/",
        ExperimentMemberListView.as_view(),
    ),
    path(
        "experiments/<uuid:experiment_id>/members/<int:user_id>/",
        ExperimentMemberDetailView.as_view(),
    ),
    path("experiments/<uuid:experiment_id>/state/", ExperimentStateView.as_view()),
    path("experiments/<uuid:experiment_id>/commands/", CommandSubmitView.as_view()),
    path(
        "experiments/<uuid:experiment_id>/commands/<uuid:command_id>/", CommandDetailView.as_view()
    ),
    path("experiments/<uuid:experiment_id>/events/", EventListView.as_view()),
    path("experiments/<uuid:experiment_id>/snapshots/", SnapshotListView.as_view()),
    path("device-models/", ModelListView.as_view()),
    path("runtime/capabilities/", CapabilityView.as_view()),
    path("runtime/cloud-uplinks/", CloudUplinkListView.as_view()),
    path("runtime/g0-pc1/", G0Pc1BindingView.as_view()),
    path("runtime/g0-pc1/power/", G0Pc1PowerView.as_view()),
    path("runtime/desktops/", DesktopRuntimeListView.as_view()),
    path("runtime/images/import/", RuntimeImageImportView.as_view()),
    path("runtime/images/register-directory/", RuntimeVendorImageRegisterView.as_view()),
    path("runtime/desktops/release/", DesktopRuntimeReleaseView.as_view()),
    path("runtime/desktops/<uuid:runtime_id>/", DesktopRuntimeDetailView.as_view()),
    path("runtime/desktops/<uuid:runtime_id>/console/", RuntimeConsoleTicketView.as_view()),
    path(
        "runtime/desktops/<uuid:runtime_id>/lifecycle/",
        DesktopRuntimeLifecycleView.as_view(),
    ),
    path(
        "runtime/desktops/<uuid:runtime_id>/binding/",
        DesktopRuntimeBindingView.as_view(),
    ),
    path(
        "runtime/desktops/<uuid:runtime_id>/power/",
        DesktopRuntimePowerView.as_view(),
    ),
]
