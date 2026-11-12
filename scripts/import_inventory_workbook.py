#!/usr/bin/env python3
"""Extract the F22/E92 workbook snapshot without third-party dependencies.

Usage:
  python scripts/import_inventory_workbook.py workbook.xlsx \
    --output data/inventory/f22-e92-2026-11-08.json

The machine-readable PARTS REGISTER supplies one record per physical label.
Worksheet row numbers are part of each identity: identical labels are separate
stock records. BIN DIRECTORY, REVIEW NOTES, and STOCK MOVEMENTS are retained as
source evidence. This script only writes a local JSON file; it never connects to
Supabase or changes inventory. It intentionally does not infer item matches with
older inventory, infer counts for blanks, or convert sets/lots to piece counts.
"""

import argparse
from collections import Counter
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile


MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SNAPSHOT_ID = "f22-e92-2026-11-08"
EFFECTIVE_DATE = "2026-11-08"


def column_index(reference):
    number = 0
    for letter in re.match(r"[A-Z]+", reference).group():
        number = number * 26 + ord(letter) - ord("A") + 1
    return number - 1


def read_workbook(path):
    """Read cached cell values from the OOXML workbook, including shared text."""
    with ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            tree = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [
                "".join(node.text or "" for node in entry.iter(MAIN + "t"))
                for entry in tree
            ]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        properties = workbook.find(MAIN + "workbookPr")
        date_1904 = properties is not None and properties.get("date1904") in ("1", "true")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {entry.get("Id"): entry.get("Target") for entry in relationships}
        sheets = {}
        for sheet in workbook.find(MAIN + "sheets"):
            target = targets[sheet.get(REL + "id")]
            filename = target.lstrip("/") if target.startswith("/") else str(PurePosixPath("xl") / target)
            tree = ET.fromstring(archive.read(filename))
            rows = []
            for row in tree.findall(".//" + MAIN + "sheetData/" + MAIN + "row"):
                cells = {}
                for cell in row.findall(MAIN + "c"):
                    index = column_index(cell.get("r"))
                    kind = cell.get("t")
                    value_node = cell.find(MAIN + "v")
                    raw = value_node.text if value_node is not None else None
                    if kind == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(MAIN + "t"))
                    elif raw is None:
                        value = None
                    elif kind == "s":
                        value = shared[int(raw)]
                    elif kind == "b":
                        value = raw == "1"
                    elif kind in ("str", "e", "d"):
                        value = raw
                    else:
                        value = float(raw) if any(char in raw.lower() for char in ".e") else int(raw)
                        if isinstance(value, float) and value.is_integer():
                            value = int(value)
                    cells[index] = value
                values = [cells.get(index) for index in range(max(cells, default=-1) + 1)]
                if any(value is not None for value in values):
                    rows.append((int(row.get("r")), values))
            sheets[sheet.get("name")] = rows
        return sheets, date_1904


def iso_date(value, date_1904=False):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        epoch = date(1904, 1, 1) if date_1904 else date(1899, 12, 30)
        return (epoch + timedelta(days=value)).isoformat()
    return str(value).split("T")[0]


def records_after_header(rows, expected_header, keys):
    found = False
    for row_number, cells in rows:
        if not found:
            if cells[:len(expected_header)] == expected_header:
                found = True
            continue
        padded = cells + [None] * max(0, len(keys) - len(cells))
        yield row_number, dict(zip(keys, padded))
    if not found:
        raise ValueError(f"Missing worksheet header: {expected_header!r}")


def extract(path):
    sheets, date_1904 = read_workbook(path)
    part_keys = [
        "source_chassis", "bin_code", "category", "label_text", "item_name",
        "condition", "quantity_raw", "quantity_unit", "label_note", "part_number",
        "label_date", "source_photo", "review", "parent_bin_code",
    ]
    parts = []
    for row_number, part in records_after_header(
        sheets["PARTS REGISTER"], ["CHASSIS", "BIN ID", "CATEGORY"], part_keys
    ):
        platform = part["bin_code"].split("-", 1)[0]
        if platform not in ("F22", "E92"):
            raise ValueError(f"Unexpected platform in parts row {row_number}: {platform}")
        raw_quantity = part["quantity_raw"]
        if raw_quantity is None or raw_quantity == "VARIOUS":
            quantity = None
        elif isinstance(raw_quantity, int) and not isinstance(raw_quantity, bool) and raw_quantity >= 0:
            quantity = raw_quantity
        else:
            raise ValueError(f"Unexpected quantity in parts row {row_number}: {raw_quantity!r}")
        part.update(
            inventory_code=f"{part['bin_code']}-L{row_number:03d}",
            platform=platform,
            compatibility=part["source_chassis"].split("/"),
            quantity=quantity,
            label_date=iso_date(part["label_date"], date_1904),
            source_row=row_number,
        )
        parts.append(part)

    bins = []
    bin_keys = ["platform", "bin_code", "parent_bin_code", "description", "tagged_entries", "stock_status", "source_reference"]
    for row_number, bin_record in records_after_header(
        sheets["BIN DIRECTORY"], ["CHASSIS", "BIN / SUB-BIN", "PARENT BIN"], bin_keys
    ):
        bin_record["source_row"] = row_number
        bins.append(bin_record)

    notes = []
    note_keys = ["status", "bin_code", "type", "source_observation", "handling_decision", "photo"]
    for row_number, note in records_after_header(
        sheets["REVIEW NOTES"], ["STATUS", "BIN", "TYPE"], note_keys
    ):
        single_cell = all(value is None for key, value in note.items() if key != "status")
        note["record_type"] = (
            "section_heading" if note["status"] == "TRANSCRIPTION RULES"
            else "transcription_rule" if single_cell else "note"
        )
        note["source_row"] = row_number
        notes.append(note)

    movements = []
    movement_keys = [
        "date", "platform", "bin_code", "item_or_part_number", "quantity_change",
        "previous_quantity", "current_quantity", "action", "destination_or_disposition", "source_reference",
    ]
    for row_number, movement in records_after_header(
        sheets["STOCK MOVEMENTS"], ["DATE", "CHASSIS", "BIN"], movement_keys
    ):
        movement["date"] = iso_date(movement["date"], date_1904)
        movement["source_row"] = row_number
        movements.append(movement)

    counts = Counter(part["bin_code"] for part in parts)
    if len(parts) != 215 or len({part["inventory_code"] for part in parts}) != 215:
        raise ValueError("Expected 215 distinct physical label records")
    if Counter(part["platform"] for part in parts) != {"F22": 92, "E92": 123}:
        raise ValueError("Unexpected chassis record totals")
    if len(bins) != 43 or len({entry["parent_bin_code"] for entry in bins}) != 39:
        raise ValueError("Expected 43 directory entries across 39 parent bins")
    for entry in bins:
        if entry["tagged_entries"] != counts[entry["bin_code"]]:
            raise ValueError(f"Directory count mismatch for {entry['bin_code']}")
    if set(counts) - {entry["bin_code"] for entry in bins}:
        raise ValueError("Part records refer to a bin missing from the directory")

    summary = {}
    for platform in ("F22", "E92"):
        chassis_parts = [part for part in parts if part["platform"] == platform]
        subtotals = Counter()
        for part in chassis_parts:
            if part["quantity"] is not None:
                subtotals[part["quantity_unit"]] += part["quantity"]
        summary[platform] = {
            "records": len(chassis_parts),
            "quantity_known_records": sum(part["quantity"] is not None for part in chassis_parts),
            "quantity_unknown_records": sum(part["quantity"] is None for part in chassis_parts),
            "quantity_subtotals_by_source_unit": dict(sorted(subtotals.items())),
            "directory_entries": sum(entry["platform"] == platform for entry in bins),
            "parent_bins": len({entry["parent_bin_code"] for entry in bins if entry["platform"] == platform}),
        }
    return {
        "schema_version": 1,
        "snapshot_id": SNAPSHOT_ID,
        "source_file": path.name,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "effective_date": EFFECTIVE_DATE,
        "scope": ["F22", "E92"],
        "summary": summary,
        "parts": parts,
        "bins": bins,
        "review_notes": notes,
        "stock_movements": movements,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/inventory/f22-e92-2026-11-08.json"))
    args = parser.parse_args()
    snapshot = extract(args.workbook)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Extracted {len(snapshot['parts'])} labels, {len(snapshot['bins'])} directory entries, "
          f"{len(snapshot['review_notes'])} review/rule entries, {len(snapshot['stock_movements'])} movements to {args.output}")


if __name__ == "__main__":
    main()
