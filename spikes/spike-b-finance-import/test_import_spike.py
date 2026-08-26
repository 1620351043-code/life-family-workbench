from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from import_spike import run  # noqa: E402


def test() -> None:
    result = run()
    files = {item["file"]: item for item in result["files"]}
    assert files["bank.csv"]["header_row"] == 4
    assert files["alipay.csv"]["header_row"] == 4
    assert files["wechat.csv"]["header_row"] == 4
    assert result["record_count"] == 8
    assert result["deduped_record_count"] == 7
    assert len(result["same_source_duplicates"]) == 1
    assert result["same_source_duplicates"][0]["strength"] == "strong"
    assert len(result["cross_source_links"]) == 2
    assert all(link["bank_anchor"]["source"] == "bank" for link in result["cross_source_links"])
    assert {link["detail_source"]["source"] for link in result["cross_source_links"]} == {"alipay", "wechat"}
    print("Spike B import contract: PASS")
    print("  Header detection: 4th row for bank/Alipay/WeChat fixtures")
    print("  Same-source idempotency: 1 duplicate group")
    print("  Cross-source linkage: 2 pending-review links with bank anchor")
    print("  Detail retention: Alipay/WeChat records preserved as detail sources")


if __name__ == "__main__":
    test()
