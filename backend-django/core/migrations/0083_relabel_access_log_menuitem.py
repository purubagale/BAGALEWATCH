# Data migration -- relabels the existing "Access Log" MenuItem in place
# (2026-10-01, "Audit Log" follow-up: "currently there is only access
# events log, also add feature of audit log with All system activity,
# data changes, and access events"). Confirmed with the user: this
# REPLACES Access Log rather than adding a second, overlapping sidebar
# item -- one page, retitled, now showing both access events (AuthEventLog)
# and data-change events (the new AuditEvent, see 0082_audit_event.py)
# merged together. See AuditLogListView's docstring (core/audit.py).
#
# Same path (`/a3x9lq`) and MenuItem id as before -- only label/
# description/icon change, so no opaque-route or frontend-route-mapping
# change is needed; frontend-react/src/constants/opaqueRoutes.ts's
# '/access-log' dict key is left as-is on purpose (an internal key name,
# not user-visible -- see that file's own comment on this migration).
from django.db import migrations

PATH = '/a3x9lq'

NEW_LABEL = 'Audit Log'
NEW_DESCRIPTION = 'All system activity -- data changes and access events -- in one searchable, exportable log'
NEW_ICON = '📋'

OLD_LABEL = 'Access Log'
OLD_DESCRIPTION = 'Login/access audit trail -- every sign-in attempt, local or SSO, successful or not'
OLD_ICON = '🛡️'


def relabel_forward(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).update(
        label=NEW_LABEL, description=NEW_DESCRIPTION, icon=NEW_ICON,
    )


def relabel_backward(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).update(
        label=OLD_LABEL, description=OLD_DESCRIPTION, icon=OLD_ICON,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0082_audit_event'),
    ]

    operations = [
        migrations.RunPython(relabel_forward, relabel_backward),
    ]
