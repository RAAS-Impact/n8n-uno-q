#!/bin/sh
exec socat TCP-LISTEN:${INTERNAL_PORT:-5775},reuseaddr,fork UNIX-CONNECT:/host/var/run/arduino-router.sock
