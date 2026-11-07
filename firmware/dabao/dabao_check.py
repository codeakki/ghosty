#!/usr/bin/env python3
"""dabao_check.py - talk to the Dabao signer through the ESP32 running 08_DabaoBridge.

  python3 firmware/dabao/dabao_check.py <esp32 port>            print the signer address
  python3 firmware/dabao/dabao_check.py <esp32 port> --sign     also ask it to sign a test order
                                                                (press the PB3 button; nothing is sent
                                                                to Hyperliquid)
Standard library only (termios), so it runs without pyserial.
"""
import os
import select
import struct
import sys
import termios
import time

ERRORS = {1: "bad frame", 2: "unknown command", 3: "malformed order", 4: "asset not allowed",
          5: "above the order limit", 6: "wrong network", 7: "old nonce", 8: "button not pressed in time",
          9: "no key", 10: "signing failed"}


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def frame(kind, payload=b""):
    body = bytes([kind]) + struct.pack("<H", len(payload)) + payload
    return b"\xa5" + body + struct.pack("<H", crc16(body))


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    a = termios.tcgetattr(fd)
    a[4] = a[5] = termios.B115200
    a[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG | termios.IEXTEN)
    a[2] = (a[2] & ~termios.CSIZE) | termios.CS8 | termios.CLOCAL | termios.CREAD
    a[0] = 0
    a[1] = 0
    termios.tcsetattr(fd, termios.TCSANOW, a)
    time.sleep(1.5)  # the ESP32 may reset when the port opens
    termios.tcflush(fd, termios.TCIFLUSH)
    return fd


def request(fd, data, timeout):
    os.write(fd, data)
    buf, end = b"", time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                buf += os.read(fd, 256)
            except BlockingIOError:
                pass
        i = buf.find(b"\xa5")
        while i >= 0 and len(buf) >= i + 6:
            n = struct.unpack_from("<H", buf, i + 2)[0]
            if len(buf) >= i + 6 + n and crc16(buf[i + 1:i + 4 + n]) == struct.unpack_from("<H", buf, i + 4 + n)[0]:
                return buf[i + 1], buf[i + 4:i + 4 + n]
            i = buf.find(b"\xa5", i + 1)
    raise SystemExit(f"no reply from the Dabao (raw bytes: {buf.hex() or 'none'})")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    fd = open_port(sys.argv[1])
    kind, p = request(fd, frame(0x01), 3)
    if kind == 0xFF:
        raise SystemExit(f"error: {ERRORS.get(p[0], p[0])}")
    print(f"address 0x{p[:20].hex()}  network {'mainnet' if p[20] == 0 else 'testnet'}  version {p[21]}")
    if "--sign" in sys.argv:
        px, sz = b"4106", b"0.0025"
        order = struct.pack("<IBBQ", 110003, 1, 0, int(time.time() * 1000)) + bytes([len(px)]) + px + bytes([len(sz)]) + sz
        print("press the PB3 button on the Dabao (60 s) ...")
        kind, p = request(fd, frame(0x02, order), 65)
        print(f"signature r={p[:32].hex()} s={p[32:].hex()}" if kind == 0x82 else f"error: {ERRORS.get(p[0], p[0])}")


if __name__ == "__main__":
    main()
