"""
Vendor Radio Network Optimization (RNO) report importer (2026-09-15
request: "How can we utilize this report or data of this report in our
application for network optimization and repository").

Two real vendor reports were used to design this (LOT2 at 218MB, LOT6 at
528MB) -- each a Word document containing an antenna azimuth/tilt CHANGE
LOG table, one or more Lot-wise OSS KPI summary tables, and ~30 per-cell
"worst cell" KPI pre/post tables (one per metric -- RRC/E-RAB/CSFB/HOSR/
throughput/VoLTE/etc).

**Recommendation tables (new site/band additions) were parsed here from
2026-09-15 through 2026-09-26, then removed** (2026-09-26 request: "now
it is not needed"). Issue rows created by that importer while it existed
are untouched -- `Issue.source_report` stays a valid field for that
historical data (`related_name='recommendation_issues'`, models.py) --
only the .docx table parser that CREATED new ones is gone. If a future
request revives this, `git log` on this file has the original
`_is_recommendation_table`/`_looks_recommendation_ish`/
`_parse_recommendation_table`/`_extract_coords`/`_nearest_site`
implementation to restore rather than reinventing the nearest-site
distance-suggestion logic from scratch.

**Lot-wise OSS KPI / worst-cell KPI tables (2026-09-26)** -- the "~30
per-cell KPI pre/post tables" the original 2026-09-15 scope explicitly
deferred ("a separate, larger follow-up if ever needed"). Two distinct
shapes, confirmed against a real LOT2 upload's 123 tables:
  - Lot-wise OSS KPI: aggregate, no per-cell identity -- `[KPI Parameter/
    VoLTE KPI/ViLTE KPI Parameter/KPI, (Target,) Pre, Post, (Remark)]`.
    See `_is_lot_kpi_table`.
  - Worst-cell KPI: one table PER METRIC, always 6 columns -- `[eNBID,
    eNodeB Name, Cell Name, Cell ID, <Metric>(-Pre), <Metric>-Post]`, Pre
    always column 5 and Post always column 6 BY POSITION (a real table
    was seen where column 5's header omits any "-Pre" suffix at all).
    See `_is_cell_kpi_table`.
  Both are deliberately excluded from matching the same headerless
  chart-support tables real reports are full of (`['Pre','Pre','Pre',
  'Color','Post','Post','Post']`, `['Counter','Pre','Post']` -- these
  back embedded charts and have no real per-row identifier, just a
  numeric bucket index or the literal word "Counter").

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
place their change-log tables at the same table index. Every function
below identifies a table by what its header ROW says, normalized
(lowercased, whitespace collapsed), never by position in the document,
so the next lot's report having a different table count ahead of the one
this cares about doesn't silently break the import.

**2026-09-15 follow-up round, after the first real live test** (see
each helper's own docstring for detail):
  - `_extract_report_metadata` / `_extract_narrative_notes` -- Lot name,
    Network, Period-covered and a notes suggestion are scraped
    best-effort from the document's own title/first-heading text and
    narrative paragraphs, instead of always requiring manual entry.
    Confirmed via AskUserQuestion that this metadata lives on the title
    page, not a cover table or page header/footer.
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
uploaded .docx and returns candidate rows with best-effort Sector match
suggestions -- nothing is saved. The frontend review UI lets an
engineer correct/drop rows before submitting. `RfOptimizationReportViewSet.create`
(via `RfOptimizationReportSerializer`) then persists the reviewed rows as
one RfOptimizationReport + its SectorConfigChange/RfKpiSummary/RfCellKpi
rows -- see that serializer's docstring in serializers.py.
"""
import gzip
import mimetypes
import re
import tempfile

from django.core.files.base import File
from django.http import FileResponse
from docx import Document
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import RfOptimizationReport, RfReportAttachment, Sector
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


# Known identifier-column names for a Lot-wise OSS KPI summary table
# (2026-09-26) -- deliberately a short, extend-as-verified list (same
# "header-matching over table position, extended only from real evidence"
# convention as every other detector in this module), not a broad
# heuristic. A broad "any table with Pre+Post columns" match would
# misclassify the headerless chart-support tables real reports are full
# of (`['Pre','Pre','Pre','Color','Post','Post','Post']`,
# `['Counter','Pre','Post']`) -- those back embedded charts and their only
# non-Pre/Post column is a numeric bucket index or the literal word
# "Counter", never a real KPI name.
_LOT_KPI_IDENTIFIER_COLUMNS = ('kpi parameter', 'volte kpi', 'vilte kpi parameter', 'kpi', 'issue', 'problem type')


def _is_lot_kpi_table(header):
    has_identifier = any(any(name in h for name in _LOT_KPI_IDENTIFIER_COLUMNS) for h in header)
    has_pre = any(h == 'pre' or h.startswith('pre') for h in header)
    has_post = any(h == 'post' or h.startswith('post') for h in header)
    return has_identifier and has_pre and has_post


def _parse_lot_kpi_table(table):
    """One row per Lot-wise OSS KPI table row (2026-09-26) -- real shapes
    confirmed against a LOT2 upload: `[S.N., KPI Parameter, Target "X",
    Pre, Post]`, `[S.N., VoLTE KPI, Pre, Post, Remarks]`, `[S.No, ViLTE
    KPI Parameter, Pre, Post]`, `[KPI, Target, Pre, Post, Remark]`. Values
    are the vendor's own text, never force-parsed into a number
    ("66.19%(105884)", "Monitor only (>=-85dbm)") -- same rule
    SectorConfigChange.before_change/after_change already uses."""
    header = _table_header(table)
    idx_name = next(
        (i for i, h in enumerate(header) if any(n in h for n in _LOT_KPI_IDENTIFIER_COLUMNS)), None
    )
    idx_target = _find_col(header, 'target')
    idx_pre = _find_col(header, 'pre')
    idx_post = _find_col(header, 'post')
    idx_remark = _find_col(header, 'remark')

    rows = []
    for row in table.rows[1:]:
        cells = _row_text(row.cells)
        if not any(cells):
            continue
        kpi_name = _cell(cells, idx_name)
        if not kpi_name:
            continue
        rows.append({
            'kpi_name': kpi_name,
            'target': _cell(cells, idx_target),
            'pre_value': _cell(cells, idx_pre),
            'post_value': _cell(cells, idx_post),
            'remark': _cell(cells, idx_remark),
        })
    return rows


def _is_cell_kpi_table(header):
    joined = ' '.join(header)
    has_enb = 'enbid' in joined
    has_enodeb = 'enodeb name' in joined or 'enodebname' in joined
    has_cell_name = 'cell name' in joined
    has_cell_id = 'cell id' in joined
    return has_enb and has_enodeb and has_cell_name and has_cell_id and len(header) == 6


# Strips a trailing "Pre"/"Post" token (with or without a leading hyphen/
# space) off a worst-cell KPI table's column-5/6 header text, to recover
# the bare metric name -- e.g. "RRC Setup Success Rate (%) Post" ->
# "RRC Setup Success Rate (%)". A real LOT2 table has column 5's header
# with NO suffix at all (implicitly "Pre") while column 6 says "... Post"
# -- position (column 5 is always pre, column 6 always post), not label
# text, is what decides which value is which; this only cleans up the
# display name.
_TRAILING_PRE_POST_RE = re.compile(r'[\s\-]*\b(pre|post)\b\s*$', re.IGNORECASE)


def _cell_kpi_metric_name(pre_header, post_header):
    stripped = _TRAILING_PRE_POST_RE.sub('', post_header).strip()
    return stripped or _TRAILING_PRE_POST_RE.sub('', pre_header).strip() or post_header


def _parse_cell_kpi_table(table, sector_by_cell):
    """One row per worst-cell KPI table row (2026-09-26) -- real shape
    confirmed against a LOT2 upload, always 6 columns: `[eNBID, eNodeB
    Name, Cell Name, Cell ID, <Metric>(-Pre), <Metric>-Post]`, repeated
    once per metric (~30 such tables in a real report -- RRC/E-RAB/CSFB/
    HOSR/throughput/VoLTE/QCI1/etc). `sector_by_cell` is the same lookup
    `_parse_antenna_change_table` already builds/uses."""
    header = _table_header(table)
    raw_header = _row_text(table.rows[0].cells)
    metric_name = _cell_kpi_metric_name(raw_header[4], raw_header[5])

    rows = []
    for row in table.rows[1:]:
        cells = _row_text(row.cells)
        if not any(cells):
            continue
        cell_name = _cell(cells, 2)
        if not cell_name:
            continue
        match = sector_by_cell.get(cell_name.lower())
        rows.append({
            'enb_id': _cell(cells, 0),
            'enodeb_name': _cell(cells, 1),
            'cell_name': cell_name,
            'metric_name': metric_name,
            'pre_value': _cell(cells, 4),
            'post_value': _cell(cells, 5),
            'matched_sector_id': match.id if match else None,
            # 2026-09-29 addition ("with what value it is matched?") -- same
            # field _parse_antenna_change_table already returns, so the
            # review table can show WHICH site a "Matched" row resolved to,
            # not just that a match exists.
            'matched_site_id': match.site_id if match else None,
        })
    return rows


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
    a SUGGESTION, exactly like every Sector match elsewhere in this
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


def _extract_narrative_notes(document, max_chars=20000):
    """Best-effort narrative-remarks suggestion for the report's `notes`
    field (2026-09-15 follow-up: "there are so many optimization
    remarks and recommendation in report. can we use those also?") --
    walks the document's own PROSE paragraphs (python-docx's `document.paragraphs`
    never includes table cell text, so this can't double up with the
    table parser) looking for a heading-like line naming remarks/
    conclusions/observations, then collects whatever immediately
    follows it until the next heading. Heuristic and best-effort like
    every other suggestion in this module -- always reviewable/editable
    in the form before confirm-import, never trusted blind.

    `max_chars` is a soft target checked only AFTER a whole paragraph is
    appended, never a hard slice -- a real report's remarks section can
    run through several "Case N:" narratives spanning many paragraphs,
    and a mid-string cut (`text[:max_chars]`, the original 2026-09-15
    version) chopped it off mid-sentence (found 2026-09-29, "i think
    sentence is not terminated. so complete data is not displayed").
    `Site.notes`/`RfOptimizationReport.notes` are both plain unbounded
    TextFields, so there's no real reason to cap this tightly at all --
    20000 is generous headroom over any real report seen so far, not a
    hard ceiling this is expected to hit."""
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

    return '\n'.join(collected).strip()


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
    vendor .docx (multipart, field name `file`) and returns every antenna
    change-log row (with a best-effort Sector match), Lot-wise OSS KPI
    row, and worst-cell KPI row this module's header matching found, plus
    a best-effort `suggested_metadata`/`suggested_notes`. `tables_unmatched`
    is currently always empty (2026-09-26 -- the recommendation-table
    importer that used to populate it, for tables that looked
    recommendation-ish but weren't classified with full confidence, was
    removed; kept in the response shape rather than dropped in case a
    future table type wants the same "visible even when not fully
    classified" reporting this list originally provided). Nothing is
    saved here -- see this module's own docstring for the full
    parse-preview -> review -> confirm-import flow.

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

        antenna_changes = []
        lot_kpis = []
        cell_kpis = []
        tables_matched = 0
        tables_unmatched = []
        for table in document.tables:
            if not table.rows:
                continue
            header = _table_header(table)
            if _is_antenna_change_table(header):
                antenna_changes.extend(_parse_antenna_change_table(table, sector_by_cell))
                tables_matched += 1
            elif _is_lot_kpi_table(header):
                lot_kpis.extend(_parse_lot_kpi_table(table))
                tables_matched += 1
            elif _is_cell_kpi_table(header):
                cell_kpis.extend(_parse_cell_kpi_table(table, sector_by_cell))
                tables_matched += 1

        return Response({
            'antenna_changes': antenna_changes,
            'lot_kpis': lot_kpis,
            'cell_kpis': cell_kpis,
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
    docstring for the nested antenna_changes/lot_kpis/cell_kpis write
    shape.

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
