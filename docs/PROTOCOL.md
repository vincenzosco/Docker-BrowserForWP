# The render protocol, version 1

One TCP connection per device. TLS 1.3 only. Length-prefixed binary frames, and
every field is big-endian.

The byte layouts in this document are a restatement of `protocol/messages.js`,
which is the definition. Where the two ever disagree, the code is right and this
file is a bug. `protocol/vectors.json` is the third statement of the same thing,
in concrete bytes, and it is the one a second implementation is checked against.

## Why binary

Two reasons, both from the device:

- The phone's client is a VB/WinRT project with no JSON parser anywhere in it.
  Adding one would be new attack surface for a format the device never needs.
- Base64 inside JSON inflates every frame by a third, on a link that is usually
  3G. Frame payloads are JPEG and they stay as JPEG.

## The primitives

| Type | Meaning |
| --- | --- |
| `u8`, `u16`, `u32` | Unsigned big-endian integers. |
| `i8`, `i16`, `i32` | Signed big-endian, two's complement. |
| `str` | `u32` byte length, then that many bytes of UTF-8. The length counts BYTES, not characters. |
| `blob` | `u32` byte length, then that many raw bytes. |

Every read is bounds-checked, and every decoder rejects trailing bytes. A frame
that is one byte too long is a disagreement about the layout, not an extension to
be ignored.

## The frame header

16 bytes, at the start of every frame, sealed or not.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 2 | MAGIC | `0xB752` |
| 2 | 1 | VERSION | `1` |
| 3 | 1 | TYPE | See the tables below. |
| 4 | 4 | LENGTH | Bytes AFTER the header. For a sealed frame this is ciphertext + 16-byte tag. |
| 8 | 4 | SEQ | Per direction, starts at 1, increments per frame. The AEAD nonce is this value. |
| 12 | 4 | RESERVED | `0`. A non-zero value means a newer client, and is refused. |

A frame whose declared `LENGTH` exceeds 8 MiB is refused before anything is
allocated for it.

## Sealing

Frames with `TYPE >= 0x10` are sealed. Frames below that are the handshake and
travel in the clear, because the material that would seal them does not exist
yet.

```
prk    = HKDF-Extract(salt = sessionSalt, ikm = deviceToken)
keyC2S = HKDF-Expand(prk, info = "bfwp/render/v1/c2s", 32)
keyS2C = HKDF-Expand(prk, info = "bfwp/render/v1/s2c", 32)
```

`HKDF-Extract` is HMAC-SHA256 with the salt as the key and the token as the
message, and an EMPTY salt is replaced by 32 zero bytes rather than by no key
material. `HKDF-Expand` is RFC 5869 section 2.3.

Each direction has its own key, so a frame cannot be reflected back at its
sender and the two sequence spaces cannot collide.

Per frame:

- Cipher: AES-256-GCM, so the key is 32 bytes.
- Nonce: 12 bytes, the sequence number big-endian in the last 4 bytes.
- AAD: **the 16 header bytes**, with `LENGTH` = ciphertext length + 16.
- Wire order after the header: ciphertext, then the 16-byte tag.

Authenticating the header is what stops a frame being relabelled or truncated:
the tag covers the type, the length and the sequence number.

A receiver MUST refuse a frame whose sequence number is not greater than the
highest it has accepted, and MUST NOT advance its counter when a tag fails to
verify. Both of those are replay windows, and both are asserted in
`test/seal.test.js`.

## Handshake

### 0x01 HELLO, client to server, plaintext

| Field | Type |
| --- | --- |
| protocolVersion | u8 (`1`) |
| deviceId | str |
| token | str |
| viewportWidth | u16 |
| viewportHeight | u16 |
| devicePixelRatio | u8 (1..4) |
| clientName | str |

A viewport with a zero side, or a pixel ratio below 1, is refused before any
browser is started.

### 0x02 HELLO_ACK, server to client, plaintext

Always begins with `u8 ok`.

`ok = 0` (refused):

| Field | Type |
| --- | --- |
| code | u16 |
| message | str |

`ok = 1` (accepted):

| Field | Type |
| --- | --- |
| sessionSalt | blob (32 bytes) |
| maxFrameBytes | u32 |
| flags | u8 (bit 0: audio available) |
| serverName | str |
| audioUrl | str (empty when audio is off) |

**This message must go out in the clear even when the session is refused**, which
is why the salt is here at all: it is what the client derives its keys from, so a
sealed version of it would be unreadable by definition.

### 0x03 ERROR, server to client, plaintext

| Field | Type |
| --- | --- |
| code | u16 |
| message | str |

Used only for protocol failures and for a server at its session limit. Page
failures after the handshake are `LOAD_STATE`.

### Error codes

| Code | Meaning |
| --- | --- |
| 1 | Unsupported protocol version. |
| 2 | The device token does not match. |
| 3 | This device id is not registered here. |
| 4 | This device has been disabled. |
| 5 | Protocol violation. |
| 6 | The server is at its session limit. |
| 7 | The server failed. |

## Client to server

All of these are sealed.

| Type | Name | Fields |
| --- | --- | --- |
| 0x10 | NAVIGATE | str url |
| 0x11 | BACK | — |
| 0x12 | FORWARD | — |
| 0x13 | RELOAD | — |
| 0x14 | STOP | — |
| 0x15 | RESIZE | u16 width, u16 height, u8 devicePixelRatio |
| 0x16 | TAP | u16 x, u16 y, u8 buttons (1 = left, 2 = right), u8 clickCount |
| 0x17 | SCROLL | u16 x, u16 y, i16 deltaX, i16 deltaY |
| 0x18 | KEY | str key, u8 modifiers, str text |
| 0x19 | TEXT | str text |
| 0x1A | FIND | str text |
| 0x1B | SETTINGS | u8 flags (bit 0 night mode, bit 1 desktop mode, bit 2 block trackers) |
| 0x1C | PING | u32 nonce |
| 0x1D | ACK | u32 frameSeq |

`key` is a Playwright key name (`"Enter"`, `"Backspace"`, `"Tab"`), not a scan
code, so the client needs no key table. When `KEY.text` is non-empty the server
inserts text instead of pressing a key.

`NAVIGATE` accepts what a person types: a missing scheme becomes `https://`. Any
scheme that is not `http:` or `https:` closes the session, and `file:`,
`javascript:`, `data:` and `chrome:` never reach Chromium.

## Server to client

All of these are sealed.

| Type | Name | Fields |
| --- | --- | --- |
| 0x20 | TITLE | str title |
| 0x21 | URL | str url |
| 0x22 | LOAD_STATE | u8 state (0 started, 1 done, 2 failed), str detail |
| 0x23 | FRAME | See below. |
| 0x24 | FIND_RESULT | u8 found, u32 matches |
| 0x25 | AUDIO | u8 playing, str url |
| 0x26 | PONG | u32 nonce |

### 0x23 FRAME

| Field | Type |
| --- | --- |
| format | u8 (`1` = JPEG) |
| flags | u8 (bit 0: the tiles cover the whole viewport) |
| tileCount | u16 |
| tiles | `tileCount` repetitions of: u16 x, u16 y, u16 width, u16 height, blob jpeg |

Coordinates are device pixels. Tiles are a list rather than one rectangle
because the primitive that produces them today (Chromium's screencast) hands back
a whole viewport, and a differ that sends only the changed rectangles is the
obvious next step. It costs two bytes now and saves a protocol version later.

## Flow control

**At most one frame may be unacknowledged.** After sending a `FRAME` the server
stops Chromium's screencast tap and buffers nothing; the client's `ACK` with a
`frameSeq` at or above the frame in flight restarts it. A frame that arrives
while another is in flight is dropped, deliberately.

This is the mechanism that keeps a 3G handset from being buried by a screenshot
stream, and it is why nothing in this server grows a queue.

`RESIZE` clears the frame in flight, because the old frame describes a viewport
that no longer exists.

## Conformance

`protocol/vectors.json` has, for a fixed token and a fixed salt:

- the PRK and both directional keys,
- the nonce for five sequence numbers including `0xffffffff`,
- the encoded bytes of every message,
- 19 sealed frames in full, with the nonce and the AAD called out separately,
  in both directions.

A second implementation of this document passes when it can produce those bytes
and open those frames. Publishing the AAD and the nonce as their own fields is
deliberate: when a frame fails to open, those two say whether the header or the
key is wrong, which is otherwise a guess.
