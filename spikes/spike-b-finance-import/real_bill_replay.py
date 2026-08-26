"""Replay real user-provided bill files without printing transaction content.

The command reports only file structure, field mappings, row counts, hashes,
and source-linkage counts. It intentionally does not print merchant names,
account numbers, remarks, order IDs, or monetary totals.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

import pandas as pd

from import_spike import (
    cross_source_links,
    dedupe_same_source,
    duplicate_groups,
    parse_file,
    parse_rows,
    merchant_key,
)


SOFFICE = Path("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice")


def classify(path: Path) -> str:
    name = path.name
    if "支付宝" in name:
        return "alipay"
    if "微信" in name:
        return "wechat"
    if "hqmx" in name.lower():
        return "bank"
    if "时光序" in name:
        return "bookkeeping_app"
    return "unknown"


def read_csv(path: Path) -> list[list[str]]:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk", "utf-16"):
        try:
            with path.open("r", encoding=encoding, newline="") as handle:
                return [row for row in csv.reader(handle)]
        except (UnicodeDecodeError, UnicodeError):
            continue
    raise ValueError(f"无法识别 CSV 编码：{path.name}")


def convert_xls(path: Path, output_dir: Path, profile_dir: Path) -> Path:
    if not SOFFICE.exists():
        raise RuntimeError("当前环境没有可用的 soffice，无法读取 .xls")
    subprocess.run(
        [
            str(SOFFICE),
            f"-env:UserInstallation=file://{profile_dir}",
            "--headless",
            "--convert-to",
            "xlsx",
            "--outdir",
            str(output_dir),
            str(path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    converted = output_dir / f"{path.stem}.xlsx"
    if not converted.exists():
        raise RuntimeError(f".xls 转换结果不存在：{path.name}")
    return converted


def read_workbook(path: Path, temp_dir: Path, profile_dir: Path) -> list[tuple[str, list[list[object]]]]:
    source = convert_xls(path, temp_dir, profile_dir) if path.suffix.lower() == ".xls" else path
    book = pd.ExcelFile(source, engine="openpyxl")
    result = []
    for sheet in book.sheet_names:
        frame = pd.read_excel(source, sheet_name=sheet, header=None, dtype=object, engine="openpyxl")
        rows = [[value for value in row.tolist()] for _, row in frame.iterrows()]
        result.append((sheet, rows))
    return result


def compact_file_report(path: Path) -> dict:
    return {
        "file": path.name,
        "source": classify(path),
        "suffix": path.suffix.lower(),
        "size_bytes": path.stat().st_size,
        "sha256_prefix": hashlib.sha256(path.read_bytes()).hexdigest()[:16],
    }


def run(input_dir: Path) -> dict:
    paths = sorted(path for path in input_dir.iterdir() if path.is_file() and path.suffix.lower() in {".csv", ".xls", ".xlsx"})
    if not paths:
        raise ValueError(f"目录中没有可处理的账单文件：{input_dir}")

    parsed_items: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="life-bill-replay-") as temp_name, tempfile.TemporaryDirectory(prefix="life-soffice-profile-") as profile_name:
        temp_dir = Path(temp_name)
        profile_dir = Path(profile_name)
        for path in paths:
            source = classify(path)
            if source == "unknown":
                continue
            if path.suffix.lower() == ".csv":
                parsed_items.append(parse_file(path, source))
            else:
                for sheet, rows in read_workbook(path, temp_dir, profile_dir):
                    if not rows:
                        parsed_items.append({"source": source, "file": path.name, "sheet": sheet, "records": [], "skipped_rows": 0, "empty": True})
                        continue
                    item = parse_rows(rows, source, path.name)
                    item["sheet"] = sheet
                    parsed_items.append(item)

    records = [record for item in parsed_items for record in item.get("records", [])]
    deduped = dedupe_same_source(records)
    links = cross_source_links(deduped)
    duplicate_groups_by_strength = Counter(item["strength"] for item in duplicate_groups(records))
    source_counts = Counter(record.source for record in records)
    dedupe_counts = Counter(record.source for record in deduped)
    link_pairs = Counter(
        tuple(sorted((item["bank_anchor"]["source"], item["detail_source"]["source"]))) for item in links
    )
    file_reports = []
    for item in parsed_items:
        file_report = {
            "file": item["file"],
            "sheet": item.get("sheet"),
            "source": item["source"],
            "header_row": item.get("header_row"),
            "header_score": item.get("header_score"),
            "mapped_fields": sorted(item.get("mapping", {}).keys()),
            "parsed_records": len(item.get("records", [])),
            "skipped_rows": item.get("skipped_rows", 0),
            "empty": item.get("empty", False),
        }
        file_reports.append(file_report)

    return {
        "files": [compact_file_report(path) for path in paths],
        "sheets": file_reports,
        "source_record_counts": dict(sorted(source_counts.items())),
        "same_source_deduped_counts": dict(sorted(dedupe_counts.items())),
        "same_source_duplicate_groups": len(duplicate_groups(records)),
        "same_source_duplicate_groups_by_strength": dict(sorted(duplicate_groups_by_strength.items())),
        "cross_source_pending_links": len(links),
        "cross_source_link_pairs": {f"{left}->{right}": count for (left, right), count in sorted(link_pairs.items())},
        "privacy": {
            "printed_transaction_values": False,
            "printed_amounts": False,
            "printed_accounts": False,
            "printed_merchants": False,
        },
        "notes": [
            "跨来源关联仍为 pending_review，不自动写入正式账本。",
            "同源去重先于跨来源关联。",
            "金额、商户、账号、备注和订单号不在本报告输出。",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", nargs="?", type=Path, default=Path("/Users/wrt/Downloads/账单"))
    args = parser.parse_args()
    print(json.dumps(run(args.input_dir), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
