# Phone side public, DT-WATCH private: plan for the network team

**For:** NTC network and security teams
**Date:** 29 October 2026

Phones on mobile data cannot reach DT-WATCH today, so their readings, speed
tests and problem reports wait on the phone or are lost. This plan opens only
the paths the mobile app uses, through a front door in the DMZ, and keeps the
rest of DT-WATCH private.

## What is public and what stays private

| Path | Used by | Exposure |
|---|---|---|
| `/api/telemetry/v1/` | The app: readings, speed results, problem reports, registration, accepted requests, time-of-day readings, site photos | **Public**, through the front door |
| `/speedtest/` | The app's speed test | **Public** (better on its own machine, see `docs/speedtest-server/`) |
| `/`, `/api/v2/` | Staff web application and its API | Private (NTC network, VPN) |
| `/api/external/v1/` | NTC systems such as ticketing | Private |
| `/media/`, `/maps/` | Web application | Private |
| Database, Redis, background jobs | Server only | Private |

```
 Phone (mobile data / internet)
        |
        v  HTTPS, telemetry.ntc.net.np
 Front door (DMZ)  -- passes /api/telemetry/v1/ and /speedtest/ only, 404 for the rest
        |
        v  private network
 DT-WATCH (dtwatch.ntc.net.np, private)  -- staff reach it on the NTC network as today
```

The public paths only receive data from phones. A phone gets back only its
own answers (its registration, its own requests, the site of its own cell),
never another person's data.

## Steps

1. **Front door.** Install `front-door.nginx.conf` (this folder) on a DMZ host
   with nginx. Set the public name, the certificate and the private address
   of DT-WATCH (its frontend port, 5180 by default).
2. **Firewall.** Internet to the front door: 443 (and 80 for the redirect).
   Front door to DT-WATCH: its frontend port only. Nothing from the internet
   to DT-WATCH directly.
3. **DT-WATCH settings** (`.env` on the DT-WATCH server):
   - `ALLOWED_HOSTS` includes `telemetry.ntc.net.np`.
   - `DEBUG` is `0`; `SECRET_KEY` is long and random (the server refuses to
     start otherwise).
   - DT-WATCH's own nginx takes the client address from `X-Forwarded-For`
     when the request comes from a private address, so the front door must
     sit on a private address as seen from DT-WATCH.
4. **Speed test server.** On the Security page, set the speed test server to
   the public test machine (or `https://telemetry.ntc.net.np`).
5. **The app.** Point the app's server addresses at
   `https://telemetry.ntc.net.np/api/telemetry/v1/` (one configuration file in
   the app) and release a new build.
6. **Mobile data routing.** Make sure the APN (`ntnet`) can reach the front
   door's public address.

## Checks after go-live

From outside NTC's network:

| Request | Expected |
|---|---|
| `GET https://telemetry.ntc.net.np/api/telemetry/v1/health/` | 200 |
| `GET https://telemetry.ntc.net.np/` | 404 |
| `GET https://telemetry.ntc.net.np/api/v2/sites/` | 404 |
| `GET https://telemetry.ntc.net.np/api/external/v1/problem-reports/` | 404 |
| 200 quick requests to `/api/telemetry/v1/health/` from one address | Some answer 429 |

From a phone on mobile data: run a speed test and send a problem report; both
should appear in DT-WATCH within a minute.

## Protections already in DT-WATCH

- Signed uploads from registered phones (a key kept in the phone's secure
  storage); uploads with the app's shared key can be switched off later
  (`TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL`) once `manage.py shared_key_usage`
  shows few phones still use it.
- Screening on arrival (29 October 2026): at most 20,000 readings a day per
  phone (`TELEMETRY_DEVICE_DAILY_CAP`); readings that jump impossibly far or
  arrive too often are flagged and left out of coverage maps and complaint
  checks; each reading records whether it was signed.
- Rate limits per key and per phone, upload size limits, a duplicate-batch
  check, attack alerts and automatic blocking on the login side, security
  headers, the Django admin closed.

## Still open

- Play Integrity (Google confirms the app is the real one) needs the app on
  Google Play.
- Server sizing once real phone numbers are known: a load test on the test
  copy first.
- A web firewall or DDoS protection in front of the door, if NTC has one.
