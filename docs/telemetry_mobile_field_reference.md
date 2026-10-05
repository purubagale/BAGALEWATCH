# Telemetry Field Reference — for the Mobile (Android SDK) Team

Written for: Android SDK developers implementing uploads to DT-WATCH. This is the
exact set of fields the backend accepts today. Anything not listed is silently
ignored by the server.

Base URLs (see `telemetry_pipeline_mobile_handoff.md` for keys and hosts):

- RF samples: `POST /api/telemetry/v1/samples/` — JSON **array** of objects
- VoLTE call quality: `POST /api/telemetry/v1/volte-samples/` — JSON **array** of objects
- Auth: `Authorization: Bearer tel_<key>` (or `X-API-Key: tel_<key>`)

---

## 1. RF samples (`/samples/`) — periodic and handover readings

| JSON key | Type | Required | Unit / allowed values | Source on device | Notes |
|---|---|---|---|---|---|
| `device_id` | string | **yes** | any non-empty pseudonymous ID (UUID) | SDK-generated, stored per install | Never IMEI, Android ID, or MSISDN. Server hashes it before storage. |
| `ts` | integer | **yes** | epoch **milliseconds** | device clock at measurement | Sample time, not upload time. |
| `lat` | float | no | degrees, WGS84 | `FusedLocationProvider` fix | Omit if no fix. |
| `lon` | float | no | degrees, WGS84 | same as `lat` | Wire name is `lon`; stored internally as `lng`. |
| `gps_accuracy_m` | float | no | meters | location fix accuracy | |
| `cell_id` | integer | no | serving cell ID; use 64-bit-safe type | `CellIdentity*.getCi()` / `getNci()` | 5G NCI is 36-bit. |
| `pci` | integer | no | Physical Cell ID, **LTE/NR only** | `CellIdentityLte.getPci()` / `CellIdentityNr.getPci()` | Null on 2G/3G. Before 2026-10-04 builds sent the UMTS scrambling code here too; the server still reads that legacy value for 3G matching, but new builds send it as `scrambling_code`. |
| `scrambling_code` | integer | no | UMTS primary scrambling code, 0–511 | `CellIdentityWcdma.getPsc()` | Added 2026-10-04. Null on other RATs. |
| `bcch` | integer | no | GSM BCCH ARFCN, 0–1023 | `CellIdentityGsm.getArfcn()` | Added 2026-10-04. Null on other RATs. Works from API 24. |
| `bsic` | integer | no | GSM BSIC, 0–63 | `CellIdentityGsm.getBsic()` | Added 2026-10-04. Null on other RATs. Works from API 24. |
| `tac` | integer | no | Tracking Area Code (LTE/NR) or Location Area Code (2G/3G) | `CellIdentity*.getTac()` / `getLac()` | |
| `mcc` | string | no | e.g. `"429"` | `CellIdentity*.getMccString()` | |
| `mnc` | string | no | e.g. `"01"` | `CellIdentity*.getMncString()` | |
| `network_type` | string | no | `LTE`, `NR`, `UMTS`, `GSM`, `UNKNOWN` | serving-cell technology | Any other value becomes `UNKNOWN`. |
| `rsrp_dbm` | integer | no | dBm, LTE/NR | `CellSignalStrengthLte.getRsrp()` / `CellSignalStrengthNr` | Leave null on 2G/3G. |
| `rsrq_db` | integer | no | dB, LTE/NR | `CellSignalStrengthLte.getRsrq()` | Leave null on 2G/3G. |
| `sinr_db` | integer | no | dB, LTE/NR | `CellSignalStrengthLte.getRssnr()` | Leave null on 2G/3G. |
| `cqi` | — | — | **Not sent.** Removed from the mobile contract 2026-10-04: the SDK doesn't read CQI from the modem. | — | The server derives LTE CQI from SINR instead (`cqi_derived`, §3). |
| `rssi_dbm` | integer | no | dBm; on GSM this is the RxLevel | `CellSignalStrengthGsm`/`Umts` `getRssi()`/`getDbm()` | Used as signal fallback on 2G/3G. |
| `rx_qual` | integer | no | GSM RxQual class, 0–7 (TS 45.008 §8.5) | `CellSignalStrengthGsm.getBitErrorRate()` | 99 (unknown) must be sent as null. GSM only. |
| `rscp_dbm` | integer | no | dBm, WCDMA | `CellSignalStrengthWcdma.getRscp()` | Android 10+ (API 29+) only; null otherwise. |
| `ecio_db` | integer | no | dB, WCDMA | `CellSignalStrengthWcdma.getEcNo()` | Android 10+ only; null otherwise. |
| `battery_pct` | integer | no | 0–100 | `BatteryManager` | |
| `trigger_reason` | string | no | `periodic`, `handover`, `manual` | sampler that produced the reading | Any other value becomes `periodic`. |

Example:

```json
[
  {
    "device_id": "3f9a1c2e-7b1d-4e8a-9c2f-5a6b7c8d9e0f",
    "ts": 1758444000000,
    "lat": 27.7172,
    "lon": 85.3240,
    "gps_accuracy_m": 12.5,
    "cell_id": 123456,
    "pci": 301,
    "tac": 4501,
    "mcc": "429",
    "mnc": "01",
    "network_type": "LTE",
    "rsrp_dbm": -95,
    "rsrq_db": -10,
    "sinr_db": 12,
    "battery_pct": 76,
    "trigger_reason": "periodic"
  }
]
```

Limits: max 2000 samples per request. Idempotency: an identical batch is
acknowledged as `duplicate` (see handoff §6).

### 1a. Fields the mobile SDK does NOT send yet

Per `telemetry_pipeline_mobile_handoff.md` §9.4, these are accepted by the
backend but not yet collected by the current SDK: `rx_qual`, `rscp_dbm`,
`ecio_db`. CQI is no longer part of the mobile contract: the server derives it from SINR (§3).

---

## 2. VoLTE / VoNR call quality (`/volte-samples/`)

Sent **once per completed call**, not periodically. Requires carrier-privileged
app status (`READ_PRECISE_PHONE_STATE`). Until then the endpoint receives nothing.

| JSON key | Type | Required | Unit / allowed values | Source on device | Notes |
|---|---|---|---|---|---|
| `device_id` | string | **yes** | same as §1 | same as §1 | |
| `ts` | integer | **yes** | epoch milliseconds | call end time | |
| `call_duration_s` | integer | no | seconds | call duration | |
| `codec` | string | no | e.g. `AMR-WB`, `AMR-NB`, `EVS`, `G.711`, `G.729` | `CallQuality` codec type | Only AMR-WB/G.711/G.729 get a verified estimate; AMR-NB and EVS get a provisional one. See §2a. |
| `packet_loss_pct` | float | no | 0–100 | `CallQuality` downlink/uplink packet loss | |
| `jitter_ms` | float | no | milliseconds | `CallQuality` jitter | |
| `rtt_ms` | float | no | milliseconds | `CallQuality` round-trip time | |
| `quality_level` | string | no | `EXCELLENT`, `GOOD`, `FAIR`, `POOR`, `BAD`, `NOT_AVAILABLE` | `CallQuality` level enum | Send verbatim. |
| `network_type` | string | no | `LTE`, `NR`, `UNKNOWN` | serving-cell technology | VoLTE vs VoNR. |
| `cell_id`, `pci`, `tac`, `mcc`, `mnc` | as §1 | no | as §1 | as §1 | |
| `lat`, `lon` | float | no | as §1 | as §1 | |

Do **not** send a MOS value. The server computes `r_factor`, `mos_estimate`,
and `mos_is_provisional` itself.

Example:

```json
[
  {
    "device_id": "3f9a1c2e-7b1d-4e8a-9c2f-5a6b7c8d9e0f",
    "ts": 1758444000000,
    "call_duration_s": 42,
    "codec": "AMR-WB",
    "packet_loss_pct": 0.5,
    "jitter_ms": 8,
    "rtt_ms": 60,
    "quality_level": "GOOD",
    "network_type": "LTE",
    "lat": 27.7172,
    "lon": 85.3240,
    "cell_id": 123456,
    "pci": 301,
    "mcc": "429",
    "mnc": "01"
  }
]
```

### 2a. Codec coverage for the server-side estimate

| Codec string | Estimate tier | Notes |
|---|---|---|
| `AMR-WB` | verified | Assumes the 12.65 kbit/s mode. |
| `G.711`, `G.729` | verified | Mainly for pipeline testing. Estimate only when packet loss is 0. |
| `EVS` | provisional | Estimate is approximate; flagged in the UI. |
| `AMR-NB` | provisional | Proxied from GSM-EFR. Estimate only when packet loss is 0. |
| anything else | none | Raw metrics are stored; no estimate. |

---

## 3. Fields DT-WATCH derives on the server (do not send)

| Field | Derived from | Where |
|---|---|---|
| `received_at` | server receipt time | all sample tables |
| `location` | `lat`/`lon` converted to a PostGIS point | all sample tables |
| `region` | matched site's province | RF samples |
| `serving_site_id`, `serving_sector`, `serving_cell_name`, `serving_dist_km` | the site/sector whose same-id cell (PCI for LTE, scrambling code for 3G, BCCH+BSIC for 2G) lies nearest the sample, within 5 km | RF samples, added 2026-10-04 |
| `r_factor`, `mos_estimate`, `mos_is_provisional` | E-model on the VoLTE raw metrics | VoLTE samples |
| `cqi_mean` and other per-bin averages | aggregation of `cqi` and other RF fields | coverage bins (aggregated, not per device) |

**CQI in particular (2026-10-04):** the SDK no longer sends CQI. The server
derives `cqi_derived` for LTE samples from the sample's own `sinr_db`, using the
threshold table in `core/telemetry.py` (`cqi_from_sinr`). It's the same table
the drive-test path uses, so the two stay comparable. It's an estimate of what
a UE would report, not a measured value, and it's null for non-LTE samples and
where SINR is unknown. The stored `cqi` column stays empty for new uploads.

---

## 4. Not part of the mobile telemetry contract

These appear in DT-WATCH's data model but do **not** come from the mobile SDK:

- `dl` / `ul` throughput, `bcch`, `bsic`, `scrambling_code`, `serving_local_cell_id`:
  come from drive-test (TRP) file uploads, not from `/samples/`.
- Operator per-cell KPIs (RRC success, HOSR, VoLTE KPIs, and similar): come from
  vendor OSS/RNO reports, not from devices.
