// Port of lib/scanner/domains.py — kind map and domainMatrix rollup.

export const DOMAINS = [
  "financial",
  "identity",
  "health",
  "professional",
  "relationships",
  "location",
  "digital",
  "interests",
  "other",
];

export const DOMAIN_LABELS = {
  financial: "Financial",
  identity: "Identity",
  health: "Health",
  professional: "Professional",
  relationships: "Relationships",
  location: "Location",
  digital: "Digital",
  interests: "Interests",
  other: "Other",
};

const HARM_ORDER = ["H1", "H2", "H3", "H4", "H5", "H6"];

const KIND_DOMAINS = {
  payment_card: ["financial"],
  iban: ["financial"],
  compensation: ["financial", "professional"],
  national_id: ["identity"],
  date_of_birth: ["identity"],
  email: ["identity"],
  phone: ["identity"],
  handle: ["identity"],
  profile_url: ["identity"],
  os_username: ["identity"],
  name: ["identity"],
  self_name: ["identity"],
  account_email: ["identity"],
  account_phone: ["identity"],
  religion: ["identity"],
  sexual_orientation: ["identity"],
  immigration: ["identity"],
  age: ["identity"],
  health: ["health"],
  employer: ["professional"],
  org: ["professional"],
  children: ["relationships"],
  child_name: ["relationships"],
  street_address: ["location"],
  gps: ["location"],
  place: ["location"],
  aws_access_key: ["digital"],
  private_key: ["digital"],
  api_token: ["digital"],
  jwt: ["digital"],
  password_cue: ["digital"],
  tokenized_url: ["digital"],
  url: ["digital"],
  date: ["other"],
};

export function assignDomains(kind) {
  return [...(KIND_DOMAINS[kind] ?? ["other"])];
}

function emptyCells() {
  return Object.fromEntries(DOMAINS.map((d) => [d, Object.fromEntries(HARM_ORDER.map((h) => [h, 0]))]));
}

function emptyKinds() {
  return Object.fromEntries(DOMAINS.map((d) => [d, Object.fromEntries(HARM_ORDER.map((h) => [h, {}]))]));
}

export function kindsForCell(matrix, domain, harm) {
  const counts = matrix?.kindsByCell?.[domain]?.[harm] || {};
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function buildDomainMatrix(findings) {
  const cells = emptyCells();
  const kindsByCell = emptyKinds();
  const uniqueByDomain = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  let multiDomain = 0;
  for (const row of findings) {
    const domains = row.domains?.length ? row.domains : assignDomains(row.kind ?? "");
    if (domains.length > 1) multiDomain += 1;
    let harm = row.harm || "H6";
    if (!HARM_ORDER.includes(harm)) harm = "H6";
    const kind = row.kind || "other";
    const seen = new Set();
    for (let domain of domains) {
      if (!cells[domain]) domain = "other";
      cells[domain][harm] += 1;
      kindsByCell[domain][harm][kind] = (kindsByCell[domain][harm][kind] || 0) + 1;
      if (!seen.has(domain)) {
        uniqueByDomain[domain] += 1;
        seen.add(domain);
      }
    }
  }
  return { domains: [...DOMAINS], cells, kindsByCell, uniqueByDomain, multiDomain };
}
