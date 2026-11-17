// web/lib/extract.js and web/lib/zip.js against the Python outputs in tests/web/fixtures/extract.json
// (rebuild with: .venv/bin/python scripts/web_fixtures_extract.py).
// Run: node --test tests/web/extract.test.mjs

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  ExtractError, MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, bytesSource, extractFile, extractText, fileSource,
} from "../../web/lib/extract.js";
import { ZipError, crc32, isZip, listZip, readZipEntry } from "../../web/lib/zip.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(readFileSync(`${REPO}tests/web/fixtures/extract.json`, "utf8"));
const encoder = new TextEncoder();

const toBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const readBytes = (path) => toBytes(readFileSync(REPO + path));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** bytesSource that counts how many bytes were read through it. */
function countingSource(name, bytes) {
  const inner = bytesSource(name, bytes);
  const source = {
    name, size: inner.size, bytesRead: 0,
    read: async (offset, length) => {
      const chunk = await inner.read(offset, length);
      source.bytesRead += chunk.length;
      return chunk;
    },
  };
  return source;
}

// ---------- the Python fixture ----------

test("size caps match Python", () => {
  assert.equal(MAX_MEMBER_BYTES, fixture.constants.MAX_MEMBER_BYTES);
  assert.equal(MAX_TOTAL_BYTES, fixture.constants.MAX_TOTAL_BYTES);
});

function summary(out) {
  const sourceCounts = {};
  for (const s of out.segments) sourceCounts[s.source] = (sourceCounts[s.source] ?? 0) + 1;
  const joined = out.segments.map((s) => `${s.source}\x01${s.text}`).join("\x00");
  return {
    format: out.format, conversations: out.conversations, assistantMessagesSkipped: out.assistantMessagesSkipped,
    filesRead: out.filesRead, segmentCount: out.segments.length, sourceCounts,
    segmentsSha256: sha256(joined), firstSegments: out.segments.slice(0, 3),
  };
}

describe("extract matches lib/scanner/extract.py", () => {
  for (const c of fixture.cases) {
    test(c.id, async () => {
      let out, error;
      try {
        if (c.kind === "text") out = extractText(c.text);
        else out = await extractFile(bytesSource(c.name, c.path ? readBytes(c.path) : toBytes(Buffer.from(c.base64, "base64"))));
      } catch (err) {
        error = err;
      }
      const expected = c.expect;
      if (expected.error) {
        assert.ok(error, `Python raised ${expected.error.type}; JavaScript returned ${JSON.stringify(out)?.slice(0, 300)}`);
        if (expected.error.type === "ExtractError") {
          assert.ok(error instanceof ExtractError, `expected ExtractError, got ${error.stack}`);
          assert.equal(error.message, expected.error.message);
        } else {
          // Python crashed (AttributeError, BadZipFile...): the page shows its generic message, so any non-ExtractError.
          assert.ok(!(error instanceof ExtractError), `Python crashed with ${expected.error.pyType}; got "${error.message}"`);
        }
        return;
      }
      if (error) throw error;
      const want = expected.ok;
      if (want.segments) {
        assert.deepEqual(
          { ...out, segments: out.segments.map(({ text, source }) => ({ text, source })) },
          {
            format: want.format, segments: want.segments, conversations: want.conversations,
            assistantMessagesSkipped: want.assistantMessagesSkipped, filesRead: want.filesRead,
          },
        );
      } else {
        assert.deepEqual(summary(out), want);
      }
    });
  }
});

describe("zip listings match Python's zipfile", () => {
  const pick = ({ name, size, compressedSize, method, offset, crc, flags }) =>
    ({ name, size, compressedSize, method, offset, crc, flags });
  for (const listing of fixture.zipListings) {
    test(listing.path, async () => {
      const source = bytesSource(listing.path, readBytes(listing.path));
      assert.equal(await isZip(source), listing.isZip);
      if (!listing.isZip) {
        await assert.rejects(listZip(source), ZipError);
        return;
      }
      if (listing.error) {
        await assert.rejects(listZip(source));
        return;
      }
      const entries = await listZip(source);
      assert.deepEqual(entries.map(pick), listing.entries.map(pick));
      for (const [k, entry] of entries.entries()) {
        const read = listing.entries[k].read;
        const jsCannot = (entry.method !== 0 && entry.method !== 8) || entry.flags & 0x61;
        if (jsCannot) {
          await assert.rejects(readZipEntry(source, entry), (err) => err instanceof ZipError && err.skippable);
        } else if (read.error) {
          await assert.rejects(readZipEntry(source, entry), (err) => err instanceof ZipError && !err.skippable);
        } else {
          const data = await readZipEntry(source, entry);
          assert.equal(data.length, read.length, entry.name);
          assert.equal(sha256(data), read.sha256, entry.name);
        }
      }
    });
  }
});

// ---------- zip reader ----------

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function record(length, fields) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  for (const [at, size, value] of fields) {
    if (size === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
  }
  return bytes;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A small zip writer. member: { name, data, method: 0 | 8, descriptor, declaredSize, body } */
async function makeZip(members) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const m of members) {
    const data = typeof m.data === "string" ? encoder.encode(m.data) : m.data;
    const body = m.body ?? (m.method === 8 ? await deflateRaw(data) : data);
    const name = encoder.encode(m.name);
    const crc = crc32(data);
    const size = m.declaredSize ?? data.length;
    const flags = 0x800 | (m.descriptor ? 0x8 : 0);
    const local = record(30 + name.length, [
      [0, 4, 0x04034b50], [4, 2, 20], [6, 2, flags], [8, 2, m.method],
      [14, 4, m.descriptor ? 0 : crc], [18, 4, m.descriptor ? 0 : body.length], [22, 4, m.descriptor ? 0 : size],
      [26, 2, name.length],
    ]);
    local.set(name, 30);
    const descriptor = m.descriptor ? record(16, [[0, 4, 0x08074b50], [4, 4, crc], [8, 4, body.length], [12, 4, size]]) : null;
    chunks.push(local, body, ...(descriptor ? [descriptor] : []));
    central.push({ name, flags, method: m.method, crc, compressed: body.length, size, offset });
    offset += local.length + body.length + (descriptor?.length ?? 0);
  }
  const start = offset;
  for (const c of central) {
    const entry = record(46 + c.name.length, [
      [0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [8, 2, c.flags], [10, 2, c.method], [16, 4, c.crc],
      [20, 4, c.compressed], [24, 4, c.size], [28, 2, c.name.length], [42, 4, c.offset],
    ]);
    entry.set(c.name, 46);
    chunks.push(entry);
    offset += entry.length;
  }
  chunks.push(record(22, [[0, 4, 0x06054b50], [8, 2, central.length], [10, 2, central.length], [12, 4, offset - start], [16, 4, start]]));
  return concat(chunks);
}

/** Bytes that don't compress (so a stored member really is that big). */
function noise(length) {
  const out = new Uint8Array(length);
  let x = 2463534242;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const decode = (bytes) => new TextDecoder().decode(bytes);

describe("zip reader", () => {
  test("crc32 matches zlib", () => {
    assert.equal(crc32(encoder.encode("hello")), 0x3610a686);
    assert.equal(crc32(new Uint8Array(0)), 0);
    const all = noise(1000);
    assert.equal(crc32(all.subarray(300), crc32(all.subarray(0, 300))), crc32(all));
  });

  test("stored, deflated and data-descriptor members", async () => {
    const long = "deflated text ".repeat(5000);
    const zip = await makeZip([
      { name: "stored.txt", data: "stored text", method: 0 },
      { name: "folder/", data: "", method: 0 },
      { name: "deflated.txt", data: long, method: 8 },
      { name: "descriptor.txt", data: "sizes after the data", method: 8, descriptor: true },
      { name: "empty.txt", data: "", method: 8 },
    ]);
    const source = bytesSource("test.zip", zip);
    assert.equal(await isZip(source), true);
    const entries = await listZip(source);
    assert.deepEqual(entries.map((e) => [e.name, e.method, e.size]), [
      ["stored.txt", 0, 11], ["deflated.txt", 8, long.length], ["descriptor.txt", 8, 20], ["empty.txt", 8, 0],
    ]);
    assert.equal(decode(await readZipEntry(source, entries[0])), "stored text");
    assert.equal(decode(await readZipEntry(source, entries[1])), long);
    assert.equal(decode(await readZipEntry(source, entries[2])), "sizes after the data");
    assert.equal((await readZipEntry(source, entries[3])).length, 0);
  });

  test("reads only the central directory and the members it needs", async () => {
    const zip = await makeZip([
      { name: "photos/big.bin", data: noise(5 * 2 ** 20), method: 0 },
      { name: "conversations.json", data: JSON.stringify([{ chat_messages: [{ sender: "human", text: "Hi, I'm Marcus" }] }]), method: 8 },
      { name: "photos/big2.bin", data: noise(2 ** 20), method: 0 },
    ]);
    const source = countingSource("export.zip", zip);
    const out = await extractFile(source);
    assert.deepEqual(out.segments, [{ text: "Hi, I'm Marcus", source: "message" }]);
    assert.ok(source.bytesRead < 100_000, `read ${source.bytesRead} of ${zip.length} bytes`);
  });

  test("fileSource reads a File slice by slice", async () => {
    const zip = await makeZip([{ name: "notes.txt", data: "- Lives in Leeds\n- Has a cat", method: 8 }]);
    const out = await extractFile(fileSource(new File([zip], "notes.zip")));
    assert.deepEqual(out.segments.map((s) => s.text), ["Lives in Leeds", "Has a cat"]);
    assert.deepEqual(out.filesRead, ["notes.txt"]);
  });

  test("throws past maxBytes while inflating", async () => {
    const zip = await makeZip([{ name: "zeros.json", data: new Uint8Array(2 ** 20), method: 8 }]);
    const source = bytesSource("bomb.zip", zip);
    const [entry] = await listZip(source);
    assert.ok(entry.compressedSize < 5000);
    await assert.rejects(readZipEntry(source, entry, 64 * 1024), (err) => err instanceof ZipError && err.code === "too_big");
    assert.equal((await readZipEntry(source, entry, 2 ** 20)).length, 2 ** 20);
  });

  test("a member that unpacks to more than its declared size is cut there and fails its CRC, like Python", async () => {
    const zip = await makeZip([{ name: "liar.txt", data: new Uint8Array(2 ** 20), method: 8, declaredSize: 1000 }]);
    const source = bytesSource("liar.zip", zip);
    const [entry] = await listZip(source);
    await assert.rejects(readZipEntry(source, entry), (err) => err instanceof ZipError && err.code === "corrupt" && /CRC/.test(err.message));
  });

  test("a member declared over the cap is refused before it's read", async () => {
    const zip = await makeZip([{ name: "conversations.json", data: "[]", method: 0, declaredSize: MAX_MEMBER_BYTES + 1 }]);
    await assert.rejects(extractFile(bytesSource("big.zip", zip)), (err) =>
      err instanceof ExtractError && err.message === "That export is too big to scan in one go (over 600 MB unpacked).");
  });

  test("corrupt deflate data is a ZipError", async () => {
    const zip = await makeZip([{ name: "notes.txt", data: "hello", method: 8, body: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }]);
    const source = bytesSource("bad.zip", zip);
    const [entry] = await listZip(source);
    await assert.rejects(readZipEntry(source, entry), (err) => err instanceof ZipError && err.code === "corrupt");
  });

  test("unsupported compression is skippable", async () => {
    const zip = await makeZip([{ name: "notes.txt", data: "hello", method: 0 }]);
    zip[8] = 99; // local header method
    const view = new DataView(zip.buffer);
    const cd = view.getUint32(zip.length - 22 + 16, true);
    view.setUint16(cd + 10, 99, true);
    const source = bytesSource("aes.zip", zip);
    const [entry] = await listZip(source);
    assert.equal(entry.method, 99);
    await assert.rejects(readZipEntry(source, entry), (err) => err instanceof ZipError && err.skippable);
  });

  test("not a zip", async () => {
    for (const bytes of [encoder.encode("just some text"), new Uint8Array(0), readBytes("samples/mock-memories/edge-cases/photo.png")]) {
      const source = bytesSource("x.zip", bytes);
      assert.equal(await isZip(source), false);
      await assert.rejects(listZip(source), (err) => err instanceof ZipError && err.code === "not_zip");
    }
  });
});
