#!/usr/bin/env python3
"""The given-name list builder tidies, cuts and reads its sources as the anonymizer relies on.

Run: python3 scripts/build-given-names.test.py
"""

import io
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from unittest import mock
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
builder = SourceFileLoader("build_given_names", str(ROOT / "scripts/build-given-names.py")).load_module()


def tiny_xlsx(rows):
    """A minimal xlsx whose first sheet holds `rows` (strings and numbers), as dane.gov.pl's files do."""
    strings = []
    cells = []
    for index, row in enumerate(rows, start=1):
        line = []
        for letter, value in zip("ABC", row):
            if isinstance(value, int):
                line.append(f'<c r="{letter}{index}"><v>{value}</v></c>')
            else:
                strings.append(value)
                line.append(f'<c r="{letter}{index}" t="s"><v>{len(strings) - 1}</v></c>')
        cells.append(f'<row r="{index}">{"".join(line)}</row>')
    shared = "".join(f"<si><t>{text}</t></si>" for text in strings)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/sharedStrings.xml", f"<sst>{shared}</sst>")
        archive.writestr("xl/worksheets/sheet1.xml", f"<worksheet><sheetData>{''.join(cells)}</sheetData></worksheet>")
    return buffer.getvalue()


class Tidy(unittest.TestCase):
    def test_a_plain_name_is_lower_case_nfc(self):
        self.assertEqual(builder.tidy("AVERY"), "avery")
        self.assertEqual(builder.tidy("  Hélène "), "hélène")
        self.assertEqual(builder.tidy("JEAN-PHILIPPE"), "jean-philippe")
        self.assertEqual(builder.tidy("D'ARCY"), "d'arcy")

    def test_what_is_no_single_word_name_is_dropped(self):
        for bad in ["A", "", "MARIE JOSE", "X1", "ABC.", "-AB", "AB-", "_PRENOMS_RARES", "<5"]:
            self.assertIsNone(builder.tidy(bad), bad)


class Cut(unittest.TestCase):
    def test_the_commonest_names_hold_98_percent_and_exceptions_are_out(self):
        tally = builder.Tally()
        tally.add("Anna", 600)
        tally.add("Rose", 300)
        tally.add("Inna", 90)
        tally.add("Zed", 8)
        tally.add("Rare", 2)
        names, stats = builder.cut(tally, {"inna": "an ordinary word"})
        # 98 % of 1000 is 980: anna, rose and inna reach 990, so zed and rare fall below the cutoff.
        self.assertEqual(names, ["anna", "rose"])
        self.assertEqual(stats["exceptions"], 1)
        self.assertEqual(stats["below the 98 % cutoff"], 2)
        self.assertEqual(stats["counted"], 1000)

    def test_names_that_are_also_words_stay(self):
        tally = builder.Tally()
        for name, count in [("May", 500), ("Faith", 400), ("Rose", 99)]:
            tally.add(name, count)
        names, _ = builder.cut(tally, {})
        self.assertEqual(names, ["faith", "may", "rose"])


class Readers(unittest.TestCase):
    def test_quebec_counts_less_than_five_as_two_and_skips_the_years_before_1940(self):
        tally = builder.Tally()
        builder.add_quebec(tally, "﻿PRENOMS,A_1980,A_1981\nEMMA,<5,10\nLEA,.,.\n".encode("utf-8"))
        self.assertEqual(tally.counts, {"emma": 12})

    def test_ontario_counts_only_births_from_1940(self):
        tally = builder.Tally()
        builder.add_ontario(tally, "﻿Year/Année,Name/Nom,Frequency/Fréquence\n1917,AARON,7\n1950,AARON,5\n".encode("utf-8"))
        self.assertEqual(tally.counts, {"aaron": 5})

    def test_insee_skips_the_rare_names_row_and_early_years(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("nat2022.csv", "sexe;preusuel;annais;nombre\n1;_PRENOMS_RARES;1950;999\n1;JEAN;1900;50\n1;JEAN;1950;40\n")
        tally = builder.Tally()
        builder.add_insee(tally, buffer.getvalue())
        self.assertEqual(tally.counts, {"jean": 40})

    def test_pesel_reads_names_and_counts_from_an_xlsx(self):
        tally = builder.Tally()
        data = tiny_xlsx([("IMIĘ_PIERWSZE", "PŁEĆ", "LICZBA_WYSTĄPIEŃ"), ("ANNA", "KOBIETA", 1200), ("ZOFIA", "KOBIETA", 30)])
        builder.add_pesel(tally, data)
        self.assertEqual(tally.counts, {"anna": 1200, "zofia": 30})

    def test_taiwan_surnames_add_up_the_three_age_groups(self):
        csv_text = "﻿年度,ranking,lastname,age,人口數\n112,1,陳,0~14歲,3\n112,1,陳,15~64歲,5\n112,2,林,0~14歲,2\n".encode("utf-8")
        self.assertEqual(builder.taiwan_surnames(csv_text), {"陳": 8, "林": 2})


class FakeReply:
    def __init__(self, data):
        self.data = data

    def read(self, limit=None):
        return self.data if limit is None else self.data[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, data=b"x"):
        self.calls = []
        self.data = data

    def open(self, request, timeout=None):
        self.calls.append(request.full_url)
        return FakeReply(self.data)


HOSTS = {"data.example"}


class Fetch(unittest.TestCase):
    def test_an_unlisted_host_or_a_plain_http_url_is_refused_before_any_request(self):
        opener = FakeOpener()
        for url in ["https://evil.example/a.csv", "http://data.example/a.csv", "ftp://data.example/a"]:
            with self.assertRaises(ValueError, msg=url):
                builder.download(url, HOSTS, opener)
        self.assertEqual(opener.calls, [])

    def test_a_listed_https_url_is_downloaded(self):
        opener = FakeOpener(b"names")
        self.assertEqual(builder.download("https://data.example/a.csv", HOSTS, opener), b"names")
        self.assertEqual(opener.calls, ["https://data.example/a.csv"])

    def test_a_reply_over_the_cap_is_refused(self):
        with mock.patch.object(builder, "MAX_DOWNLOAD", 4):
            with self.assertRaises(ValueError):
                builder.download("https://data.example/a.csv", HOSTS, FakeOpener(b"12345"))

    def test_a_redirect_off_the_listed_hosts_is_refused_before_the_next_request_is_made(self):
        handler = builder.ListedHostsOnly(HOSTS)
        request = urllib.request.Request("https://data.example/a.csv")
        for target in ["https://evil.example/x", "http://data.example/x", "file:///etc/passwd"]:
            with self.assertRaises(urllib.error.HTTPError, msg=target):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        followed = handler.redirect_request(request, None, 302, "Found", {}, "https://data.example/b.csv")
        self.assertEqual(followed.full_url, "https://data.example/b.csv")

    def pins(self, sha=""):
        return {
            "hosts": ["data.example"],
            "sources": {"one": {"file": "one.csv", "url": "https://data.example/one.csv", "sha256": sha}},
        }

    def run_fetch(self, pins, opener, update=False):
        with tempfile.TemporaryDirectory() as folder:
            pins_file = Path(folder) / "pins.json"
            with mock.patch.object(builder, "load_pins", return_value=pins), mock.patch.object(builder, "PINS", pins_file):
                code = builder.fetch(Path(folder), update, opener)
            return code, (Path(folder) / "one.csv").exists(), pins_file.exists()

    def test_a_changed_source_is_not_taken(self):
        code, written, _ = self.run_fetch(self.pins("0" * 64), FakeOpener(b"changed"))
        self.assertEqual((code, written), (1, False))

    def test_an_unpinned_file_needs_update_pins_and_is_then_pinned(self):
        pins = self.pins("")
        self.assertEqual(self.run_fetch(pins, FakeOpener(b"data"))[:2], (1, False))
        code, written, rewrote = self.run_fetch(pins, FakeOpener(b"data"), update=True)
        self.assertEqual((code, written, rewrote), (0, True, True))
        self.assertEqual(pins["sources"]["one"]["sha256"], builder.sha256(b"data"))

    def test_a_matching_pin_is_taken(self):
        code, written, _ = self.run_fetch(self.pins(builder.sha256(b"same")), FakeOpener(b"same"))
        self.assertEqual((code, written), (0, True))


if __name__ == "__main__":
    unittest.main()
