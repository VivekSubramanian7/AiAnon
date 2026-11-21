"""Life-domain kind map and domainMatrix rollup (no double-count of unique findings)."""

from lib.scanner.domains import (
    DOMAINS,
    assign_domains,
    build_domain_matrix,
)


def test_kind_map_primary_domains():
    assert assign_domains("iban") == ["financial"]
    assert assign_domains("health") == ["health"]
    assert assign_domains("email") == ["identity"]
    assert assign_domains("org") == ["professional"]
    assert assign_domains("children") == ["relationships"]
    assert assign_domains("place") == ["location"]
    assert assign_domains("aws_access_key") == ["digital"]
    assert assign_domains("date") == ["other"]


def test_compensation_is_financial_and_professional():
    assert assign_domains("compensation") == ["financial", "professional"]


def test_unknown_kind_is_other():
    assert assign_domains("not_a_real_kind") == ["other"]


def test_interests_has_no_kinds():
    assert "interests" in DOMAINS
    mapped = [k for k in (
        "iban", "email", "health", "org", "children", "place",
        "aws_access_key", "date", "compensation", "employer",
    ) if "interests" in assign_domains(k)]
    assert mapped == []


def _finding(kind, harm, id_="f-01"):
    return {
        "id": id_,
        "kind": kind,
        "harm": harm,
        "domains": assign_domains(kind),
        "confidence": "medium",
        "subject": "unknown",
        "masked": "•••",
        "count": 1,
    }


def test_matrix_empty_interests_and_stable_columns():
    matrix = build_domain_matrix([_finding("email", "H4")])
    assert matrix["domains"] == list(DOMAINS)
    assert matrix["uniqueByDomain"]["interests"] == 0
    assert all(v == 0 for v in matrix["cells"]["interests"].values())
    assert matrix["cells"]["identity"]["H4"] == 1
    assert matrix["uniqueByDomain"]["identity"] == 1
    assert matrix["multiDomain"] == 0


def test_compensation_counts_once_globally_twice_in_cells():
    rows = [_finding("compensation", "H5")]
    matrix = build_domain_matrix(rows)
    assert len(rows) == 1
    assert matrix["cells"]["financial"]["H5"] == 1
    assert matrix["cells"]["professional"]["H5"] == 1
    assert matrix["uniqueByDomain"]["financial"] == 1
    assert matrix["uniqueByDomain"]["professional"] == 1
    assert matrix["multiDomain"] == 1
    cell_sum = sum(n for band in matrix["cells"].values() for n in band.values())
    assert cell_sum == 2
    assert cell_sum != len(rows)


def test_kinds_by_cell_lists_pii_types():
    rows = [
        _finding("payment_card", "H2", "f-01"),
        _finding("payment_card", "H2", "f-02"),
        _finding("iban", "H2", "f-03"),
        _finding("compensation", "H5", "f-04"),
    ]
    matrix = build_domain_matrix(rows)
    assert matrix["kindsByCell"]["financial"]["H2"] == {"payment_card": 2, "iban": 1}
    assert matrix["kindsByCell"]["financial"]["H5"] == {"compensation": 1}
    assert matrix["kindsByCell"]["professional"]["H5"] == {"compensation": 1}
    assert matrix["kindsByCell"]["identity"]["H2"] == {}
