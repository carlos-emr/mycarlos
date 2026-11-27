#!/usr/bin/env python3
"""Builds the anonymizer's given-name and surname lists from public statistics
(the gazetteer way: fetched, hashed, licensed, tidied).

    python3 -I scripts/build-given-names.py fetch --raw DIR [--update-pins]
    python3 -I scripts/build-given-names.py build --raw DIR [--ssa-zip PATH]
    python3 -I scripts/build-given-names.py build --raw DIR --check

What it makes (src/deidentify/gazetteers/): given-names-en.json, -fr.json and
-pl.json (a name per line of `names`, lower case), and surnames-zh.json. They
gate one rule of the anonymizer: a header line such as "Home-care plan for
Avery Example" is a person only when the first word is a known given name (or,
for Chinese, the first character a known surname), so "Care Plan: Fall
Prevention" stays a title. See `src/deidentify/gazetteer.ts`.

`fetch` downloads each source named in `scripts/given-names-sources.json` into
the raw folder and checks its SHA-256 against the pin (`--update-pins` writes
the pin of a file seen for the first time; a later change in a source is an
error, never silently taken). It sends a plain client name, only to the hosts
listed in the pins file, over https. The US SSA file is not fetched: its site
refuses scripts, so it is downloaded by a person in a browser and given to
`build` with `--ssa-zip`; its SHA-256 is checked against the pin as well.

`build` reads the raw folder, checks every pin again, and writes the lists:
- a name is lower case, NFC, letters with an apostrophe or hyphen, two or more
  characters (a one-letter name is never a gate), a single word (a hyphen joins
  the parts of one name);
- births since 1940 are counted (Quebec's table starts in 1980, Poland's
  register lists people alive now); a name stays until the kept names hold 98 %
  of all counted births or people. Names given to fewer than five children in
  a year are "<5" in Quebec's table and count as 2;
- `scripts/given-names-exceptions.json` names the few names dropped by hand
  because they are ordinary words that do real harm as a gate, each with its
  reason. Names that are also common words (Rose, May, Faith) are KEPT: a
  missed name is the worse mistake.
`--check` rebuilds in memory and fails when a data file differs.
"""

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PINS = ROOT / "scripts" / "given-names-sources.json"
EXCEPTIONS = ROOT / "scripts" / "given-names-exceptions.json"
HUNDRED_FAMILY = ROOT / "scripts" / "hundred-family-surnames.txt"
MINIMAL_XLS = ROOT / "scripts" / "minimal_xls.py"
OUT = ROOT / "src" / "deidentify" / "gazetteers"
FIRST_YEAR = 1940
COVERAGE = 0.98
MAX_DOWNLOAD = 64 * 1024 * 1024
CLIENT = "mycarlos-gazetteer-build"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_pins() -> dict:
    return json.loads(PINS.read_text(encoding="utf-8"))


class ListedHostsOnly(urllib.request.HTTPRedirectHandler):
    """Refuses a redirect to anything but https on a listed host BEFORE the request is sent."""

    def __init__(self, hosts: set[str]) -> None:
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname not in self.hosts:
            raise urllib.error.HTTPError(newurl, code, "redirect off the listed hosts refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, hosts: set[str], opener=None) -> bytes:
    """The bytes at an https URL on a listed host; raises ValueError for anything else or a reply over the cap."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in hosts:
        raise ValueError(f"{url} is not an https URL on a listed host")
    opener = opener or urllib.request.build_opener(ListedHostsOnly(hosts))
    request = urllib.request.Request(url, headers={"User-Agent": CLIENT})
    with opener.open(request, timeout=120) as reply:
        data = reply.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise ValueError(f"larger than {MAX_DOWNLOAD} bytes")
    return data


def fetch(raw: Path, update_pins: bool, opener=None) -> int:
    pins = load_pins()
    raw.mkdir(parents=True, exist_ok=True)
    hosts = set(pins["hosts"])
    bad = 0
    for key, source in pins["sources"].items():
        if source.get("manual"):
            print(f"{key}: downloaded by a person, see its note")
            continue
        try:
            data = download(source["url"], hosts, opener)
        except (ValueError, urllib.error.URLError) as error:
            print(f"{key}: refused: {error}")
            bad += 1
            continue
        digest = sha256(data)
        if source.get("sha256") in (None, ""):
            if not update_pins:
                print(f"{key}: no pin; run with --update-pins to record {digest}")
                bad += 1
                continue
            source["sha256"] = digest
        elif source["sha256"] != digest:
            print(f"{key}: SHA-256 changed ({digest}), not taken")
            bad += 1
            continue
        (raw / source["file"]).write_bytes(data)
        print(f"{key}: {len(data)} bytes, sha256 {digest}")
    if update_pins:
        PINS.write_text(json.dumps(pins, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 1 if bad else 0


def read_source(raw: Path, key: str, pins: dict, path: Path | None = None) -> bytes:
    source = pins["sources"][key]
    path = path or raw / source["file"]
    data = path.read_bytes()
    if not source["sha256"]:
        raise SystemExit(f"{key}: no pin yet; the file's SHA-256 is {sha256(data)}: record it in {PINS.name}")
    if sha256(data) != source["sha256"]:
        raise SystemExit(f"{key}: {path} does not match its pinned SHA-256 {source['sha256']}")
    return data


# ---- names ---------------------------------------------------------------------------------


def tidy(name: str) -> str | None:
    """A name as stored, or None when it is no name for the gate."""
    name = unicodedata.normalize("NFC", name).strip().lower()
    if len(name) < 2 or not name[0].isalpha() or not name[-1].isalpha():
        return None
    if any(not (c.isalpha() or c in "'’-") for c in name):
        return None
    return name


class Tally:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.dropped: dict[str, int] = {}

    def add(self, raw_name: str, count: int) -> None:
        name = tidy(raw_name)
        if name is None:
            reason = "not a plain single-word name"
            if raw_name.strip():
                self.dropped[reason] = self.dropped.get(reason, 0) + 1
            return
        self.counts[name] = self.counts.get(name, 0) + count


def cut(tally: Tally, exceptions: dict[str, str]) -> tuple[list[str], dict]:
    """The names holding COVERAGE of the counted total, most frequent first, less the exceptions."""
    total = sum(tally.counts.values())
    ordered = sorted(tally.counts.items(), key=lambda item: (-item[1], item[0]))
    kept: list[str] = []
    running = 0
    for name, count in ordered:
        if running >= COVERAGE * total:
            break
        running += count
        kept.append(name)
    excepted = [name for name in kept if name in exceptions]
    kept = [name for name in kept if name not in exceptions]
    stats = {
        "counted": total,
        "distinct names counted": len(ordered),
        "below the 98 % cutoff": len(ordered) - len(kept) - len(excepted),
        "exceptions": len(excepted),
    }
    return sorted(kept), {**stats, **tally.dropped}


def csv_rows(data: bytes, delimiter: str = ",") -> list[list[str]]:
    text = data.decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def add_insee(tally: Tally, data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        rows = csv_rows(archive.read("nat2022.csv"), ";")
    for sexe, name, year, count in rows[1:]:
        if name.startswith("_") or not year.isdigit() or int(year) < FIRST_YEAR:
            continue
        tally.add(name, int(count))


def add_quebec(tally: Tally, data: bytes) -> None:
    rows = csv_rows(data)
    years = [int(label[2:]) for label in rows[0][1:]]
    for row in rows[1:]:
        name = row[0].strip()
        total = 0
        for year, cell in zip(years, row[1:]):
            if year < FIRST_YEAR:
                continue
            if cell == "<5":
                total += 2
            elif cell.isdigit():
                total += int(cell)
        if total:
            tally.add(name, total)


def add_ontario(tally: Tally, data: bytes) -> None:
    for year, name, count in csv_rows(data)[1:]:
        if year.isdigit() and int(year) >= FIRST_YEAR and count.isdigit():
            tally.add(name, int(count))


def first_word(name: str) -> str:
    """The first word of a given-name field: "Maria Jose" and "JOSE ANTONIO" are read as Maria and Jose."""
    return name.strip().split(" ", 1)[0]


def add_renaper(tally: Tally, data: bytes) -> None:
    """Argentina's RENAPER "Nombres de personas físicas": a zip of one csv (nombre,cantidad,anio), streamed."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        with archive.open(archive.namelist()[0]) as raw:
            for row in csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")):
                if len(row) != 3 or not row[1].isdigit() or not row[2].isdigit():
                    continue
                if int(row[2]) >= FIRST_YEAR:
                    tally.add(first_word(row[0]), int(row[1]))


def load_minimal_xls():
    spec = importlib.util.spec_from_file_location("minimal_xls", MINIMAL_XLS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def add_ine(tally: Tally, data: bytes) -> None:
    """Spain's INE "Nombres por edad media" (Padron Continuo, names held by 20 or more people): men, then women."""
    for sheet in load_minimal_xls().read_xls(data)[:2]:
        for (row, column), value in sheet.items():
            if column == 1 and row >= 7 and isinstance(value, str):
                count = sheet.get((row, 2))
                if isinstance(count, float) and count >= 1:
                    tally.add(first_word(value), int(count))


def add_ssa(tally: Tally, data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.namelist():
            match = re.fullmatch(r"yob(\d{4})\.txt", entry)
            if not match or int(match.group(1)) < FIRST_YEAR:
                continue
            for line in archive.read(entry).decode("utf-8").splitlines():
                name, _sex, count = line.split(",")
                tally.add(name, int(count))


def xlsx_rows(data: bytes) -> list[list[str]]:
    """Rows of the first sheet of a plain xlsx (shared strings and numbers), without an XML parser."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        shared = re.findall(
            r"<si>(.*?)</si>", archive.read("xl/sharedStrings.xml").decode("utf-8"), re.S
        )
        strings = ["".join(re.findall(r"<t[^>]*>([^<]*)</t>", item)) for item in shared]
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
    rows = []
    for row in re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S):
        cells = {}
        for ref, attrs, value in re.findall(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', row, re.S):
            found = re.search(r"<v>([^<]*)</v>", value or "")
            if not found:
                continue
            cells[ref] = strings[int(found.group(1))] if 't="s"' in attrs else found.group(1)
        rows.append([cells.get(letter, "") for letter in "ABC"])
    return rows


def add_pesel(tally: Tally, data: bytes) -> None:
    for name, _sex, count in xlsx_rows(data)[1:]:
        if count.isdigit():
            tally.add(name, int(count))


def taiwan_surnames(data: bytes) -> dict[str, int]:
    totals: dict[str, int] = {}
    for _year, _rank, surname, _age, people in csv_rows(data)[1:]:
        if people.isdigit():
            totals[surname] = totals.get(surname, 0) + int(people)
    return totals


# ---- build ---------------------------------------------------------------------------------


def meta(name: str, sources: list[str], pins: dict, built: dict, note: str, today: str) -> dict:
    return {
        "name": name,
        "synthetic": False,
        "sources": [
            {
                "url": pins["sources"][key]["url"],
                "sha256": pins["sources"][key]["sha256"],
                "licence": pins["sources"][key]["licence"],
            }
            for key in sources
        ],
        "made": today,
        "count": len(built["names"]),
        "dropped": built["dropped"],
        "note": note,
    }


def build_all(raw: Path, ssa_zip: Path | None, today: str) -> dict[str, str]:
    pins = load_pins()
    exceptions_all = json.loads(EXCEPTIONS.read_text(encoding="utf-8"))
    files: dict[str, str] = {}

    # The gate reads every list together, so a name dropped by hand is dropped from ALL of them (a
    # name left in another language's list would bring it back): the exceptions of every language apply
    # to every list. The `_note` key is not an exception.
    merged_exceptions = {
        name: reason
        for lang, hand in exceptions_all.items()
        if not lang.startswith("_")
        for name, reason in hand.items()
    }

    def lang_exceptions(lang: str) -> dict[str, str]:
        return merged_exceptions

    def write(file: str, name: str, sources: list[str], names: list[str], dropped: dict, note: str) -> None:
        document = meta(name, sources, pins, {"names": names, "dropped": dropped}, note, today)
        document["names"] = names
        files[file] = json.dumps(document, ensure_ascii=False, indent=1) + "\n"

    # en: Ontario (OGL-Ontario) and, when a person supplied it, the US SSA file.
    tally = Tally()
    sources = ["ontario-male", "ontario-female"]
    for key in sources:
        add_ontario(tally, read_source(raw, key, pins))
    if ssa_zip is not None:
        add_ssa(tally, read_source(raw, "ssa-national", pins, ssa_zip))
        sources.append("ssa-national")
    names, dropped = cut(tally, lang_exceptions("en"))
    write("given-names-en.json", "given-names-en", sources, names, dropped,
          "First names of children born since 1940 (Ontario registrations; the US Social Security "
          "national file when listed in sources), lower case, the commonest names holding 98 % of "
          "the births counted. Names that are also common words are kept on purpose.")

    # fr: INSEE (Licence Ouverte 2.0) and Retraite Quebec (CC-BY 4.0).
    tally = Tally()
    sources = ["insee-prenoms", "quebec-filles", "quebec-garcons"]
    add_insee(tally, read_source(raw, "insee-prenoms", pins))
    for key in ("quebec-filles", "quebec-garcons"):
        add_quebec(tally, read_source(raw, key, pins))
    names, dropped = cut(tally, lang_exceptions("fr"))
    write("given-names-fr.json", "given-names-fr", sources, names, dropped,
          "First names of children born since 1940 in France (INSEE, to 2022) and since 1980 in "
          "Quebec (Retraite Quebec), lower case, the commonest names holding 98 % of the births "
          "counted. Names that are also common words are kept on purpose.")

    # pl: the PESEL register's first names of people alive (CC0 1.0).
    tally = Tally()
    sources = ["pl-pesel-male", "pl-pesel-female"]
    for key in sources:
        add_pesel(tally, read_source(raw, key, pins))
    names, dropped = cut(tally, lang_exceptions("pl"))
    write("given-names-pl.json", "given-names-pl", sources, names, dropped,
          "First names of people alive in the PESEL register (20 Jan 2026), lower case, the "
          "commonest names holding 98 % of the people counted. Names that are also common words "
          "are kept on purpose.")

    # es: Argentina's RENAPER (CC BY 4.0, births 1940 on) and Spain's INE Padron (people alive, 20 or more).
    tally = Tally()
    sources = ["renaper-historico", "ine-nombres-edad-media"]
    add_renaper(tally, read_source(raw, "renaper-historico", pins))
    add_ine(tally, read_source(raw, "ine-nombres-edad-media", pins))
    names, dropped = cut(tally, lang_exceptions("es"))
    write("given-names-es.json", "given-names-es", sources, names, dropped,
          "First words of first names: births since 1940 in Argentina (RENAPER) and the people in "
          "Spain's Padron Continuo at 1 Jan 2022 whose name is held by 20 or more (INE), lower case, "
          "the commonest names holding 98 % of the counted. Names that are also common words are kept "
          "on purpose.")

    # zh: surnames. Taiwan's register (Government Open Data License v1), top 98 % of people, and the
    # Hundred Family Surnames (a public-domain classical text, in simplified characters).
    taiwan = taiwan_surnames(read_source(raw, "taiwan-surnames", pins))
    total = sum(taiwan.values())
    kept, running = [], 0
    for surname, people in sorted(taiwan.items(), key=lambda item: (-item[1], item[0])):
        if running >= COVERAGE * total:
            break
        running += people
        kept.append(surname)
    classical = [
        token
        for line in HUNDRED_FAMILY.read_text(encoding="utf-8").splitlines()
        if not line.startswith("#")
        for token in line.split()
    ]
    names = sorted(set(kept) | set(classical))
    document = {
        "name": "surnames-zh",
        "synthetic": False,
        "sources": [
            {
                "url": pins["sources"]["taiwan-surnames"]["url"],
                "sha256": pins["sources"]["taiwan-surnames"]["sha256"],
                "licence": pins["sources"]["taiwan-surnames"]["licence"],
            },
            {
                "url": "scripts/hundred-family-surnames.txt",
                "sha256": sha256(HUNDRED_FAMILY.read_bytes()),
                "licence": "Public domain (a Song-dynasty text; this transcription is the project's own)",
            },
        ],
        "made": today,
        "count": len(names),
        "dropped": {"below the 98 % cutoff (Taiwan)": len(taiwan) - len(kept)},
        "note": "Surnames, simplified (the Hundred Family Surnames) and traditional (Taiwan's "
        "register, the commonest holding 98 % of people). A Han given name is one or two "
        "characters after a surname, so the surname is the gate, not a given-name list.",
        "names": names,
    }
    files["surnames-zh.json"] = json.dumps(document, ensure_ascii=False, indent=1) + "\n"
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--raw", type=Path, required=True)
    f.add_argument("--update-pins", action="store_true")
    b = sub.add_parser("build")
    b.add_argument("--raw", type=Path, required=True)
    b.add_argument("--ssa-zip", type=Path)
    b.add_argument("--check", action="store_true")
    b.add_argument("--date", default=None, help="the 'made' date (default: today, or the date in the files with --check)")
    args = parser.parse_args()
    if args.command == "fetch":
        return fetch(args.raw, args.update_pins)
    today = args.date
    if today is None:
        existing = OUT / "given-names-fr.json"
        if args.check and existing.exists():
            today = json.loads(existing.read_text(encoding="utf-8"))["made"]
        else:
            today = date.today().isoformat()
    files = build_all(args.raw, args.ssa_zip, today)
    if args.check:
        stale = [name for name, text in files.items() if not (OUT / name).exists() or (OUT / name).read_text(encoding="utf-8") != text]
        if stale:
            print("stale: " + ", ".join(stale))
            return 1
        print("up to date")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8")
        print(f"{name}: {len(text)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
