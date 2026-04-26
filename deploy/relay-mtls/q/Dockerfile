FROM alpine:3
# openssl is for the docker-compose healthcheck's cert-expiry probe (see
# q/docker-compose.yml). stunnel itself links against libcrypto/libssl but
# the openssl CLI binary is a separate package — without it `openssl x509
# -checkend …` exits 127 and the healthcheck flips (unhealthy) for the
# wrong reason.
RUN apk add --no-cache stunnel openssl
COPY stunnel.conf /etc/stunnel/stunnel.conf
# stunnel runs as root inside the container — simpler read access to the
# bind-mounted /host/var/run/arduino-router.sock and to /etc/stunnel/certs.
# The threat model assumes the container is isolated; a compromise of stunnel
# inside it gets you what the container already has by design. See
# CONTEXT.md §12.5.5 for the full security model.
ENTRYPOINT ["stunnel", "/etc/stunnel/stunnel.conf"]
