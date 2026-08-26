"""Parse one uploaded finance export into the server's normalized import contract.

This worker deliberately does not write a database or the object store.  It is
an isolated parser process: the TypeScript API owns the tenant-scoped write
transaction after validating this JSON result.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SPIKE_ROOT = ROOT / "spikes" / "spike-b-finance-import"
sys.path.insert(0, str(SPIKE_ROOT))

from import_spike import parse_rows  # noqa: E402
from real_bill_replay import read_csv, read_workbook  # noqa: E402


PARSER_VERSION = "real-bill-parser-v1"


def _cell_text(value: object) -> str:
    if value is None:
        return ""
    try:
        if bool(pd.isna(value)):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value)


def build_preview(rows: list[list[object]], header_row: int | None, limit: int = 48) -> list[dict]:
    """Return a bounded, line-numbered preview around the detected header.

    The preview is intentionally metadata only: it is persisted with the
    import batch so the mobile client can confirm the header without opening
    the original file. Transaction rows are still written separately through
    import_row/source_record after the worker result is validated.
    """
    if not rows:
        return []
    selected = set(range(1, min(len(rows), limit) + 1))
    if header_row:
        selected.update(range(max(1, header_row - 3), min(len(rows), header_row + 8) + 1))
    result = []
    for row_number in sorted(selected):
        values = [_cell_text(value) for value in rows[row_number - 1][:24]]
        if header_row and row_number == header_row:
            role = "header"
        elif header_row and row_number >= header_row + 1:
            role = "data"
        elif any(values):
            role = "metadata"
        else:
            role = "blank"
        result.append({"row_number": row_number, "values": values, "role": role})
    return result


def normalize_datetime(value: str) -> str:
    parsed = pd.to_datetime(value, errors="raise")
    if pd.isna(parsed):
        raise ValueError("交易时间为空")
    return parsed.to_pydatetime().isoformat(sep=" ")


def normalize_item(item: dict, sheet_name: str | None, source_type: str) -> dict:
    mapping = item.get("mapping", {})
    header_row = int(item["header_row"])
    records = []
    for record in item.get("records", []):
        data = asdict(record)
        data.pop("source", None)
        data.pop("source_file", None)
        data["source_row_number"] = int(data.pop("row_number"))
        data["occurred_at"] = normalize_datetime(str(data["occurred_at"]))
        amount = float(data["amount"])
        data["amount"] = f"{amount:.4f}"
        data["currency"] = "CNY"
        data["source_fingerprint"] = data.pop("fingerprint")
        data["sheet_name"] = sheet_name
        records.append(data)

    header = item.get("header", [])
    resolved_mapping = {
        field: str(header[index]) if isinstance(index, int) and index < len(header) else str(index)
        for field, index in mapping.items()
    }
    return {
        "sheet_name": sheet_name,
        "header_row": header_row,
        "data_start_row": header_row + 1,
        "header_score": int(item.get("header_score", 0)),
        "field_mapping": resolved_mapping,
        "preview_rows": item.get("preview_rows", []),
        "records": records,
        "skipped_rows": int(item.get("skipped_rows", 0)),
        "source_type": source_type,
    }


def parse_csv_file(path: Path, source_type: str) -> list[dict]:
    rows = read_csv(path)
    parsed = parse_rows(rows, source_type, path.name)
    parsed["header"] = [str(value) for value in rows[parsed["header_row"] - 1]]
    parsed["preview_rows"] = build_preview(rows, parsed["header_row"])
    return [normalize_item(parsed, None, source_type)]


def parse_workbook_file(path: Path, source_type: str) -> list[dict]:
    items: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="life-finance-worker-") as temp_name, tempfile.TemporaryDirectory(prefix="life-finance-soffice-") as profile_name:
        for sheet_name, rows in read_workbook(path, Path(temp_name), Path(profile_name)):
            if not rows:
                items.append({
                    "sheet_name": sheet_name,
                    "header_row": None,
                    "data_start_row": None,
                    "header_score": 0,
                    "field_mapping": {},
                    "records": [],
                    "preview_rows": [],
                    "skipped_rows": 0,
                    "source_type": source_type,
                    "empty": True,
                })
                continue
            parsed = parse_rows(rows, source_type, path.name)
            parsed["header"] = [str(value) for value in rows[parsed["header_row"] - 1]]
            parsed["preview_rows"] = build_preview(rows, parsed["header_row"])
            items.append(normalize_item(parsed, sheet_name, source_type))
    return items


def run(path: Path, source_type: str) -> dict:
    if not path.is_file():
        raise ValueError(f"账单文件不存在：{path}")
    sheets = parse_csv_file(path, source_type) if path.suffix.lower() == ".csv" else parse_workbook_file(path, source_type)
    non_empty = [sheet for sheet in sheets if sheet.get("records")]
    detected = non_empty[0] if non_empty else sheets[0]
    records = [record for sheet in sheets for record in sheet.get("records", [])]
    return {
        "schema_version": "life.finance.import.v1",
        "parser_version": PARSER_VERSION,
        "source_type": source_type,
        "file_name": path.name,
        "detected_sheet": detected.get("sheet_name"),
        "detected_header_row": detected.get("header_row"),
        "sheets": sheets,
        "records": records,
        "counts": {
            "sheets": len(sheets),
            "rows": len(records),
            "skipped_rows": sum(int(sheet.get("skipped_rows", 0)) for sheet in sheets),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--source-type", required=True, choices=["bank", "alipay", "wechat", "bookkeeping_app", "other"])
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.file, args.source_type), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:  # The API converts this to a failed import state.
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
