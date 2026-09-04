from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('core', '0041_seed_telemetry_menuitems'),
    ]
    operations = [
        migrations.AlterField(
            model_name='menuitem',
            name='path',
            field=models.CharField(max_length=300, unique=True),
        ),
    ]
