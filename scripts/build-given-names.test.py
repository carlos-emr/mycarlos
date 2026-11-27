#!/usr/bin/env python3
"""The given-name list builder tidies, cuts and reads its sources as the anonymizer relies on.

Run: python3 scripts/build-given-names.test.py
"""

import io
import unittest
import zipfile
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


if __name__ == "__main__":
    unittest.main()
