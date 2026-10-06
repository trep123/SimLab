from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("experiments", "0007_runtime_image")]

    operations = [
        migrations.AddField(model_name="runtimeimage", name="vendor_id", field=models.CharField(blank=True, max_length=32)),
        migrations.AddField(model_name="runtimeimage", name="model_id", field=models.CharField(blank=True, max_length=100)),
        migrations.AddField(model_name="runtimeimage", name="source_folder", field=models.CharField(blank=True, max_length=220)),
    ]
