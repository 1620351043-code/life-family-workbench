"""Deterministic finance overview and drilldown spike.

The key property is that every visual element carries a stable drilldown
reference. The mobile UI never rebuilds financial filters from labels, colors,
or displayed amounts.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path


@dataclass(frozen=True)
class Transaction:
    id: str
    occurred_on: date
    direction: str
    category: str | None
    amount: Decimal
    account_id: str


@dataclass(frozen=True)
class AssetEvent:
    id: str
    asset_id: str
    occurred_on: date
    event_type: str
    amount: Decimal
    recovery_amount: Decimal = Decimal("0")
    ledger_transaction_id: str | None = None


def money(value: Decimal) -> str:
    return f"{value:.2f}"


def ref(kind: str, **filters: str) -> dict:
    return {"type": kind, "filter_id": "fd_" + "_".join(f"{key}_{value}" for key, value in filters.items()), "filters": filters}


def sample_data() -> tuple[list[Transaction], list[dict], list[AssetEvent]]:
    transactions = [
        Transaction("tx-income-1", date(2026, 8, 1), "income", "salary", Decimal("10000"), "account-main"),
        Transaction("tx-food-1", date(2026, 8, 1), "expense", "food", Decimal("68"), "account-main"),
        Transaction("tx-food-2", date(2026, 8, 3), "expense", "food", Decimal("120"), "account-main"),
        Transaction("tx-home-1", date(2026, 8, 4), "expense", "home", Decimal("188"), "account-main"),
        Transaction("tx-income-2", date(2026, 8, 5), "income", "transfer_in", Decimal("200"), "account-main"),
        Transaction("tx-transfer", date(2026, 8, 5), "transfer", None, Decimal("500"), "account-main"),
    ]
    budgets = [
        {"category": "food", "label": "餐饮", "limit": Decimal("300"), "color_token": "category.food"},
        {"category": "home", "label": "家庭用品", "limit": Decimal("500"), "color_token": "category.home"},
    ]
    asset_events = [
        AssetEvent("asset-purchase-1", "asset-bike", date(2026, 8, 1), "purchase", Decimal("3000"), ledger_transaction_id="tx-asset-purchase"),
        AssetEvent("asset-maintenance-1", "asset-bike", date(2026, 8, 3), "maintenance", Decimal("200"), ledger_transaction_id="tx-asset-maintenance"),
        AssetEvent("asset-recovery-1", "asset-bike", date(2026, 8, 5), "sale", Decimal("0"), recovery_amount=Decimal("500"), ledger_transaction_id="tx-asset-sale"),
    ]
    return transactions, budgets, asset_events


def period_transactions(transactions: list[Transaction], start: date, end: date) -> list[Transaction]:
    return [item for item in transactions if start <= item.occurred_on <= end]


def build_overview(transactions: list[Transaction], budgets: list[dict], assets: list[AssetEvent], start: date, end: date) -> dict:
    period = period_transactions(transactions, start, end)
    income = sum((item.amount for item in period if item.direction == "income"), Decimal("0"))
    expense = sum((item.amount for item in period if item.direction == "expense"), Decimal("0"))
    budget_rings = []
    for budget in budgets:
        used = sum(
            (item.amount for item in period if item.direction == "expense" and item.category == budget["category"]),
            Decimal("0"),
        )
        budget_rings.append(
            {
                "category": budget["category"],
                "label": budget["label"],
                "limit": money(budget["limit"]),
                "used": money(used),
                "progress": float(used / budget["limit"]) if budget["limit"] else 0,
                "color_token": budget["color_token"],
                "drilldown_ref": ref("budget_category", category=budget["category"], start=start.isoformat(), end=end.isoformat()),
            }
        )

    trend = []
    cursor = start
    while cursor <= end:
        day_items = [item for item in period if item.occurred_on == cursor]
        day_income = sum((item.amount for item in day_items if item.direction == "income"), Decimal("0"))
        day_expense = sum((item.amount for item in day_items if item.direction == "expense"), Decimal("0"))
        trend.append(
            {
                "date": cursor.isoformat(),
                "income": money(day_income),
                "expense": money(day_expense),
                "net_cash_flow": money(day_income - day_expense),
                "drilldown_ref": ref("ledger_period", start=cursor.isoformat(), end=cursor.isoformat()),
            }
        )
        cursor += timedelta(days=1)

    asset_period = [item for item in assets if start <= item.occurred_on <= end]
    asset_trend = []
    purchase = Decimal("0")
    maintenance = Decimal("0")
    recovery = Decimal("0")
    for event_day in sorted({item.occurred_on for item in asset_period}):
        day_events = [item for item in asset_period if item.occurred_on == event_day]
        purchase += sum((item.amount for item in day_events if item.event_type == "purchase"), Decimal("0"))
        maintenance += sum((item.amount for item in day_events if item.event_type == "maintenance"), Decimal("0"))
        recovery += sum((item.recovery_amount for item in day_events), Decimal("0"))
        asset_trend.append(
            {
                "date": event_day.isoformat(),
                "purchase_cost": money(purchase),
                "maintenance_cost": money(maintenance),
                "gross_cost": money(purchase + maintenance),
                "recovery": money(recovery),
                "net_cash_cost": money(purchase + maintenance - recovery),
                "drilldown_ref": ref("asset_day", start=event_day.isoformat(), end=event_day.isoformat()),
            }
        )

    return {
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "summary_cards": [
            {"key": "income", "value": money(income), "drilldown_ref": ref("ledger_direction", direction="income", start=start.isoformat(), end=end.isoformat())},
            {"key": "expense", "value": money(expense), "drilldown_ref": ref("ledger_direction", direction="expense", start=start.isoformat(), end=end.isoformat())},
            {"key": "net_cash_flow", "value": money(income - expense), "drilldown_ref": ref("ledger_period", start=start.isoformat(), end=end.isoformat())},
        ],
        "budget_center": {
            "label": "预算总览",
            "drilldown_ref": ref("ledger_period", start=start.isoformat(), end=end.isoformat()),
        },
        "budget_rings": budget_rings,
        "trend_container": {"drilldown_ref": ref("ledger_period", start=start.isoformat(), end=end.isoformat())},
        "trend_points": trend,
        "asset_cost_container": {"drilldown_ref": ref("asset_period", start=start.isoformat(), end=end.isoformat())},
        "asset_cost_points": asset_trend,
    }


def drilldown(overview: dict, transactions: list[Transaction], assets: list[AssetEvent], drilldown_ref: dict) -> dict:
    filters = drilldown_ref["filters"]
    kind = drilldown_ref["type"]
    start = date.fromisoformat(filters["start"])
    end = date.fromisoformat(filters["end"])
    if kind == "ledger_direction":
        result = [item for item in period_transactions(transactions, start, end) if item.direction == filters["direction"]]
        return {"kind": kind, "transactions": [asdict(item) for item in result]}
    if kind in {"ledger_period", "budget_category"}:
        result = period_transactions(transactions, start, end)
        if kind == "budget_category":
            result = [item for item in result if item.direction == "expense" and item.category == filters["category"]]
        return {"kind": kind, "transactions": [asdict(item) for item in result]}
    if kind in {"asset_day", "asset_period"}:
        result = [item for item in assets if start <= item.occurred_on <= end]
        return {"kind": kind, "asset_events": [asdict(item) for item in result]}
    raise ValueError(f"unsupported drilldown type: {kind}")


def assert_refs(node: object) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"budget_rings", "trend_points", "asset_cost_points", "summary_cards"}:
                for entry in value:
                    assert "drilldown_ref" in entry, f"missing drilldown_ref in {key}"
            elif key.endswith("_container") or key == "budget_center":
                assert "drilldown_ref" in value, f"missing drilldown_ref in {key}"
            assert_refs(value)
    elif isinstance(node, list):
        for item in node:
            assert_refs(item)


def run() -> dict:
    transactions, budgets, assets = sample_data()
    overview = build_overview(transactions, budgets, assets, date(2026, 8, 1), date(2026, 8, 5))
    assert_refs(overview)
    return overview


if __name__ == "__main__":
    json.dump(run(), sys.stdout, ensure_ascii=False, indent=2, default=str)
    print()

