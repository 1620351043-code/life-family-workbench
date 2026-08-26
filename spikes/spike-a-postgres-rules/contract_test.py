"""Static and in-memory contract checks for Spike A.

This is deliberately runnable without PostgreSQL. It does not replace a real
RLS execution test; it verifies that the SQL artifact contains the required
guards and that the application request model never trusts a client scope.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID


ROOT = Path(__file__).resolve().parent
SCHEMA = (ROOT / "schema.sql").read_text(encoding="utf-8")


def require(text: str, label: str) -> None:
    if text not in SCHEMA:
        raise AssertionError(f"missing SQL contract: {label}")


def application_scope(user_households: dict[str, str], user_id: str, client_household_id: str | None) -> str:
    """Derive the only trusted household scope from session membership."""
    actual = user_households.get(user_id)
    if actual is None:
        raise PermissionError("user has no household")
    if client_household_id is not None and client_household_id != actual:
        raise PermissionError("client household does not match session household")
    return actual


def run() -> None:
    require("ALTER TABLE family_topic ENABLE ROW LEVEL SECURITY;", "topic RLS enabled")
    require("ALTER TABLE family_topic FORCE ROW LEVEL SECURITY;", "topic RLS forced")
    require("ALTER TABLE ledger_transaction ENABLE ROW LEVEL SECURITY;", "ledger RLS enabled")
    require("ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;", "entry RLS forced")
    require("current_setting('app.household_id', true)::uuid", "transaction-scoped household setting")
    require("FOREIGN KEY (household_id, ledger_transaction_id)", "same-household composite foreign key")
    require("NOBYPASSRLS", "application role cannot bypass RLS")

    household_a = "00000000-0000-0000-0000-00000000000a"
    household_b = "00000000-0000-0000-0000-00000000000b"
    user_a = "10000000-0000-0000-0000-00000000000a"
    user_b = "10000000-0000-0000-0000-00000000000b"
    user_households = {user_a: household_a, user_b: household_b}

    assert application_scope(user_households, user_a, None) == household_a
    assert application_scope(user_households, user_b, household_b) == household_b

    try:
        application_scope(user_households, user_a, household_b)
    except PermissionError:
        pass
    else:
        raise AssertionError("cross-household client scope was accepted")

    try:
        application_scope(user_a and user_households, "missing-user", household_a)
    except PermissionError:
        pass
    else:
        raise AssertionError("user without household was accepted")

    UUID(household_a)
    UUID(household_b)
    print("Spike A contract: PASS")
    print("  SQL guards: RLS enabled/forced, transaction scope, composite FK, NO BYPASSRLS")
    print("  Application scope: client household cannot override session household")
    print("  PostgreSQL runtime: NOT RUN (docker/psql unavailable in current environment)")


if __name__ == "__main__":
    run()
