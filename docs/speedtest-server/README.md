# DT-WATCH speed-test server

A small public machine that answers the DT-WATCH app's speed test, so phones
on mobile data can test against a server inside NTC's network, the way Ookla's
"Nepal Telecom" server works. It holds no DT-WATCH code, data or keys.

## What NTC's team provides

1. A machine or VM with a public address in NTC's network (DMZ), Docker
   installed, and a link of at least 1 Gbit/s. Not the `ntc.net.np` website
   server: a full test moves 50 to 90 MB and would compete with the site.
2. A DNS name for it, for example `speedtest.ntc.net.np`.
3. A certificate for that name from a public certificate authority. The
   app's release builds use HTTPS only.

## Install

```sh
docker build -t dtwatch-speedtest .
docker run -d --name dtwatch-speedtest --restart unless-stopped \
  -p 80:80 -p 443:443 -v /path/to/certs:/etc/nginx/certs:ro dtwatch-speedtest
```

Enable the three `ssl` lines in `nginx.conf` before building when the
certificate is ready. Optionally fill in NTC's subscriber address ranges in
the `allow` lines so only NTC users can run tests.

## Check it

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://speedtest.ntc.net.np/speedtest/empty      # 204
curl -s -o /dev/null -w "%{size_download}\n" https://speedtest.ntc.net.np/speedtest/garbage # 33554432
```

## Switch the phones to it

In DT-WATCH, open **Security** (superadmin), card **Speed test server**, and
enter `https://speedtest.ntc.net.np/speedtest/`. Phones ask DT-WATCH where to
test before each run and remember the answer, so they move over at their next
test. No new app is needed. Leave the field empty to go back to the DT-WATCH
server.

Limits built in: at most 16 open connections per address; uploads up to
64 MB per request; nothing is logged or stored.
