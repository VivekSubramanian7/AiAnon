// Port of lib/scanner/envelope.py — zip metadata and masked account contacts.

import { listZip, readZipEntry } from "./zip.js";
import { mask } from "./report.js";
import { KIND_LABELS } from "./sensitivity.js";

const USER_JSON_RE = /(^|\/)user\.json$/i;
const UNREAD_RE = /(^|\/)(ads|summaries|asset_index).*\.json$/i;
const MAX_MEMBER_BYTES = 2_000_000;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_SHAPE = /^\+?[0-9][0-9\s\-().]{6,}$/;

export function nullEnvelope() {
  return {
    userJsonPresent: null,
    userJsonSkipped: null,
    binaryAttachments: null,
    unreadMembers: [],
    findings: [],
  };
}

function contactFindings(email, phone) {
  const out = [];
  if (email && EMAIL_SHAPE.test(email.trim())) {
    out.push({
      harm: "H2",
      kind: "account_email",
      label: KIND_LABELS.account_email,
      confidence: "confirmed",
      subject: "account_holder",
      masked: mask("emails", email.trim()),
      category: null,
      inCodeBlock: false,
      count: 1,
    });
  }
  if (phone && PHONE_SHAPE.test(phone.trim())) {
    out.push({
      harm: "H2",
      kind: "account_phone",
      label: KIND_LABELS.account_phone,
      confidence: "confirmed",
      subject: "account_holder",
      masked: mask("phones", phone.trim()),
      category: null,
      inCodeBlock: false,
      count: 1,
    });
  }
  return out;
}

/**
 * Zip metadata and the masked account contacts in user.json.
 * @param {{ name: string, size: number, read(offset: number, length: number): Promise<Uint8Array> }} source
 *   a random-access source (fileSource / bytesSource from extract.js): only the zip's directory and
 *   user.json are read, never the whole file.
 */
export async function readEnvelope(source) {
  if (!source.name.toLowerCase().endsWith(".zip")) return nullEnvelope();
  try {
    const entries = await listZip(source);
    const names = entries.map((e) => e.name);
    const userPresent = names.some((n) => USER_JSON_RE.test(n));
    const unread = names.filter((n) => UNREAD_RE.test(n)).slice(0, 20);
    const binaries = names.filter((n) => n.toLowerCase().includes(".dat") || n.split("/").pop().startsWith("file-")).length;
    let findings = [];
    if (userPresent) {
      const userMember = names.find((n) => USER_JSON_RE.test(n));
      const entry = entries.find((e) => e.name === userMember);
      try {
        const data = await readZipEntry(source, entry, MAX_MEMBER_BYTES);
        if (data.length <= MAX_MEMBER_BYTES) {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
          const payload = JSON.parse(text);
          let email;
          let phone;
          if (payload && typeof payload === "object") {
            for (const key of ["email", "email_address", "phone_number", "phone"]) {
              const val = payload[key];
              if (typeof val === "string") {
                if (key.includes("email")) email = val;
                else phone = val;
              }
            }
          }
          findings = contactFindings(email, phone);
        }
      } catch {
        // unreadable user.json
      }
    }
    return {
      userJsonPresent: userPresent,
      userJsonSkipped: userPresent,
      binaryAttachments: binaries,
      unreadMembers: unread,
      findings,
    };
  } catch {
    return nullEnvelope();
  }
}