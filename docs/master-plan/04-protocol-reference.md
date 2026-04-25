## 4. Protocol reference

### Transport

- Unix socket: `/var/run/arduino-router.sock`. Bind-mount into containers with `-v /var/run/arduino-router.sock:/var/run/arduino-router.sock` — this is the only connection method we use.
- Message framing: **raw msgpack values back-to-back**, no length prefix. Use a streaming decoder (e.g., `@msgpack/msgpack` `Decoder` with `.decodeMulti()`) that can read one value at a time.

### Message shapes (MessagePack-RPC spec)

- **REQUEST**: `[0, msgid, method_name, params_array]` — expects a RESPONSE.
- **RESPONSE**: `[1, msgid, error, result]` — `error` is `null` on success, a string (or array) describing the failure otherwise.
- **NOTIFY**: `[2, method_name, params_array]` — fire-and-forget, no `msgid`, no response.

### Arduino-specific methods (the only non-standard bit)

- **`$/register <method_name>`** — advertise that you handle calls to `method_name`. Returns `true` on success, error string if the name is already taken.
- **`$/reset`** — drop all methods registered by this connection.
- **`$/version`** — returns router version as string.
- **`$/serial/open`** / **`$/serial/close`** — manage the MCU serial connection. Don't touch these; the router handles it.
- **`$/setMaxMsgSize <bytes>`** — per-router message size cap.

### Flow reference

```
Client A registers "foo":
  A → Router: [0, 50, "$/register", ["foo"]]
  Router → A: [1, 50, null, true]

Client B calls "foo":
  B → Router:       [0, 32, "foo", [1, true]]
  Router → A:       [0, 51, "foo", [1, true]]          (router remaps msgid)
  A → Router:       [1, 51, null, "result"]
  Router → B:       [1, 32, null, "result"]            (router remaps back)

MCU fires an async event (NOTIFY path):
  MCU → Router:     [2, "button_pressed", [3, "rising"]]
  Router → trigger: [2, "button_pressed", [3, "rising"]]   (if a client registered it)
```

When a client disconnects, all its registrations are dropped automatically. Plan reconnection/re-registration logic in the client around this.
