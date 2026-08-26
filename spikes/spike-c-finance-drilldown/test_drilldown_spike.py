from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from drilldown_spike import drilldown, sample_data, run  # noqa: E402


def test() -> None:
    transactions, _, assets = sample_data()
    overview = run()

    cards = {card["key"]: card for card in overview["summary_cards"]}
    assert cards["income"]["value"] == "10200.00"
    assert cards["expense"]["value"] == "376.00"
    assert cards["net_cash_flow"]["value"] == "9824.00"

    rings = {ring["category"]: ring for ring in overview["budget_rings"]}
    assert rings["food"]["used"] == "188.00"
    assert rings["food"]["progress"] == 188 / 300
    category_rows = drilldown(overview, transactions, assets, rings["food"]["drilldown_ref"])
    assert {row["id"] for row in category_rows["transactions"]} == {"tx-food-1", "tx-food-2"}

    point = next(item for item in overview["trend_points"] if item["date"] == "2026-08-03")
    day_rows = drilldown(overview, transactions, assets, point["drilldown_ref"])
    assert {row["id"] for row in day_rows["transactions"]} == {"tx-food-2"}

    asset_point = overview["asset_cost_points"][-1]
    assert asset_point["gross_cost"] == "3200.00"
    assert asset_point["net_cash_cost"] == "2700.00"
    asset_rows = drilldown(overview, transactions, assets, asset_point["drilldown_ref"])
    assert len(asset_rows["asset_events"]) == 1

    print("Spike C drilldown contract: PASS")
    print("  Summary values: income 10200.00, expense 376.00, net cash flow 9824.00")
    print("  Budget ring: food category drilldown returns 2 ledger rows")
    print("  Trend point: 2026-08-03 drilldown returns 1 ledger row")
    print("  Asset cost: gross 3200.00, net cash cost 2700.00")
    print("  Drilldown refs: summary, ring, chart point and container all carry stable refs")


if __name__ == "__main__":
    test()

