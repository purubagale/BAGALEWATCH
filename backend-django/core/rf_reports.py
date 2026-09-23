"""
Vendor Radio Network Optimization (RNO) report importer (2026-09-15
request: "How can we utilize this report or data of this report in our
application for network optimization and repository").

Two real vendor reports were used to design this (LOT2 at 218MB, LOT6 at
528MB) -- each a Word document containing, alongside ~30 per-cell KPI
pre/post tables, an antenna azimuth/tilt CHANGE LOG table and one or more
open RECOMMENDATION tables (new site/band additions). Scope, per the
user's own explicit choice when this was proposed ("yes scope and build
the importer"): only those two table shapes are extracted here -- the
per-cell KPI tables are a separate, larger follow-up if ever needed.

Minutes-of-Meeting content (2026-09-15 follow-up: "a mom is done
including the reasons not meeting KPI threshold... should be handled
with just attachment") is deliberately NOT parsed by anything in this
module -- see RfReportAttachment's docstring in models.py. It is a plain
file upload via RfOptimizationReportViewSet.attachments below, same as
the source .docx itself.

**Why header-matching, not fixed table position** (see also
RfOptimizationReport's own docstring): a vendor report's table COUNT
shifts between lots depending on how many KPI sections that particular
lot's write-up includes -- confirmed directly: LOT2 and LOT6 do not
place their change-log/recommendation tables at the same table index.
Every function below identifies a table by what its header ROW says,
normalized (lowercased, whitespace collapsed), never by position in the
document, so the next lot's report having a different table count ahead
of the one this cares about doesn't silently break the import.

**2026-09-15 follow-up round, after the first real live test** (see
each helper's own docstring for detail):
  - `_extract_report_metadata` / `_extract_narrative_notes` -- Lot name,
    Network, Period-covered and a notes suggestion are scraped
    best-effort from the document's own title/first-heading text and
    narrative paragraphs, instead of always requiring manual entry.
    Confirmed via AskUserQuestion that this metadata lives on the title
    page, not a cover table or page header/footer.
  - `_looks_recommendation_ish` -- any table that doesn't match the
    strict recommendation-table shape but LOOKS like one (has a
    recommend/remark/propose-ish header) is now still parsed if it has
    a usable identifier column, and always reported back in
    `tables_unmatched` either way -- confirmed via AskUserQuestion that
    the real report has more recommendation-style content than the
    strict matcher alone was catching, without knowing the exact extra
    header shape yet. This makes what's NOT being parsed visible instead
    of silently dropped, so the next real upload can refine the strict
    matcher with an exact header string instead of a guess.
  - `_extract_coords` / `_nearest_site` -- a recommendation row with no
    exact Site/cell-name match (the normal case for a brand-new-site
    proposal) now gets the nearest real Site suggested automatically,
    by distance, using coordinates already present in the row -- still
    fully overridable in the review UI. Confirmed via AskUserQuestion
    ("Yes, auto-suggest nearest").
  - Attachment uploads (RfOptimizationReportViewSet.attachments) are now
    gzip-compressed server-side, and a new flat download endpoint
    (`RfReportAttachmentDetailView`, registered in urls.py) decompresses
    transparently on the way out -- 2026-09-15 follow-up: "allow system
    to save report (with size compressed) also with attachment if
    needed in future for full access".

**Known risk, not yet hit for real**: a 528MB upload plus python-docx
opening/scanning it could in principle run past gunicorn's 120s worker
timeout / nginx's 150s proxy timeout (gunicorn.conf.py / nginx.conf) --
raise both, in lockstep, the same way DATA_UPLOAD_MAX_MEMORY_SIZE and
nginx's client_max_body_size were raised together for this same feature,
if a real upload actually times out. Left alone for now rather than
guessed at, matching this codebase's own established pattern of raising
these numbers from a real observed failure, not a hypothetical one.

**Flow**: `RfReportParsePreviewView` (POST, multipart) parses an
uploaded .docx and returns candidate rows with best-effort Site/Sector
match suggestions -- nothing is saved. The frontend review UI lets an
engineer correct/drop rows and must resolve every recommendation row to
a real Site before submitting. `RfOptimizationReportViewSet.create`
(via `RfOptimizationReportSerializer`) then persists the reviewed rows
as one RfOptimizationReport + its SectorConfigChange rows + one Issue
per recommendation (source_report set) -- see that serializer's
docstring in serializers.py.
"""
import gzip
import mimetypes
import re
import tempfile

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.core.files.base import File
from django.http import FileResponse
from docx import Document
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import RfOptimizationReport, RfReportAttachment, Sector, Site
from .serializers import RfOptimizationReportSerializer, RfReportAttachmentSerializer
from .views import IsAdminOrSuperadmin


def _normalize_header(cell_text):
    return re.sub(r'\s+', ' ', (cell_text or '').strip().lower())


def _row_text(cells):
    return [(cell.text or '').strip() for cell in cells]


def _table_header(table):
    if not table.rows:
        return []
    return [_normalize_header(c.text) for c in table.rows[0].cells]


def _find_col(header, *substrings, exclude=None):
    """First column index whose normalized header contains any of
    `substrings`, skipping one that also contains anything in `exclude`
    -- used so e.g. the "before" azimuth/tilt column (matches 'azimuth'
    or 'tilt') doesn't accidentally grab the "After change" column,
    which also mentions tilt/azimuth-shaped values in some vendor
    reports' header wording."""
    for i, h in enumerate(header):
        if exclude and any(e in h for e in exclude):
            continue
        if any(s in h for s in substrings):
            return i
    return None


def _cell(cells, idx):
    return cells[idx].strip() if idx is not None and idx < len(cells) else ''


def _is_antenna_change_table(header):
    joined = ' '.join(header)
    return (
        'cell name' in joined
        and ('azimuth' in joined or 'tilt' in joined)
        and 'result' in joined
        and 'after' in joined
    )


def _is_recommendation_table(header):
    joined = ' '.join(header)
    # Three real shapes seen: "Cell Name" + "Recommendation" (simple);
    # "Existing Cell" + "Recommended Band" (band upgrade); and the
    # detailed new-site variant, which always carries both Latitude and
    # Longitude alongside one of those same identifying columns.
    if 'cell name' in joined and 'recommendation' in joined:
        return True
    if 'existing cell' in joined and 'recommended band' in joined:
        return True
    if 'latitude' in joined and 'longitude' in joined and ('site name' in joined or 'existing cell' in joined or 'cell name' in joined):
        return True
    return False


def _looks_recommendation_ish(header):
    """Looser near-miss check for a table the strict `_is_recommendation_
    table` above didn't classify but might still be real recommendation/
    remark content (2026-09-15 follow-up: "there are so many
    optimization remarks and recommendation in report. can we use those
    also?" -- confirmed via AskUserQuestion that the real report has
    more recommendation-style tables than what was being captured,
    without a known exact header string to match yet). Deliberately
    broader than `_is_recommendation_table` -- every hit here is
    reported back in the parse-preview response's `tables_unmatched`
    (and actually parsed too, if it has a usable identifier column), so
    what this catches is visible for review rather than a silent guess
    baked into whether data gets used at all."""
    joined = ' '.join(header)
    keywords = ('recommend', 'remark', 'propose', 'suggest', 'optimi', 'action item', 'new site')
    return any(k in joined for k in keywords)


# NOTE: this is a raw string but the degree sign below is the literal
# UTF-8 character (°), not a \u escape -- ° would NOT be
# interpreted inside r'...' and would match six literal backslash/u/0/0/
# b/0 characters instead of a degree sign.
_COORD_PAIR_RE = re.compile(r'(-?\d{1,3}\.\d{3,})\s*°?\s*,\s*(-?\d{1,3}\.\d{3,})\s*°?')
# Nepal's own rough lat/lng extent -- used only to reject an unrelated
# pair of decimals (antenna height/azimuth/etc. already on the same row)
# from masquerading as a coordinate, never to validate a real GPS fix.
_LAT_RANGE = (26.0, 31.0)
_LNG_RANGE = (80.0, 89.0)


def _in_nepal(lat, lng):
    return _LAT_RANGE[0] <= lat <= _LAT_RANGE[1] and _LNG_RANGE[0] <= lng <= _LNG_RANGE[1]


def _extract_coords(header, raw_header, cells):
    """Best-effort (lat, lng) for one recommendation row, used only to
    suggest the nearest existing Site for a brand-new-site proposal
    (2026-09-15 follow-up, confirmed via AskUserQuestion: "Yes,
    auto-suggest nearest"). Tries dedicated Latitude/Longitude columns
    first (the "detailed new-site variant" shape --
    `_is_recommendation_table`'s own docstring); falls back to scanning
    every cell's text for an embedded "26.877579, 87.252231"-style pair,
    since a real recommendation row was seen with coordinates folded
    into a Recommendation-column sentence rather than their own
    columns. Returns (None, None) if nothing plausible is found --
    exactly like no match at all, so this can only ever add a
    suggestion, never break the existing exact-match behavior."""
    idx_lat = _find_col(header, 'latitude')
    idx_lng = _find_col(header, 'longitude')
    if idx_lat is not None and idx_lng is not None:
        try:
            lat, lng = float(_cell(cells, idx_lat)), float(_cell(cells, idx_lng))
            if _in_nepal(lat, lng):
                return lat, lng
        except (TypeError, ValueError):
            pass

    for value in cells:
        for match in _COORD_PAIR_RE.finditer(value or ''):
            try:
                a, b = float(match.group(1)), float(match.group(2))
            except ValueError:
                continue
            if _in_nepal(a, b):
                return a, b
    return None, None


def _nearest_site(lat, lng):
    """Nearest Site to (lat, lng), using the same PostGIS `location`
    geography column/distance annotation as `_nearby_site_ids` in
    serializers.py -- real meters over the whole country's extent, no
    manual haversine. Returns (site, distance_km) or (None, None) if no
    site has a location at all (e.g. an empty/test database)."""
    if lat is None or lng is None:
        return None, None
    point = Point(lng, lat, srid=4326)
    site = (
        Site.objects.filter(location__isnull=False)
        .annotate(distance=Distance('location', point))
        .order_by('distance')
        .first()
    )
    if not site:
        return None, None
    return site, round(site.distance.km, 2)


def _parse_antenna_change_table(table, sector_by_cell):
    header = _table_header(table)
    raw_header = _row_text(table.rows[0].cells)
    idx_sn = _find_col(header, 'sn', 's n', 's no')
    idx_cell = _find_col(header, 'cell name')
    idx_before = _find_col(header, 'azimuth', 'tilt', exclude=['after'])
    idx_after = _find_col(header, 'after')
    idx_result = _find_col(header, 'result')
    idx_type = _find_col(header, 'antenna type')
    idx_shared = _find_col(header, 'shared')

    rows = []
    for row in table.rows[1:]:
        cells = _row_text(row.cells)
        if not any(cells):
            continue
        cell_name = _cell(cells, idx_cell)
        if not cell_name:
            continue
        sn_raw = _cell(cells, idx_sn)
        sn_digits = re.sub(r'\D', '', sn_raw)
        sn = int(sn_digits) if sn_digits else None
        match = sector_by_cell.get(cell_name.lower())
        rows.append({
            'sn': sn,
            'cell_name': cell_name,
            'before_change': _cell(cells, idx_before),
            'after_change': _cell(cells, idx_after),
            'result': _cell(cells, idx_result),
            'antenna_type': _cell(cells, idx_type),
            'antenna_shared_with': _cell(cells, idx_shared),
            'raw_row': dict(zip(raw_header, cells)),
            'matched_sector_id': match.id if match else None,
            'matched_site_id': match.site_id if match else None,
        })
    return rows


def _parse_recommendation_table(table, sector_by_cell, site_by_name):
    header = _table_header(table)
    raw_header = _row_text(table.rows[0].cells)
    idx_identifier = _find_col(header, 'cell name', 'existing cell', 'site name', 'cell id')
    idx_sn = _find_col(header, 'sn', 's n', 's no')

    rows = []
    for row in table.rows[1:]:
        cells = _row_text(row.cells)
        if not any(cells):
            continue
        identifier = _cell(cells, idx_identifier)
        if not identifier:
            continue
        sn_raw = _cell(cells, idx_sn)
        sn_digits = re.sub(r'\D', '', sn_raw)
        sn = int(sn_digits) if sn_digits else None
        match_sector = sector_by_cell.get(identifier.lower())
        match_site = match_sector.site if match_sector else site_by_name.get(identifier.lower())

        # Site suggestion: an exact cell-name/site-name match wins
        # outright ('exact'); otherwise, fall back to the nearest real
        # Site by distance using whatever coordinates this row carries
        # ('nearest') -- 2026-09-15 follow-up, see _nearest_site's own
        # docstring. Either way this only ever SUGGESTS a value into the
        # review UI's site dropdown -- still fully overridable, and
        # confirm-import still requires a site to be chosen.
        suggested_site_id = match_site.id if match_site else None
        site_match_type = 'exact' if match_site else None
        site_match_distance_km = None
        if not match_site:
            lat, lng = _extract_coords(header, raw_header, cells)
            nearest_site, distance_km = _nearest_site(lat, lng)
            if nearest_site:
                suggested_site_id = nearest_site.id
                site_match_type = 'nearest'
                site_match_distance_km = distance_km

        # Description text excludes the S.N. column (2026-09-15
        # follow-up: "sn. is no need to fetch in description") -- it's
        # already carried on the row as its own `sn` field, so repeating
        # it as the first line of a free-text description an engineer
        # then has to read past was pure noise.
        description = '\n'.join(
            f'{h}: {v}' for i, (h, v) in enumerate(zip(raw_header, cells))
            if v.strip() and i != idx_sn
        )
        rows.append({
            'sn': sn,
            'identifier': identifier,
            'title': f'Vendor recommendation: {identifier}',
            'description': description,
            'matched_sector_id': match_sector.id if match_sector else None,
            'matched_site_id': suggested_site_id,
            'site_match_type': site_match_type,
            'site_match_distance_km': site_match_distance_km,
            'raw_row': dict(zip(raw_header, cells)),
        })
    return rows


_LOT_RE = re.compile(r'\bLOT[\s\-_]*0*(\d+)\b', re.IGNORECASE)
_NETWORK_RE = re.compile(r'\bNetwork[\s\-]*([IVXLCDM]+|\d+)\b', re.IGNORECASE)
_PHASE_RE = re.compile(r'\bPhase[\s\-]*([IVXLCDM]+|\d+)\b', re.IGNORECASE)


def _extract_report_metadata(document):
    """Best-effort Lot name / Network / Period-covered suggestion for
    the import form, scraped from the document's own title metadata and
    its first ~20 body paragraphs (2026-09-15 follow-up: "Lot name and
    period covered and Network like Network II, Phase I, Lot 6 can be
    auto retrieved by using uploaded report" -- confirmed via
    AskUserQuestion that this text lives on the title page / first
    heading, not a separate cover table or page header/footer). Always
    a SUGGESTION, exactly like every Site/Sector match elsewhere in this
    module -- the review UI keeps every one of these three fields
    editable regardless of what's found here, and an empty string here
    just means "nothing recognized, type it in as before"."""
    texts = []
    title = (document.core_properties.title or '').strip()
    if title:
        texts.append(title)
    subject = (document.core_properties.subject or '').strip()
    if subject:
        texts.append(subject)
    for para in document.paragraphs[:20]:
        text = (para.text or '').strip()
        if text:
            texts.append(text)
    blob = ' \n '.join(texts)

    lot_match = _LOT_RE.search(blob)
    network_match = _NETWORK_RE.search(blob)
    phase_match = _PHASE_RE.search(blob)

    return {
        'lot_name': f'LOT{lot_match.group(1)}' if lot_match else '',
        'network': f'Network {network_match.group(1)}' if network_match else '',
        'period_covered': f'Phase {phase_match.group(1)}' if phase_match else '',
    }


_REMARK_HEADING_RE = re.compile(
    r'\b(optimization\s+)?(remarks?|conclusions?|observations?|summary|comments?)\b\s*:?\s*$',
    re.IGNORECASE,
)


def _extract_narrative_notes(document, max_chars=2000):
    """Best-effort narrative-remarks suggestion for the report's `notes`
    field (2026-09-15 follow-up: "there are so many optimization
    remarks and recommendation in report. can we use those also?" --
    table-shaped remarks/recommendations are already captured by
    `_parse_recommendation_table` above; this instead walks the
    document's own PROSE paragraphs (python-docx's `document.paragraphs`
    never includes table cell text, so this can't double up with the
    table parser) looking for a heading-like line naming remarks/
    conclusions/observations, then collects whatever immediately
    follows it until the next heading. Heuristic and best-effort like
    every other suggestion in this module -- always reviewable/editable
    in the form before confirm-import, never trusted blind."""
    collected = []
    capturing = False
    for para in document.paragraphs:
        text = (para.text or '').strip()
        style_name = (para.style.name if para.style else '') or ''
        is_heading_style = style_name.lower().startswith('heading') or style_name.lower() == 'title'

        if _REMARK_HEADING_RE.search(text) and (is_heading_style or len(text) < 60):
            capturing = True
            continue

        if capturing:
            if not text:
                continue
            if is_heading_style:
                capturing = False
                continue
            collected.append(text)

        if sum(len(t) for t in collected) >= max_chars:
            break

    return '\n'.join(collected).strip()[:max_chars]


def _save_compressed(uploaded_file):
    """Streams `uploaded_file` (an UploadedFile -- may be a real on-disk
    TemporaryUploadedFile for anything over
    settings.FILE_UPLOAD_MAX_MEMORY_SIZE, so a 528MB source doc is never
    fully read into RAM at once) through gzip into a NEW temp file on
    disk, then wraps that for Django's FieldFile.save() to stream from
    in turn. 2026-09-15 follow-up: "allow system to save report (with
    size compressed) also with attachment if needed in future for full
    access" -- used by RfOptimizationReportViewSet.attachments below.
    Returns (django.core.files.base.File, compressed_size_bytes); the
    caller is responsible for closing it once FieldFile.save() is done
    reading from it."""
    tmp = tempfile.NamedTemporaryFile(suffix='.gz')
    with gzip.GzipFile(fileobj=tmp, mode='wb') as gz:
        for chunk in uploaded_file.chunks():
            gz.write(chunk)
    tmp.flush()
    size = tmp.tell()
    tmp.seek(0)
    return File(tmp), size


class RfReportParsePreviewView(APIView):
    """`POST /api/v2/rf-reports/parse-preview/` -- accepts one uploaded
    vendor .docx (multipart, field name `file`) and returns every
    antenna change-log row and recommendation row this module's header
    matching found, each with a best-effort Site/Sector match
    suggestion, plus a best-effort `suggested_metadata`/`suggested_notes`
    and a `tables_unmatched` list of any table that looked
    recommendation-ish but wasn't classified with full confidence (see
    `_looks_recommendation_ish`'s docstring). Nothing is saved here --
    see this module's own docstring for the full parse-preview -> review
    -> confirm-import flow.

    Admin/superadmin only (same tier as every other write-adjacent
    action on this feature) -- this reads the entire uploaded document
    into memory to run python-docx over it, which is not something to
    expose to every authenticated role.
    """
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        f = request.FILES.get('file')
        if not f:
            return Response({'file': ['A .docx file is required.']}, status=400)
        try:
            document = Document(f)
        except Exception as exc:
            return Response(
                {'file': [f'Could not read this file as a Word document ({exc}).']}, status=400,
            )

        sector_by_cell = {
            s.cell_name.strip().lower(): s
            for s in Sector.objects.select_related('site').exclude(cell_name='')
        }
        site_by_name = {s.name.strip().lower(): s for s in Site.objects.exclude(name='')}

        antenna_changes = []
        recommendations = []
        tables_matched = 0
        tables_unmatched = []
        for table in document.tables:
            if not table.rows:
                continue
            header = _table_header(table)
            if _is_antenna_change_table(header):
                antenna_changes.extend(_parse_antenna_change_table(table, sector_by_cell))
                tables_matched += 1
            elif _is_recommendation_table(header):
                recommendations.extend(_parse_recommendation_table(table, sector_by_cell, site_by_name))
                tables_matched += 1
            elif _looks_recommendation_ish(header):
                raw_header = _row_text(table.rows[0].cells)
                idx_identifier = _find_col(header, 'cell name', 'existing cell', 'site name', 'cell id')
                parsed = False
                if idx_identifier is not None:
                    new_rows = _parse_recommendation_table(table, sector_by_cell, site_by_name)
                    if new_rows:
                        recommendations.extend(new_rows)
                        tables_matched += 1
                        parsed = True
                tables_unmatched.append({
                    'header': raw_header,
                    'row_count': max(len(table.rows) - 1, 0),
                    'parsed': parsed,
                })

        return Response({
            'antenna_changes': antenna_changes,
            'recommendations': recommendations,
            'tables_scanned': len(document.tables),
            'tables_matched': tables_matched,
            'tables_unmatched': tables_unmatched,
            'suggested_metadata': _extract_report_metadata(document),
            'suggested_notes': _extract_narrative_notes(document),
        })


class RfOptimizationReportViewSet(viewsets.ModelViewSet):
    """`/api/v2/rf-reports/` -- list/retrieve/create/delete for imported
    vendor RNO reports. `create` is really "confirm the reviewed
    parse-preview result" -- see RfOptimizationReportSerializer's
    docstring for the nested antenna_changes/recommendations write shape
    and why recommendations become ordinary Issue rows rather than a
    second nested table on this model.

    Read (list/retrieve): admin/superadmin only, unlike the read-open
    Issue tracker -- an imported report can carry uploaded vendor
    documents and MOM attachments that aren't meant for every viewer
    role to browse. Write: admin/superadmin only, same tier as every
    other write surface here.
    """
    queryset = RfOptimizationReport.objects.all().prefetch_related('antenna_changes', 'attachments')
    serializer_class = RfOptimizationReportSerializer
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def perform_create(self, serializer):
        user = self.request.user
        serializer.save(imported_by=user if user and user.is_authenticated else None)

    @action(detail=True, methods=['get', 'post'], url_path='attachments')
    def attachments(self, request, pk=None):
        """`GET` lists this report's attachments (source doc, MOM,
        anything else). `POST` uploads one or more files (multipart,
        field name `files`, optional `category` = source|mom|other --
        see RfReportAttachment.CATEGORY_CHOICES). Same shape as
        DriveTestSessionViewSet.attachments in drive_test.py, except
        every file is now gzip-compressed before being written to
        storage (2026-09-15 follow-up -- see `_save_compressed`'s own
        docstring and RfReportAttachment.is_compressed's comment in
        models.py); download (and transparent decompression) is via
        RfReportAttachmentDetailView, a flat URL registered in urls.py.
        """
        report = self.get_object()
        if request.method == 'GET':
            qs = report.attachments.all()
            return Response(RfReportAttachmentSerializer(qs, many=True, context={'request': request}).data)

        files = request.FILES.getlist('files') or request.FILES.getlist('file')
        if not files:
            return Response({'files': ['At least one file is required (field name "files").']}, status=400)
        category = request.data.get('category') or RfReportAttachment.CATEGORY_OTHER
        if category not in dict(RfReportAttachment.CATEGORY_CHOICES):
            category = RfReportAttachment.CATEGORY_OTHER

        created = []
        for f in files:
            compressed_file, compressed_size = _save_compressed(f)
            try:
                attachment = RfReportAttachment(
                    report=report, original_filename=f.name, size_bytes=compressed_size,
                    category=category, uploaded_by=request.user, is_compressed=True,
                )
                attachment.file.save(f'{f.name}.gz', compressed_file, save=False)
                attachment.save()
            finally:
                compressed_file.close()
            created.append(attachment)
        return Response(
            RfReportAttachmentSerializer(created, many=True, context={'request': request}).data,
            status=201,
        )


class RfReportAttachmentDetailView(APIView):
    """`GET /api/v2/rf-reports/<report_id>/attachments/<attachment_id>/download/`
    -- streams one attachment's ORIGINAL bytes back to the browser,
    transparently gunzip-decompressing when `is_compressed` (every
    upload since 2026-09-15, see RfReportAttachment.is_compressed's own
    comment in models.py -- older rows made before that default to
    False and are served as-is). Flat URL rather than a second nested
    `@action` on the viewset, same reasoning as
    DriveTestSessionAttachmentDetailView in drive_test.py -- registered
    directly in urls.py alongside this viewset's router registration.

    Admin/superadmin only, same tier as every other action on this
    feature.
    """
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, report_id, attachment_id):
        try:
            attachment = RfReportAttachment.objects.get(pk=attachment_id, report_id=report_id)
        except RfReportAttachment.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=404)

        try:
            file_obj = attachment.file.open('rb')
        except (FileNotFoundError, ValueError):
            return Response({'detail': 'The stored file is missing.'}, status=404)

        content_type, _ = mimetypes.guess_type(attachment.original_filename)
        if attachment.is_compressed:
            file_obj = gzip.GzipFile(fileobj=file_obj, mode='rb')
        response = FileResponse(file_obj, content_type=content_type or 'application/octet-stream')
        if attachment.is_compressed and response.has_header('Content-Length'):
            # FileResponse auto-sets Content-Length from the wrapped
            # file's fileno() -- gzip.GzipFile delegates fileno() to the
            # underlying (still-compressed) file, so that length is the
            # COMPRESSED size on disk, not what .read() actually yields
            # once GzipFile decompresses it. Left in place, the browser
            # would cut the download off after that many decompressed
            # bytes. Drop it and let the server stream without a fixed
            # length instead -- correct either way, just not
            # pre-computable without decompressing the whole file first.
            del response['Content-Length']
        filename = attachment.original_filename or attachment.file.name
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response
