import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMAINS, assignDomains, buildDomainMatrix } from "../../web/lib/domains.js";

test("kind map primary domains", () => {
  assert.deepEqual(assignDomains("iban"), ["financial"]);
  assert.deepEqual(assignDomains("health"), ["health"]);
  assert.deepEqual(assignDomains("email"), ["identity"]);
  assert.deepEqual(assignDomains("org"), ["professional"]);
  assert.deepEqual(assignDomains("children"), ["relationships"]);
  assert.deepEqual(assignDomains("place"), ["location"]);
  assert.deepEqual(assignDomains("aws_access_key"), ["digital"]);
  assert.deepEqual(assignDomains("date"), ["other"]);
});

test("compensation is financial and professional", () => {
  assert.deepEqual(assignDomains("compensation"), ["financial", "professional"]);
});

test("unknown kind is other", () => {
  assert.deepEqual(assignDomains("not_a_real_kind"), ["other"]);
});

test("interests has no kinds in v1", () => {
  assert.ok(DOMAINS.includes("interests"));
  const kinds = [
    "iban", "email", "health", "org", "children", "place",
    "aws_access_key", "date", "compensation", "employer",
  ];
  assert.deepEqual(kinds.filter((k) => assignDomains(k).includes("interests")), []);
});

function finding(kind, harm, id = "f-01") {
  return {
    id, kind, harm, domains: assignDomains(kind),
    confidence: "medium", subject: "unknown", masked: "•••", count: 1,
  };
}

test("matrix empty interests and stable columns", () => {
  const matrix = buildDomainMatrix([finding("email", "H4")]);
  assert.deepEqual(matrix.domains, [...DOMAINS]);
  assert.equal(matrix.uniqueByDomain.interests, 0);
  assert.ok(Object.values(matrix.cells.interests).every((n) => n === 0));
  assert.equal(matrix.cells.identity.H4, 1);
  assert.equal(matrix.uniqueByDomain.identity, 1);
  assert.equal(matrix.multiDomain, 0);
});

test("compensation counts once globally twice in cells", () => {
  const rows = [finding("compensation", "H5")];
  const matrix = buildDomainMatrix(rows);
  assert.equal(rows.length, 1);
  assert.equal(matrix.cells.financial.H5, 1);
  assert.equal(matrix.cells.professional.H5, 1);
  assert.equal(matrix.uniqueByDomain.financial, 1);
  assert.equal(matrix.uniqueByDomain.professional, 1);
  assert.equal(matrix.multiDomain, 1);
  const cellSum = Object.values(matrix.cells).reduce(
    (n, band) => n + Object.values(band).reduce((a, b) => a + b, 0), 0,
  );
  assert.equal(cellSum, 2);
  assert.notEqual(cellSum, rows.length);
});

test("kindsByCell lists PII types in a cell", () => {
  const matrix = buildDomainMatrix([
    finding("payment_card", "H2", "f-01"),
    finding("payment_card", "H2", "f-02"),
    finding("iban", "H2", "f-03"),
    finding("compensation", "H5", "f-04"),
  ]);
  assert.deepEqual(matrix.kindsByCell.financial.H2, { payment_card: 2, iban: 1 });
  assert.deepEqual(matrix.kindsByCell.financial.H5, { compensation: 1 });
  assert.deepEqual(matrix.kindsByCell.professional.H5, { compensation: 1 });
  assert.deepEqual(matrix.kindsByCell.identity.H2, {});
});
