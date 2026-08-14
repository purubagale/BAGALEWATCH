"""Shared helper for decoding a base64 data-URL image upload.

This app's file-upload convention is deliberately base64-JSON, never
multipart/form-data — see BrandingSettingsView's docstring in views.py
for why (the shared apiFetch() client force-sets
Content-Type: application/json on any request with a body, which would
corrupt a real multipart upload). Every feature that lets a user upload
an image (the org-wide branding logo, and per-menu-item icon images,
2026-08-08) goes through this one function instead of each re-implementing
its own decode/validate logic.

Security hardening (2026-08-08, "secure the system... against unauthorized
access and tampering" follow-up): the original version of this function
trusted the CLIENT-DECLARED `data:<mime>;base64,...` header to decide
whether the payload was really an image — nothing stopped someone from
labeling arbitrary bytes `image/png` and having them decoded and written
to disk under `MEDIA_ROOT` regardless of actual content. It now (1)
restricts accepted types to a fixed whitelist of raster formats, and (2)
verifies the decoded bytes actually parse as one of those formats via
Pillow before accepting them, rather than trusting the label alone.
"""
import base64
import io

from PIL import Image, UnidentifiedImageError

# Deliberately excludes 'svg+xml': an SVG is XML, not a raster image, and
# can embed a <script> tag that executes if the uploaded file is ever
# opened directly in a browser tab (e.g. a user right-clicks an icon and
# picks "open image in new tab") rather than only ever used inside an
# <img> element — a real stored-XSS vector for a feature whose whole job
# is accepting arbitrary uploaded files. PNG/JPEG/GIF/WEBP have no
# equivalent script-execution risk.
ALLOWED_IMAGE_FORMATS = {'PNG': 'png', 'JPEG': 'jpg', 'GIF': 'gif', 'WEBP': 'webp'}
ALLOWED_MIME_PREFIXES = {'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'}


class DataUrlImageError(ValueError):
    """Raised for any malformed/oversized/non-image/disallowed-format data
    URL. Callers translate this into whatever error shape their own API
    uses (a plain Response for an APIView, a serializers.ValidationError
    for a serializer) — this module deliberately doesn't import DRF so it
    stays usable from either context."""


def decode_data_url_image(data_url: str, max_bytes: int) -> tuple[bytes, str]:
    """Returns (raw_bytes, file_extension). Raises DataUrlImageError on
    anything that isn't a well-formed `data:image/<type>;base64,<data>`
    string, within `max_bytes` once decoded, whose DECODED CONTENT Pillow
    can actually parse as one of ALLOWED_IMAGE_FORMATS — the declared mime
    type in the data URL is only used for an early/cheap rejection, never
    trusted on its own to decide what gets written to disk."""
    try:
        header, encoded = data_url.split(',', 1)
        mime = header.split(':', 1)[1].split(';', 1)[0].lower()
    except (ValueError, IndexError):
        raise DataUrlImageError('Not a valid data URL.')
    if mime not in ALLOWED_MIME_PREFIXES:
        raise DataUrlImageError('File must be a PNG, JPEG, GIF, or WEBP image.')
    try:
        raw = base64.b64decode(encoded)
    except (ValueError, TypeError):
        raise DataUrlImageError('Could not decode image data.')
    if len(raw) > max_bytes:
        raise DataUrlImageError(f'Image is too large (max {max_bytes // (1024 * 1024)}MB).')

    # Content verification, not just label-trusting (see module docstring)
    # — Image.verify() confirms the file is a structurally valid image of
    # a recognized format without fully decoding pixel data. A fresh
    # BytesIO/Image is opened for the format check afterward because
    # Pillow documents verify() as leaving the file object unusable for
    # anything else.
    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()
        fmt = Image.open(io.BytesIO(raw)).format
    except (UnidentifiedImageError, OSError, ValueError):
        raise DataUrlImageError('The uploaded file is not a valid image.')
    if fmt not in ALLOWED_IMAGE_FORMATS:
        raise DataUrlImageError('File must be a PNG, JPEG, GIF, or WEBP image.')

    return raw, ALLOWED_IMAGE_FORMATS[fmt]
