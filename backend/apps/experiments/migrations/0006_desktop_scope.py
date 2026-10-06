import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("experiments", "0005_experiment_document_json"),
    ]

    operations = [
        migrations.AddField(
            model_name="virtualruntimeinstance",
            name="bound_experiment",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="desktop_bindings", to="experiments.experiment",
            ),
        ),
        migrations.AddField(
            model_name="virtualruntimeinstance",
            name="owner_user",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="owned_desktop_runtimes", to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
