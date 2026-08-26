"""Small bill import spike.

It covers the minimum V1.0 import mechanics: header detection in the first
100 rows, source-specific field aliases, normalization, same-source
idempotency, and cross-source linkage with a bank anchor.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"

ALIASES = {
    "occurred_at": ["交易时间", "交易创建时间", "交易日期", "日期", "时间", "发生日期", "记账日期"],
    "direction": ["收/支", "收支类型", "收支", "交易类型", "借贷标志", "收支方向"],
    "amount": ["交易金额", "金额(元)", "金额", "订单金额", "发生额", "本次金额"],
    "merchant": ["交易对方", "对方账号与户名", "商户", "对方户名", "对方账号", "交易描述", "商品说明", "名称", "用途", "摘要"],
    "category": ["分类（必填）", "分类"],
    "external_id": ["交易流水号", "交易订单号", "交易单号", "流水号", "订单号", "参考号"],
    "channel": ["收/付款方式", "支付方式", "交易渠道", "渠道"],
    "remark": ["交易地点/附言", "附言", "备注", "商品说明", "订单备注", "摘要"],
}


def clean(value: str) -> str:
    return re.sub(r"\s+", "", value or "").strip().lower()


def merchant_key(value: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]", "", value or "").lower()


def read_rows(path: Path) -> list[list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.reader(handle)]


def field_for_header_cell(value: str) -> str | None:
    normalized = clean(value)
    if not normalized:
        return None
    for field, aliases in ALIASES.items():
        for alias in aliases:
            candidate = clean(alias)
            if normalized == candidate or (len(normalized) <= 24 and candidate in normalized):
                return field
    return None


def header_score(row: list[str]) -> int:
    fields = {field for field in (field_for_header_cell(cell) for cell in row) if field}
    score = len(fields)
    if "occurred_at" in fields:
        score += 2
    if "amount" in fields:
        score += 2
    return score


def detect_header(rows: list[list[str]], scan_limit: int = 100) -> tuple[int, int]:
    """Return zero-based header line and confidence score."""
    candidates: list[tuple[int, int]] = []
    for index, row in enumerate(rows[:scan_limit]):
        candidates.append((header_score(row), index))
        if index + 1 < min(len(rows), scan_limit):
            combined = row + rows[index + 1]
            candidates.append((header_score(combined), index + 1))
    score, index = max(candidates, key=lambda item: (item[0], -item[1]))
    if score < 3:
        raise ValueError("无法在前 100 行内找到足够可信的表头")
    return index, score


def field_map(header: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    # Alias order is intentional. For WeChat, 收/支 is authoritative and
    # must win over the broader 交易类型 column.
    for field, aliases in ALIASES.items():
        for alias in aliases:
            normalized_alias = clean(alias)
            index = next(
                (position for position, cell_value in enumerate(header) if clean(cell_value) == normalized_alias),
                None,
            )
            if index is not None:
                mapping[field] = index
                break
    required = {"occurred_at", "amount"}
    missing = required - mapping.keys()
    if missing:
        raise ValueError(f"缺少必要字段：{','.join(sorted(missing))}")
    return mapping


def stringify(value: object) -> str:
    if value is None:
        return ""
    value = getattr(value, "to_pydatetime", lambda: value)()
    if hasattr(value, "isoformat") and not isinstance(value, str):
        return value.isoformat(sep=" ")
    return str(value).strip()


def cell(row: list[object], mapping: dict[str, int], field: str) -> str:
    index = mapping.get(field)
    return stringify(row[index]) if index is not None and index < len(row) else ""


def parse_amount(raw: str) -> tuple[str, float]:
    value = (raw or "").replace(",", "").replace("¥", "").replace("￥", "").strip()
    negative = value.startswith("-") or value.startswith("(")
    value = value.strip("()")
    amount = abs(float(value))
    return ("expense" if negative else "income"), amount


def normalize_direction(raw: str, amount_direction: str) -> str:
    value = clean(raw)
    if "支出" in value or value in {"出", "expense"}:
        return "expense"
    if "收入" in value or value in {"入", "income"}:
        return "income"
    if "转账" in value or "transfer" in value:
        return "transfer"
    return amount_direction


@dataclass(frozen=True)
class Record:
    source: str
    source_file: str
    row_number: int
    occurred_at: str
    direction: str
    amount: float
    merchant: str
    external_id: str
    channel: str
    remark: str
    fingerprint: str


def parse_rows(rows: list[list[object]], source: str, source_file: str, header_index: int | None = None) -> dict:
    if header_index is None:
        header_index, score = detect_header([[stringify(value) for value in row] for row in rows])
    else:
        score = header_score([stringify(value) for value in rows[header_index]])
    mapping = field_map([stringify(value) for value in rows[header_index]])
    records: list[Record] = []
    skipped_rows = 0
    for row_number, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        if not any(stringify(cell_value).strip() for cell_value in row):
            continue
        try:
            raw_direction, amount = parse_amount(cell(row, mapping, "amount"))
        except (TypeError, ValueError):
            skipped_rows += 1
            continue
        direction = normalize_direction(cell(row, mapping, "direction"), raw_direction)
        occurred_at = cell(row, mapping, "occurred_at")
        merchant = cell(row, mapping, "merchant") or cell(row, mapping, "category") or cell(row, mapping, "remark")
        if not occurred_at:
            skipped_rows += 1
            continue
        external_id = cell(row, mapping, "external_id")
        channel = cell(row, mapping, "channel")
        remark = cell(row, mapping, "remark")
        basis = "|".join([source, external_id or "", occurred_at, direction, f"{amount:.2f}", merchant_key(merchant)])
        fingerprint = hashlib.sha256(basis.encode("utf-8")).hexdigest()
        records.append(
            Record(
                source=source,
                source_file=source_file,
                row_number=row_number,
                occurred_at=occurred_at,
                direction=direction,
                amount=amount,
                merchant=merchant,
                external_id=external_id,
                channel=channel,
                remark=remark,
                fingerprint=fingerprint,
            )
        )
    return {
        "source": source,
        "file": source_file,
        "header_row": header_index + 1,
        "header_score": score,
        "mapping": mapping,
        "records": records,
        "skipped_rows": skipped_rows,
    }


def parse_file(path: Path, source: str) -> dict:
    rows = read_rows(path)
    return parse_rows(rows, source, path.name)


def duplicate_groups(records: list[Record]) -> list[dict]:
    buckets: dict[tuple[str, str], list[Record]] = {}
    for record in records:
        # For the same source, an external transaction ID is a strong key.
        key = (record.source, record.external_id or record.fingerprint)
        buckets.setdefault(key, []).append(record)
    return [
        {
            "type": "duplicate",
            "strength": "strong" if all(item.external_id for item in group) else "weak",
            "records": [asdict(item) for item in group],
        }
        for group in buckets.values()
        if len(group) > 1
    ]


def dedupe_same_source(records: list[Record]) -> list[Record]:
    """Keep one canonical source row before cross-source matching."""
    seen: set[tuple[str, str]] = set()
    unique: list[Record] = []
    for record in records:
        # Without a stable external ID, equal date/amount/merchant values can
        # be legitimate repeated purchases. Keep them all and let the UI ask
        # for confirmation instead of silently collapsing them.
        if not record.external_id:
            unique.append(record)
            continue
        key = (record.source, record.external_id)
        if key in seen:
            continue
        seen.add(key)
        unique.append(record)
    return unique


def date_value(record: Record) -> datetime:
    value = record.occurred_at.replace("/", "-")
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, pattern)
        except ValueError:
            continue
    return datetime.fromisoformat(value)


def cross_source_links(records: list[Record]) -> list[dict]:
    links: list[dict] = []
    for left_index, left in enumerate(records):
        for right in records[left_index + 1 :]:
            if left.source == right.source:
                continue
            if left.direction != right.direction or abs(left.amount - right.amount) > 0.01:
                continue
            if abs((date_value(left) - date_value(right)).total_seconds()) > 24 * 3600:
                continue
            left_merchant = merchant_key(left.merchant)
            right_merchant = merchant_key(right.merchant)
            if not (left_merchant == right_merchant or left_merchant in right_merchant or right_merchant in left_merchant):
                continue
            pair = [left, right]
            anchor = next((item for item in pair if item.source == "bank"), pair[0])
            detail = next((item for item in pair if item.source != "bank"), pair[1])
            links.append(
                {
                    "type": "duplicate",
                    "status": "pending_review",
                    "bank_anchor": asdict(anchor),
                    "detail_source": asdict(detail),
                    "reason": ["same_direction", "same_amount", "same_merchant", "within_24_hours"],
                }
            )
    return links


def run() -> dict:
    parsed = [
        parse_file(FIXTURES / "bank.csv", "bank"),
        parse_file(FIXTURES / "bank_duplicate.csv", "bank"),
        parse_file(FIXTURES / "alipay.csv", "alipay"),
        parse_file(FIXTURES / "wechat.csv", "wechat"),
    ]
    records = [record for item in parsed for record in item["records"]]
    deduped_records = dedupe_same_source(records)
    return {
        "files": [{key: value for key, value in item.items() if key != "records"} for item in parsed],
        "record_count": len(records),
        "deduped_record_count": len(deduped_records),
        "same_source_duplicates": duplicate_groups(records),
        "cross_source_links": cross_source_links(deduped_records),
    }


if __name__ == "__main__":
    json.dump(run(), sys.stdout, ensure_ascii=False, indent=2)
    print()
