## 3. Verified facts about my UNO Q (hostname: `linucs.local`)

All the following were checked on my physical board in April 2026. Don't assume they hold on other boards — re-verify before generalizing.

### Router process

```
root   596   /usr/bin/arduino-router \
             --unix-port /var/run/arduino-router.sock \
             --serial-port /dev/ttyHS1 \
             --serial-baudrate 115200
```

- Runs as **root** at system boot (probably via systemd unit).
- **No TCP listener** — only Unix socket. So we ignore `msgpack-rpc-router:host-gateway` tricks.
- Router version reported by `$/version`: **`0.8.0`** (was `0.5.4` in February 2026; protocol is stable across versions).
- The `--monitor-port` flag (defaults to `127.0.0.1:7500`) is a separate MCU monitor proxy, unrelated to our RPC usage.

### Socket

```
srw-rw-rw- 1 root root   0 Feb 22 07:24 /var/run/arduino-router.sock
```

- **World-writable** (`0666`) — any user/container can read and write.
- Owned by root but the mode takes precedence. No need for user/group workarounds when running containers.

### MCU transport

- Serial: `/dev/ttyHS1` @ 115200, 8N1.
- Managed exclusively by the router. **Never open this device manually** — the router owns it and competing for it will break everything.

### App storage

- App Lab is a **remote editor**: source code lives on the UNO Q, not on the PC. A firmware update wipes all user apps. → **git on the PC is the source of truth, always.**
- On the UNO Q, apps live under `/home/arduino/arduinoApps/` (exact capitalization may vary between `arduinoApps` / `ArduinoApps` / `Arduino Apps` depending on App Lab version — check `ls /home/arduino/` when in doubt).

### Open hardware question

- **Which UNO Q variant do I own, 2 GB or 4 GB?** Check `free -h` on the board. n8n + router + OS sits comfortably on 4 GB. On 2 GB we might have to be more frugal (lean n8n image, fewer concurrent workflows). TODO: verify and record in a `hardware.md` note.
