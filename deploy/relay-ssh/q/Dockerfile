FROM alpine:3
RUN apk add --no-cache autossh openssh-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# autossh runs as root inside the container — simpler read access to the
# bind-mounted /host/var/run/arduino-router.sock. The threat model assumes
# the container is isolated; a compromise of autossh inside it gets only
# what the container already has by design.
ENTRYPOINT ["/entrypoint.sh"]
