"""Deterministic security contract test for the finance import Python worker.

The test only creates synthetic files; it never reads or prints real bill
content. It verifies the worker rejects binary CSV, malformed XLSX, macros,
external links and ZIP traversal before attempting to parse.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "workers" / "finance_import_worker.py"
PYTHON_CANDIDATES = [
    os.environ.get("LIFE_FINANCE_PARSER_PYTHON"),
    "/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
    "python3",
]


def find_python() -> str:
    for candidate in PYTHON_CANDIDATES:
        if candidate and (candidate == "python3" or Path(candidate).exists()):
            return candidate
    raise RuntimeError("未找到可用 Python 运行时")


def run_worker(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [find_python(), str(WORKER), "--file", str(path), "--source-type", "bank"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=90,
    )


def main() -> int:
    checks = 0
    with tempfile.TemporaryDirectory(prefix="life-finance-worker-security-") as temp_name:
        temp = Path(temp_name)

        valid_csv = temp / "valid.csv"
        valid_csv.write_text("交易时间,金额,收支,交易对方,流水号\n2026-01-01 12:00:00,1.00,支出,测试,SEC-001\n", encoding="utf-8")
        result = run_worker(valid_csv)
        if result.returncode != 0:
            raise AssertionError(f"valid CSV rejected: {result.stderr}")
        parsed = json.loads(result.stdout)
        checks += 1

        binary_csv = temp / "binary.csv"
        binary_csv.write_bytes(b"PK\x03\x04not-a-csv")
        result = run_worker(binary_csv)
        if result.returncode == 0 or "CSV_MAGIC_MISMATCH" not in result.stderr:
            raise AssertionError("binary CSV was not rejected")
        checks += 1

        fake_xlsx = temp / "fake.xlsx"
        fake_xlsx.write_bytes(b"not-a-zip")
        result = run_worker(fake_xlsx)
        if result.returncode == 0 or "XLSX_MAGIC_MISMATCH" not in result.stderr:
            raise AssertionError("fake XLSX was not rejected")
        checks += 1

        macro_xlsx = temp / "macro.xlsx"
        with zipfile.ZipFile(macro_xlsx, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", "<workbook/>")
            archive.writestr("xl/vbaProject.bin", "macro")
        result = run_worker(macro_xlsx)
        if result.returncode == 0 or "ZIP_UNSAFE_PATH" not in result.stderr:
            raise AssertionError("macro XLSX was not rejected")
        checks += 1

        traversal_xlsx = temp / "traversal.xlsx"
        with zipfile.ZipFile(traversal_xlsx, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", "<workbook/>")
            archive.writestr("../evil.xml", "evil")
        result = run_worker(traversal_xlsx)
        if result.returncode == 0 or "ZIP_UNSAFE_PATH" not in result.stderr:
            raise AssertionError("ZIP traversal was not rejected")
        checks += 1

        external_xlsx = temp / "external.xlsx"
        with zipfile.ZipFile(external_xlsx, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", "<workbook/>")
            archive.writestr("xl/externalLinks/externalLink1.xml", "<external/>")
        result = run_worker(external_xlsx)
        if result.returncode == 0 or "ZIP_UNSAFE_PATH" not in result.stderr:
            raise AssertionError("external link XLSX was not rejected")
        checks += 1

    print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
