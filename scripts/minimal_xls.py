"""A minimal reader of old binary .xls files (OLE2 compound file + BIFF8), for plain tables: strings (SST),
numbers (NUMBER, RK, MULRK). Returns each worksheet as {(row, col): value}. No formulas, no styles, no
macros are read or run. Used by scripts/build-given-names.py for the INE name tables (stdlib only)."""
import struct


def cfb_stream(data: bytes, wanted: str) -> bytes:
    assert data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    shift = struct.unpack_from("<H", data, 30)[0]
    mini_shift = struct.unpack_from("<H", data, 32)[0]
    size = 1 << shift
    n_fat, first_dir, _, mini_cutoff, first_minifat, n_minifat, first_difat, n_difat = struct.unpack_from(
        "<IIIIIIII", data, 44
    )

    def sector(i):
        off = (i + 1) * size
        return data[off : off + size]

    difat = list(struct.unpack_from("<109I", data, 76))
    nxt, left = first_difat, n_difat
    while left and nxt < 0xFFFFFFFA:
        sec = sector(nxt)
        vals = struct.unpack("<%dI" % (size // 4), sec)
        difat += list(vals[:-1])
        nxt = vals[-1]
        left -= 1
    fat = []
    for s in difat:
        if s >= 0xFFFFFFFA:
            continue
        fat += list(struct.unpack("<%dI" % (size // 4), sector(s)))

    def chain(start):
        out, seen = [], set()
        while start < 0xFFFFFFFA and start not in seen:
            seen.add(start)
            out.append(start)
            start = fat[start]
        return out

    directory = b"".join(sector(s) for s in chain(first_dir))
    root = None
    entries = []
    for i in range(len(directory) // 128):
        e = directory[i * 128 : (i + 1) * 128]
        name_len = struct.unpack_from("<H", e, 64)[0]
        name = e[: max(0, name_len - 2)].decode("utf-16-le")
        typ = e[66]
        start = struct.unpack_from("<I", e, 116)[0]
        length = struct.unpack_from("<Q", e, 120)[0]
        entries.append((name, typ, start, length))
        if typ == 5:
            root = (start, length)
    for name, typ, start, length in entries:
        if name == wanted and typ == 2:
            if length >= mini_cutoff:
                return b"".join(sector(s) for s in chain(start))[:length]
            mini_size = 1 << mini_shift
            mini_data = b"".join(sector(s) for s in chain(root[0]))[: root[1]]
            minifat = []
            for s in chain(first_minifat):
                minifat += list(struct.unpack("<%dI" % (size // 4), sector(s)))
            out, cur = b"", start
            while cur < 0xFFFFFFFA:
                out += mini_data[cur * mini_size : (cur + 1) * mini_size]
                cur = minifat[cur]
            return out[:length]
    raise KeyError(wanted)


def records(stream: bytes):
    pos = 0
    while pos + 4 <= len(stream):
        typ, ln = struct.unpack_from("<HH", stream, pos)
        yield typ, stream[pos + 4 : pos + 4 + ln]
        pos += 4 + ln


def read_sst(chunks):
    """chunks: the SST record body then each CONTINUE body. Returns the list of strings."""
    cur = {"i": 0, "buf": chunks[0], "ci": 0}

    def need(n):
        out = b""
        while n > 0:
            avail = len(cur["buf"]) - cur["i"]
            if avail == 0:
                cur["ci"] += 1
                cur["buf"] = chunks[cur["ci"]]
                cur["i"] = 0
                continue
            take = min(n, avail)
            out += cur["buf"][cur["i"] : cur["i"] + take]
            cur["i"] += take
            n -= take
        return out

    need(4)  # total refs
    unique = struct.unpack("<I", need(4))[0]
    strings = []
    for _ in range(unique):
        length = struct.unpack("<H", need(2))[0]
        flags = need(1)[0]
        rich = struct.unpack("<H", need(2))[0] if flags & 8 else 0
        ext = struct.unpack("<I", need(4))[0] if flags & 4 else 0
        wide = flags & 1
        text = ""
        remaining = length
        while remaining > 0:
            avail = len(cur["buf"]) - cur["i"]
            if avail == 0:
                cur["ci"] += 1
                cur["buf"] = chunks[cur["ci"]]
                cur["i"] = 0
                wide = cur["buf"][0] & 1
                cur["i"] = 1
                continue
            per = 2 if wide else 1
            take = min(remaining, avail // per)
            raw = cur["buf"][cur["i"] : cur["i"] + take * per]
            cur["i"] += take * per
            text += raw.decode("utf-16-le" if wide else "latin-1")
            remaining -= take
        if rich:
            need(4 * rich)
        if ext:
            need(ext)
        strings.append(text)
    return strings


def rk(value: int) -> float:
    if value & 2:
        number = float(value >> 2) if value < 0x80000000 else float((value - (1 << 32)) >> 2)
    else:
        number = struct.unpack("<d", struct.pack("<Q", (value & 0xFFFFFFFC) << 32))[0]
    return number / 100 if value & 1 else number


def read_xls(data: bytes):
    stream = cfb_stream(data, "Workbook")
    sheets = []
    sst_chunks, strings = [], None
    current = None
    in_sst = False
    for typ, body in records(stream):
        if typ == 0x00FC:
            sst_chunks = [body]
            in_sst = True
            continue
        if typ == 0x003C and in_sst:
            sst_chunks.append(body)
            continue
        if in_sst:
            strings = read_sst(sst_chunks)
            in_sst = False
        if typ == 0x0809:  # BOF
            kind = struct.unpack_from("<H", body, 2)[0]
            if kind == 0x0010:
                current = {}
                sheets.append(current)
            else:
                current = None
        elif current is not None:
            if typ == 0x00FD and strings is not None:
                row, col, _xf, idx = struct.unpack_from("<HHHI", body)
                current[(row, col)] = strings[idx]
            elif typ == 0x0203:
                row, col, _xf = struct.unpack_from("<HHH", body)
                current[(row, col)] = struct.unpack_from("<d", body, 6)[0]
            elif typ == 0x027E:
                row, col, _xf, v = struct.unpack_from("<HHHI", body)
                current[(row, col)] = rk(v)
            elif typ == 0x00BD:
                row, first = struct.unpack_from("<HH", body)
                n = (len(body) - 6) // 6
                for k in range(n):
                    v = struct.unpack_from("<I", body, 4 + k * 6 + 2)[0]
                    current[(row, first + k)] = rk(v)
    return sheets
