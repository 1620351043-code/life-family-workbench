"""Parse one uploaded finance export into the server's normalized import contract.

This worker deliberately does not write a database or the object store.  It is
an isolated parser process: the TypeScript API owns the tenant-scoped write
transaction after validating this JSON result.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import asdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SPIKE_ROOT = ROOT / "spikes" / "spike-b-finance-import"
sys.path.insert(0, str(SPIKE_ROOT))

from import_spike import parse_rows  # noqa: E402


PARSER_VERSION = "real-bill-parser-v1-security-v2"
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_CSV_ROWS = 100_000
MAX_CSV_COLUMNS = 512
MAX_CELL_CHARS = 8_192
MAX_SHEETS = 64
MAX_WORKBOOK_ROWS = 100_000
MAX_WORKBOOK_COLUMNS = 512
MAX_CELL_COUNT = 5_000_000
MAX_ZIP_ENTRIES = 5_000
MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024
SOFFICE = Path("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice")
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_MAGIC = b"PK\x03\x04"


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
    """Return a bounded, line-numbered preview around the detected header."""
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


def _assert_file_size(path: Path) -> None:
    if not path.is_file():
        raise ValueError(f"账单文件不存在：{path}")
    size = path.stat().st_size
    if size < 1:
        raise ValueError("FILE_EMPTY：账单文件不能为空")
    if size > MAX_FILE_BYTES:
        raise ValueError("FILE_TOO_LARGE：账单文件不能超过 50MB")


def _unsafe_zip_name(name: str) -> bool:
    lower = name.lower()
    if not name or "\x00" in name or len(name) > 1024:
        return True
    if name.startswith("/") or name.startswith("\\") or "\\" in name or name[:2].lower() in {"c:", "d:", "e:", "f:"}:
        return True
    if any(part in {".", ".."} for part in name.split("/")):
        return True
    if lower.startswith("__macosx/"):
        return True
    if "vbaproject.bin" in lower or "externallink" in lower or "externalblink" in lower:
        return True
    if lower.endswith((".xlsm", ".xltm", ".xlam")):
        return True
    return False


def validate_xlsx_zip(path: Path) -> None:
    raw = path.read_bytes()[:4]
    if raw != ZIP_MAGIC:
        raise ValueError("XLSX_MAGIC_MISMATCH：文件不是 ZIP/XLSX 结构")
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise ValueError("ZIP_ENTRIES_EXCEEDED：账单压缩包条目过多")
            names = []
            total = 0
            for info in infos:
                name = info.filename
                if _unsafe_zip_name(name):
                    raise ValueError("ZIP_UNSAFE_PATH：账单压缩包包含非法路径或宏")
                if info.flag_bits & 0x1:
                    raise ValueError("ZIP_ENCRYPTED：不支持加密账单文件")
                if info.compress_type not in (0, 8):
                    raise ValueError("ZIP_COMPRESSION_UNSUPPORTED：账单压缩方式不受支持")
                if info.file_size > MAX_ZIP_ENTRY_BYTES:
                    raise ValueError("ZIP_ENTRY_TOO_LARGE：账单压缩包条目解压后过大")
                total += info.file_size
                if total > MAX_ZIP_TOTAL_BYTES:
                    raise ValueError("ZIP_TOTAL_TOO_LARGE：账单压缩包解压后总大小超过安全限制")
                external = (info.external_attr >> 16) & 0xFFFF
                if (external & 0xF000) == 0xA000:
                    raise ValueError("ZIP_SYMLINK：账单压缩包不能包含符号链接")
                names.append(name)
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                raise ValueError("XLSX_STRUCTURE_MISSING：缺少标准工作簿结构")
            for info in infos:
                lower = info.filename.lower()
                if lower.endswith(".rels") or lower.endswith("workbook.xml"):
                    if info.file_size > 0 and info.file_size <= MAX_ZIP_ENTRY_BYTES:
                        payload = archive.read(info).lower()
                        if b"externallink" in payload or b"<externalr" in payload:
                            raise ValueError("XLSX_EXTERNAL_LINK：工作簿包含外部引用")
    except zipfile.BadZipFile as error:
        raise ValueError("XLSX_BAD_ZIP：账单文件不是有效的 XLSX") from error


def validate_xls(path: Path) -> None:
    raw = path.read_bytes()[:8]
    if raw != OLE_MAGIC:
        raise ValueError("XLS_MAGIC_MISMATCH：文件不是有效的旧版 Excel 文档")


def validate_csv(path: Path) -> None:
    raw = path.read_bytes()
    if raw[:4] == ZIP_MAGIC or raw[:8] == OLE_MAGIC:
        raise ValueError("CSV_MAGIC_MISMATCH：CSV 内容与其扩展名不符")


def read_csv_bounded(path: Path) -> list[list[str]]:
    validate_csv(path)
    _assert_file_size(path)
    raw = path.read_bytes()
    text = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk", "utf-16"):
        try:
            decoded = raw.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
        if "\x00" in decoded:
            continue
        text = decoded
        break
    if text is None:
        raise ValueError("CSV_ENCODING_UNSUPPORTED：无法识别账单 CSV 编码")
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) > MAX_CSV_ROWS:
        raise ValueError("CSV_ROWS_EXCEEDED：账单 CSV 行数超过 100000")
    for row_number, row in enumerate(rows, start=1):
        if len(row) > MAX_CSV_COLUMNS:
            raise ValueError("CSV_COLUMNS_EXCEEDED：账单 CSV 列数超过安全限制")
        for value in row:
            if len(value) > MAX_CELL_CHARS:
                raise ValueError("CSV_CELL_TOO_LARGE：账单 CSV 单元格超过安全长度")
    return rows


def convert_xls(path: Path, output_dir: Path, profile_dir: Path) -> Path:
    if not SOFFICE.exists():
        raise RuntimeError("当前环境没有可用的 soffice，无法读取 .xls")
    try:
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
            timeout=60,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("XLS_CONVERT_TIMEOUT：旧版 Excel 转换超过 60 秒") from error
    converted = output_dir / f"{path.stem}.xlsx"
    if not converted.exists():
        raise ValueError("XLS_CONVERT_MISSING：xls 转换结果不存在")
    return converted


def read_workbook_bounded(path: Path, temp_dir: Path, profile_dir: Path) -> list[tuple[str, list[list[object]]]]:
    _assert_file_size(path)
    if path.suffix.lower() == ".xlsx":
        validate_xlsx_zip(path)
        source = path
    elif path.suffix.lower() == ".xls":
        validate_xls(path)
        source = convert_xls(path, temp_dir, profile_dir)
    else:
        raise ValueError("WORKBOOK_TYPE_UNSUPPORTED：仅支持 XLS 或 XLSX")
    book = pd.ExcelFile(source, engine="openpyxl")
    if len(book.sheet_names) > MAX_SHEETS:
        raise ValueError("WORKBOOK_SHEETS_EXCEEDED：工作表数量超过 64")
    result = []
    total_cells = 0
    for sheet_name in book.sheet_names:
        frame = pd.read_excel(source, sheet_name=sheet_name, header=None, dtype=object, engine="openpyxl", nrows=MAX_WORKBOOK_ROWS + 1)
        if len(frame) > MAX_WORKBOOK_ROWS:
            raise ValueError("WORKBOOK_ROWS_EXCEEDED：工作表行数超过 100000")
        if frame.shape[1] > MAX_WORKBOOK_COLUMNS:
            raise ValueError("WORKBOOK_COLUMNS_EXCEEDED：工作表列数超过安全限制")
        rows = [[value for value in row.tolist()] for _, row in frame.iterrows()]
        total_cells += sum(len(row) for row in rows)
        if total_cells > MAX_CELL_COUNT:
            raise ValueError("WORKBOOK_CELLS_EXCEEDED：账单单元格总量超过安全限制")
        result.append((sheet_name, rows))
    return result


def parse_csv_file(path: Path, source_type: str) -> list[dict]:
    rows = read_csv_bounded(path)
    parsed = parse_rows(rows, source_type, path.name)
    parsed["header"] = [str(value) for value in rows[parsed["header_row"] - 1]]
    parsed["preview_rows"] = build_preview(rows, parsed["header_row"])
    return [normalize_item(parsed, None, source_type)]


def parse_workbook_file(path: Path, source_type: str) -> list[dict]:
    items: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="life-finance-worker-") as temp_name, tempfile.TemporaryDirectory(prefix="life-finance-soffice-") as profile_name:
        for sheet_name, rows in read_workbook_bounded(path, Path(temp_name), Path(profile_name)):
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


def run(path: Path, source_type: str, display_name: str | None = None) -> dict:
    if not path.is_file():
        raise ValueError(f"账单文件不存在：{path}")
    suffix = path.suffix.lower()
    if suffix not in {".csv", ".xls", ".xlsx"}:
        raise ValueError("FILE_TYPE_UNSUPPORTED：首发版本仅支持 CSV、XLS、XLSX")
    _assert_file_size(path)
    file_name = display_name or path.name
    sheets = parse_csv_file(path, source_type) if suffix == ".csv" else parse_workbook_file(path, source_type)
    if not sheets:
        raise ValueError("WORKBOOK_EMPTY：账单文件中没有可处理的工作表")
    non_empty = [sheet for sheet in sheets if sheet.get("records")]
    detected = non_empty[0] if non_empty else sheets[0]
    records = [record for sheet in sheets for record in sheet.get("records", [])]
    return {
        "schema_version": "life.finance.import.v1",
        "parser_version": PARSER_VERSION,
        "source_type": source_type,
        "file_name": file_name,
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
    parser.add_argument("--file-name", default=None)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.file, args.source_type, args.file_name), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:  # The API converts this to a failed import state.
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
