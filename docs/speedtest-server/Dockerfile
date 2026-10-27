# DT-WATCH speed-test server (2026-10-26). Build and run from this folder:
#   docker build -t dtwatch-speedtest .
#   docker run -d --name dtwatch-speedtest --restart unless-stopped -p 80:80 dtwatch-speedtest
# For HTTPS, mount the certificate and enable the 443 lines in nginx.conf:
#   -p 443:443 -v /path/to/certs:/etc/nginx/certs:ro
FROM nginx:1.27-alpine
RUN mkdir -p /usr/share/nginx/speedtest && head -c 33554432 /dev/urandom > /usr/share/nginx/speedtest/garbage.bin
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80 443
