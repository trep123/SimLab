import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("experiments", "0006_desktop_scope"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="RuntimeImage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("image_release", models.CharField(max_length=80, unique=True)),
                ("display_name", models.CharField(max_length=120)),
                ("appliance_role", models.CharField(max_length=16)),
                ("sha256", models.CharField(max_length=64)),
                ("size_bytes", models.PositiveBigIntegerField()),
                ("virtual_size_bytes", models.PositiveBigIntegerField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("uploaded_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="uploaded_runtime_images", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ("-created_at",)},
        ),
    ]
