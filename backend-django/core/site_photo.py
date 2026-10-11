"""Site photos from the mobile app (2026-10-11).

A staff member stands at a site, points the phone along a sector and takes
a photo. The app sends the picture with the compass bearing, position,
altitude and the signal reading at that moment. DT-WATCH shows it on the
site page next to the sector's planned azimuth.

Trust: the app has no staff login ("I am an NTC employee" is a checkbox),
so the server cannot tell an engineer from anyone who installed the app.
Three things stand in for that:

  * only a registered phone can upload (signed request, core/device_auth.py),
    so every photo is tied to a number;
  * the phone must be within MAX_DISTANCE_M of the site it names;
  * every upload starts PENDING and is shown to nobody but admins until one
    of them approves it.

The picture is re-encoded on arrival. That proves it is an image, caps its
size, and drops whatever metadata the phone's camera wrote into it.

Device endpoints (signed), under /api/telemetry/v1/device/:
    GET  nearby-sites/?lat=&lon=   sites close to the phone, with their
                                   planned directions
    POST site-photos/              one photo

Web endpoints (login), under /api/v2/:
    GET    site-photos/?site=&status=
    GET    site-photos/<id>/image/
    POST   site-photos/<id>/review/     {"action": "approve" | "reject"}
    DELETE site-photos/<id>/
"""
import base64
import binascii
import io
from datetime import datetime, timedelta, timezone as dt_timezone

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.http import FileResponse
from django.utils import timezone
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .device_auth import DeviceSignatureAuthentication, IsDevice
from .models import Site, SitePhoto
from .views import IsAdminOrSuperadmin

# The phone must be this close to the site it names. Wide enough for a
# photo taken from a neighbouring roof, far too narrow to tag a site from
# somewhere else.
MAX_DISTANCE_M = 1000
NEARBY_SITE_LIMIT = 5
# Load limits. The app sends about 0.5 MB at 1600 px; these leave room
# around that and refuse anything that would cost real memory or disk.
MAX_IMAGE_BYTES = 2 * 1024 * 1024
# Checked from the header before any pixel is decoded: a small file can
# unpack into a very large bitmap.
MAX_IMAGE_PIXELS = 8_000_000
MAX_IMAGE_SIDE_PX = 1600
THUMB_SIDE_PX = 480
JPEG_QUALITY = 82
THUMB_QUALITY = 70
MAX_UPLOADS_PER_DAY = 100           # one phone
MAX_UPLOADS_PER_DAY_ALL = 5000      # every phone together
# New uploads are refused while this many wait for review, so an unattended
# queue cannot grow without limit.
MAX_PENDING = 2000
PAGE_SIZE = 60
# Kept this long, then removed by the daily maintenance run.
REJECTED_RETENTION_DAYS = 30
PENDING_RETENTION_DAYS = 90
# A bearing further than this from the planned azimuth is flagged on the
# site page. Below it the difference is within what a phone compass can do.
AZIMUTH_FLAG_DEG = 20

_SIGNAL_NUMBERS = ('rsrp', 'rsrq', 'sinr', 'pci', 'cqi')
_SIGNAL_TEXT = ('network_type', 'cell_id')


def _number(raw, lo, hi):
    """A float within [lo, hi], or None when missing or out of range."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value or not lo <= value <= hi:  # value != value is NaN
        return None
    return value


def planned_directions(site):
    """The site's distinct planned azimuths, each with the sectors that
    point that way: [{'azimuth': 145.0, 'sectors': 'J3, J20'}, ...]. One
    antenna direction usually carries several cells across bands, so the
    engineer picks a direction, not a cell."""
    by_azimuth = {}
    for name, azimuth in site.sectors.exclude(azimuth__isnull=True).values_list('sector', 'azimuth'):
        names = by_azimuth.setdefault(round(azimuth) % 360, [])
        if name and name not in names:
            names.append(name)
    return [
        {'azimuth': float(azimuth), 'sectors': ', '.join(sorted(names)[:8])}
        for azimuth, names in sorted(by_azimuth.items())
    ]


def azimuth_difference(bearing, azimuth):
    """Smallest angle between two compass directions, 0 to 180."""
    if bearing is None or azimuth is None:
        return None
    diff = abs(bearing - azimuth) % 360
    return round(min(diff, 360 - diff), 1)


def delete_photo(photo):
    """Removes the row and both stored files."""
    photo.file.delete(save=False)
    if photo.thumb:
        photo.thumb.delete(save=False)
    photo.delete()


def prune_old_photos(dry_run=False):
    """Deletes rejected photos after REJECTED_RETENTION_DAYS and photos
    nobody reviewed after PENDING_RETENTION_DAYS. Approved photos are kept.
    Returns (rejected_removed, pending_removed)."""
    now = timezone.now()
    rejected = SitePhoto.objects.filter(
        status=SitePhoto.STATUS_REJECTED, reviewed_at__lt=now - timedelta(days=REJECTED_RETENTION_DAYS),
    )
    pending = SitePhoto.objects.filter(
        status=SitePhoto.STATUS_PENDING, created_at__lt=now - timedelta(days=PENDING_RETENTION_DAYS),
    )
    counts = (rejected.count(), pending.count())
    if not dry_run:
        for photo in list(rejected) + list(pending):
            delete_photo(photo)
    return counts


def _mask(msisdn):
    return f'…{msisdn[-4:]}' if len(msisdn) >= 4 else ''


def _photo_row(photo, for_admin):
    row = {
        'id': photo.pk,
        'site_id': photo.site_id,
        'site_name': photo.site.name,
        'bearing_deg': photo.bearing_deg,
        'planned_azimuth': photo.planned_azimuth,
        'azimuth_difference': azimuth_difference(photo.bearing_deg, photo.planned_azimuth),
        'azimuth_flag_deg': AZIMUTH_FLAG_DEG,
        'sector_label': photo.sector_label,
        'lat': photo.lat,
        'lng': photo.lng,
        'accuracy_m': photo.accuracy_m,
        'altitude_m': photo.altitude_m,
        'distance_to_site_m': photo.distance_to_site_m,
        'taken_at': photo.taken_at,
        'signal': photo.signal,
        'note': photo.note,
        'status': photo.status,
        'width': photo.width,
        'height': photo.height,
    }
    if for_admin:
        row['uploader'] = _mask(photo.uploader_msisdn)
        row['created_at'] = photo.created_at
        row['reviewed_by'] = photo.reviewed_by.username if photo.reviewed_by else ''
        row['reviewed_at'] = photo.reviewed_at
    return row


def _is_admin(user):
    return getattr(user, 'role', '') in ('superadmin', 'admin')


class DeviceNearbySitesView(APIView):
    """The sites within MAX_DISTANCE_M of the phone, nearest first, for the
    app's site picker. Returns nothing for a position that is not near a
    site, so this cannot be used to read out the site list."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def get(self, request):
        lat = _number(request.query_params.get('lat'), -90, 90)
        lon = _number(request.query_params.get('lon'), -180, 180)
        if lat is None or lon is None:
            return Response({'detail': 'lat and lon are required.'}, status=400)
        point = Point(lon, lat, srid=4326)
        sites = (
            Site.objects.filter(location__distance_lte=(point, D(m=MAX_DISTANCE_M)))
            .annotate(distance=Distance('location', point))
            .order_by('distance')[:NEARBY_SITE_LIMIT]
        )
        return Response({
            'sites': [
                {
                    'id': site.pk,
                    'name': site.name,
                    'distance_m': round(site.distance.m),
                    'directions': planned_directions(site),
                }
                for site in sites
            ],
        })


class DeviceSitePhotoUploadView(APIView):
    """One photo from a registered phone. JSON, with the picture as base64
    JPEG, so the request is signed the same way as every other device call."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request):
        device = request.user
        data = request.data if isinstance(request.data, dict) else {}

        today = f'{timezone.now():%Y%m%d}'
        day_key = f'sitephoto:{device.device_hash}:{today}'
        all_key = f'sitephoto:all:{today}'
        if cache.get(day_key, 0) >= MAX_UPLOADS_PER_DAY or cache.get(all_key, 0) >= MAX_UPLOADS_PER_DAY_ALL:
            return Response({'detail': 'Daily photo limit reached. Try again tomorrow.'}, status=429)
        if SitePhoto.objects.filter(status=SitePhoto.STATUS_PENDING).count() >= MAX_PENDING:
            return Response(
                {'detail': 'Too many photos are waiting for review. Try again later.'}, status=429,
            )

        bearing = _number(data.get('bearing_deg'), 0, 360)
        lat = _number(data.get('lat'), -90, 90)
        lon = _number(data.get('lon'), -180, 180)
        if bearing is None or lat is None or lon is None:
            return Response({'detail': 'bearing_deg, lat and lon are required.'}, status=400)

        point = Point(lon, lat, srid=4326)
        site = (
            Site.objects.filter(pk=str(data.get('site_id', '')), location__distance_lte=(point, D(m=MAX_DISTANCE_M)))
            .annotate(distance=Distance('location', point))
            .first()
        )
        if site is None:
            return Response({'detail': 'This phone is not near that site.'}, status=400)

        try:
            raw = base64.b64decode(str(data.get('image_b64', '')), validate=True)
        except (binascii.Error, ValueError):
            return Response({'detail': 'The picture could not be read.'}, status=400)
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            return Response({'detail': 'The picture is missing or too large.'}, status=400)
        try:
            image = Image.open(io.BytesIO(raw))  # reads the header only
            if image.format != 'JPEG':
                return Response({'detail': 'The picture must be a JPEG.'}, status=400)
            if image.width * image.height > MAX_IMAGE_PIXELS:
                return Response({'detail': 'The picture is too large.'}, status=400)
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((MAX_IMAGE_SIDE_PX, MAX_IMAGE_SIDE_PX))
            out = io.BytesIO()
            image.save(out, format='JPEG', quality=JPEG_QUALITY)
            small = image.copy()
            small.thumbnail((THUMB_SIDE_PX, THUMB_SIDE_PX))
            thumb_out = io.BytesIO()
            small.save(thumb_out, format='JPEG', quality=THUMB_QUALITY)
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            return Response({'detail': 'The picture could not be read.'}, status=400)

        # The phone's clock is not trusted far: a time outside the last day
        # is replaced by the server's.
        now = timezone.now()
        taken_at = now
        taken_ms = _number(data.get('taken_at'), 0, 4_102_444_800_000)
        if taken_ms is not None:
            candidate = datetime.fromtimestamp(taken_ms / 1000, tz=dt_timezone.utc)
            if now - timedelta(days=1) <= candidate <= now + timedelta(minutes=5):
                taken_at = candidate

        signal_in = data.get('signal') if isinstance(data.get('signal'), dict) else {}
        signal = {}
        for key in _SIGNAL_NUMBERS:
            value = _number(signal_in.get(key), -200, 100000)
            if value is not None:
                signal[key] = value
        for key in _SIGNAL_TEXT:
            if signal_in.get(key) not in (None, ''):
                signal[key] = str(signal_in[key])[:40]

        photo = SitePhoto(
            site=site,
            size_bytes=out.tell(),
            width=image.width,
            height=image.height,
            bearing_deg=bearing % 360,
            lat=lat,
            lng=lon,
            accuracy_m=_number(data.get('accuracy_m'), 0, 100000),
            altitude_m=_number(data.get('altitude_m'), -500, 10000),
            distance_to_site_m=round(site.distance.m),
            taken_at=taken_at,
            planned_azimuth=_number(data.get('planned_azimuth'), 0, 360),
            sector_label=str(data.get('sector_label') or '')[:200],
            signal=signal,
            note=str(data.get('note') or '')[:300],
            device=device,
            uploader_msisdn=device.msisdn,
        )
        photo.file.save('photo.jpg', ContentFile(out.getvalue()), save=False)
        photo.thumb.save('thumb.jpg', ContentFile(thumb_out.getvalue()), save=False)
        photo.save()

        for key in (day_key, all_key):
            cache.add(key, 0, timeout=86400)
            cache.incr(key)
        return Response({'id': photo.pk, 'status': photo.status}, status=201)


class SitePhotoListView(APIView):
    """Photos for the site page and the review page. Anyone signed in sees
    approved photos; pending and rejected ones are for admins only."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        for_admin = _is_admin(request.user)
        qs = SitePhoto.objects.select_related('site', 'reviewed_by')
        site_id = request.query_params.get('site')
        if site_id:
            qs = qs.filter(site_id=site_id)
        wanted = request.query_params.get('status', '')
        if not for_admin:
            qs = qs.filter(status=SitePhoto.STATUS_APPROVED)
        elif wanted in dict(SitePhoto.STATUS_CHOICES):
            qs = qs.filter(status=wanted)
        offset = int(_number(request.query_params.get('offset'), 0, 10_000_000) or 0)
        total = qs.count()
        rows = [_photo_row(photo, for_admin) for photo in qs[offset:offset + PAGE_SIZE]]
        payload = {'photos': rows, 'can_review': for_admin, 'total': total, 'page_size': PAGE_SIZE}
        if for_admin:
            payload['pending_count'] = SitePhoto.objects.filter(status=SitePhoto.STATUS_PENDING).count()
        if site_id:
            site = Site.objects.filter(pk=site_id).first()
            payload['directions'] = planned_directions(site) if site else []
        return Response(payload)


def _get_photo(request, pk):
    photo = SitePhoto.objects.select_related('site').filter(pk=pk).first()
    if photo is None:
        return None
    if photo.status != SitePhoto.STATUS_APPROVED and not _is_admin(request.user):
        return None
    return photo


class SitePhotoImageView(APIView):
    """The picture itself. Needs a login; an unapproved one needs an admin."""
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        photo = _get_photo(request, pk)
        if photo is None:
            return Response({'detail': 'Not found.'}, status=404)
        # ?size=thumb is what the lists ask for; the full picture is fetched
        # only when someone opens one.
        want_thumb = request.query_params.get('size') == 'thumb' and photo.thumb
        try:
            file_obj = (photo.thumb if want_thumb else photo.file).open('rb')
        except (FileNotFoundError, ValueError):
            return Response({'detail': 'The stored picture is missing.'}, status=404)
        response = FileResponse(file_obj, content_type='image/jpeg')
        response['Cache-Control'] = 'private, max-age=3600'
        return response


class SitePhotoReviewView(APIView):
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def post(self, request, pk):
        photo = SitePhoto.objects.filter(pk=pk).first()
        if photo is None:
            return Response({'detail': 'Not found.'}, status=404)
        action = request.data.get('action')
        if action not in ('approve', 'reject'):
            return Response({'detail': 'action must be approve or reject.'}, status=400)
        photo.status = SitePhoto.STATUS_APPROVED if action == 'approve' else SitePhoto.STATUS_REJECTED
        photo.reviewed_by = request.user
        photo.reviewed_at = timezone.now()
        photo.save(update_fields=['status', 'reviewed_by', 'reviewed_at'])
        log_audit_event(
            request, f'site_photo_{action}', resource='site_photo', resource_id=str(photo.pk),
            detail=f'{action} photo of site {photo.site_id}',
        )
        return Response({'id': photo.pk, 'status': photo.status})


class SitePhotoDetailView(APIView):
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def delete(self, request, pk):
        photo = SitePhoto.objects.filter(pk=pk).first()
        if photo is None:
            return Response({'detail': 'Not found.'}, status=404)
        site_id = photo.site_id
        delete_photo(photo)
        log_audit_event(
            request, 'site_photo_delete', resource='site_photo', resource_id=str(pk),
            detail=f'deleted photo of site {site_id}',
        )
        return Response(status=204)
