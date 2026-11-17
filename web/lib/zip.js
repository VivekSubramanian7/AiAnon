/**
 * Zip reader over random access: reads the central directory and the members asked for through
 * source.read(offset, length), never the whole file (ChatGPT exports with images run to several GB).
 *
 * source = { name, size, read(offset, length) -> Promise<Uint8Array> }
 *
 * Mirrors the checks Python's zipfile (3.12) makes, so web/lib/extract.js accepts and rejects the
 * same archives as lib/scanner/extract.py: end-of-central-directory search (archive comments,
 * data prepended to the archive), ZIP64 sizes and offsets, UTF-8 or cp437 names, the Unicode path
 * extra field, overlapping members, a member's output capped at its declared size, CRC-32.
 * Stored (0) and deflate (8) members only; bzip2, lzma, encryption and the like throw a ZipError
 * whose `skippable` is true.
 */

export class ZipError extends Error {
  /** code: "not_zip", "corrupt", "unsupported", "encrypted" or "too_big". */
  constructor(message, code) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }

  /** A member this reader can't decode (encrypted, or compressed with something other than deflate). */
  get skippable() {
    return this.code === "unsupported" || this.code === "encrypted";
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
const END64_SIZE = 56;
const END64_LOCATOR_SIZE = 20;
const MAX_COMMENT = 0xffff;
const MAX_EXTRACT_VERSION = 63;
const U32_MAX = 0xffffffff;
const U64_MAX = 2 ** 64 - 1; // as a double, like a ZIP64 field of all ones read into a Number

const FLAG_ENCRYPTED = 0x1;
const FLAG_COMPRESSED_PATCH = 0x20;
const FLAG_STRONG_ENCRYPTION = 0x40;
const FLAG_UTF8 = 0x800;

const STORED = 0;
const DEFLATED = 8;

const READ_CHUNK = 2 * 2 ** 20; // compressed bytes fed to the inflater per read
const PREALLOCATE_LIMIT = 2 ** 30; // above this, collect output in pieces instead of one buffer

// Bytes 0x80-0xff of code page 437, the zip format's default name encoding (as Python decodes it).
const CP437_HIGH =
  "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5" +
  "\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192" +
  "\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb" +
  "\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510" +
  "\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567" +
  "\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580" +
  "\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229" +
  "\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";

// ---------- small helpers ----------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** Like Python's file.read at an offset: up to `length` bytes, fewer at the end of the file. */
async function readAt(source, offset, length) {
  const available = Math.min(length, source.size - offset);
  if (!(available > 0)) return new Uint8Array(0);
  const bytes = await source.read(offset, available);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function lastIndexOfSignature(bytes, sig) {
  const b0 = sig & 0xff, b1 = (sig >>> 8) & 0xff, b2 = (sig >>> 16) & 0xff, b3 = sig >>> 24;
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) return i;
  }
  return -1;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) {
    try {
      return utf8Strict.decode(bytes);
    } catch {
      throw new ZipError("A file name in the zip isn't valid UTF-8", "corrupt");
    }
  }
  let name = "";
  for (const byte of bytes) name += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return name;
}

/** Python's _sanitize_filename on a POSIX server: cut at the first NUL. */
function sanitize(name) {
  const nul = name.indexOf("\0");
  return nul >= 0 ? name.slice(0, nul) : name;
}

const quote = (name) => `'${name}'`;

// CRC-32 (zip / zlib polynomial), slicing by 8.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = table[n];
    for (let k = 1; k < 8; k++) {
      c = table[c & 0xff] ^ (c >>> 8);
      table[k * 256 + n] = c;
    }
  }
  return table;
})();

/** CRC-32 of `bytes`, continuing from `crc` (the value of the bytes before). */
export function crc32(bytes, crc = 0) {
  const t = CRC_TABLE;
  let c = ~crc;
  let i = 0;
  const n = bytes.length;
  for (; i + 8 <= n; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c =
      t[1792 + (c & 0xff)] ^ t[1536 + ((c >>> 8) & 0xff)] ^ t[1280 + ((c >>> 16) & 0xff)] ^ t[1024 + (c >>> 24)] ^
      t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---------- end of central directory ----------

// isZip then listZip on the same source read the last 64 KB once.
const endRecords = new WeakMap();

function findEndRecord(source) {
  let pending = endRecords.get(source);
  if (!pending) {
    pending = readEndRecord(source);
    endRecords.set(source, pending);
    // Keep answers about the bytes; forget I/O failures so a retry reads again.
    pending.catch((err) => {
      if (!(err instanceof ZipError)) endRecords.delete(source);
    });
  }
  return pending;
}

/** Python's _EndRecData: the end record, or null when this isn't a zip. Throws ZipError when it's broken. */
async function readEndRecord(source) {
  const size = source.size;
  const tailStart = Math.max(size - MAX_COMMENT - END_SIZE, 0);
  const tail = await readAt(source, tailStart, size - tailStart);

  // No archive comment: the record is the last 22 bytes.
  let at = -1;
  if (size >= END_SIZE && tail.length >= END_SIZE) {
    const p = tail.length - END_SIZE;
    if (u32(tail, p) === SIG_END && tail[p + 20] === 0 && tail[p + 21] === 0) at = p;
  }
  if (at < 0) {
    // With a comment: the last signature in the final 64 KB (Python assumes the comment doesn't contain one).
    at = lastIndexOfSignature(tail, SIG_END);
    if (at < 0 || tail.length - at < END_SIZE) return null;
  }
  const record = {
    zip64: false,
    entries: u16(tail, at + 10),
    sizeCd: u32(tail, at + 12),
    offsetCd: u32(tail, at + 16),
    location: tailStart + at,
  };
  return findEndRecord64(source, record);
}

/** Python's _EndRecData64: take sizes and offsets from the ZIP64 records when a locator precedes the end record. */
async function findEndRecord64(source, record) {
  let offset = record.location - END64_LOCATOR_SIZE;
  if (offset < 0) return record;
  const locator = await readAt(source, offset, END64_LOCATOR_SIZE);
  if (locator.length !== END64_LOCATOR_SIZE) throw new ZipError("Unknown I/O error", "corrupt");
  if (u32(locator, 0) !== SIG_END64_LOCATOR) return record;
  const disk = u32(locator, 4), relOffset = u64(locator, 8), disks = u32(locator, 16);
  if (disk !== 0 || disks > 1) throw new ZipError("zipfiles that span multiple disks are not supported", "corrupt");

  offset -= END64_SIZE;
  if (relOffset > offset) throw new ZipError("Corrupt zip64 end of central directory locator", "corrupt");
  // First assume nothing was prepended to the archive, then look right before the locator.
  let extra = offset - relOffset;
  let data = await readAt(source, relOffset, END64_SIZE);
  if (data.length !== END64_SIZE) throw new ZipError("Unknown I/O error", "corrupt");
  if (u32(data, 0) !== SIG_END64 && relOffset !== offset) {
    extra = 0;
    data = await readAt(source, offset, END64_SIZE);
    if (data.length !== END64_SIZE) throw new ZipError("Unknown I/O error", "corrupt");
  }
  if (u32(data, 0) !== SIG_END64) throw new ZipError("Zip64 end of central directory record not found", "corrupt");
  const recordSize = u64(data, 4), dirSize = u64(data, 40), dirOffset = u64(data, 48);
  if (dirOffset + dirSize !== relOffset || recordSize + 12 !== END64_SIZE + extra) {
    throw new ZipError("Corrupt zip64 end of central directory record", "corrupt");
  }
  return { zip64: true, entries: u64(data, 32), sizeCd: dirSize, offsetCd: dirOffset, location: offset - extra };
}

/** zipfile.is_zipfile: true when an end-of-central-directory record is found (and isn't broken). */
export async function isZip(source) {
  try {
    return (await findEndRecord(source)) !== null;
  } catch (err) {
    if (err instanceof ZipError) return false;
    throw err;
  }
}

// ---------- central directory ----------

/**
 * The members of the zip, in central-directory order, directories left out.
 * Each: { name, origName, size, compressedSize, method, offset, crc, flags, endOffset }
 *   name: as Python's ZipInfo.filename (cut at a NUL, or from the Unicode path extra field)
 *   offset: where the member's local header starts; endOffset: where the next member (or the directory) starts.
 */
export async function listZip(source) {
  const end = await findEndRecord(source);
  if (!end) throw new ZipError("File is not a zip file", "not_zip");
  // Non-zero when something (a self-extractor stub) was prepended to the archive.
  const concat = end.location - end.sizeCd - end.offsetCd;
  const startDir = end.offsetCd + concat;
  if (startDir < 0) throw new ZipError("Bad offset for central directory", "corrupt");
  const cd = await readAt(source, startDir, end.sizeCd);

  const entries = [];
  let pos = 0;
  let total = 0;
  while (total < end.sizeCd) {
    if (cd.length - pos < CENTRAL_SIZE) throw new ZipError("Truncated central directory", "corrupt");
    if (u32(cd, pos) !== SIG_CENTRAL) throw new ZipError("Bad magic number for central directory", "corrupt");
    const extractVersion = cd[pos + 6];
    const flags = u16(cd, pos + 8);
    const method = u16(cd, pos + 10);
    const crc = u32(cd, pos + 16);
    let compressedSize = u32(cd, pos + 20);
    let size = u32(cd, pos + 24);
    const nameLength = u16(cd, pos + 28);
    const extraLength = u16(cd, pos + 30);
    const commentLength = u16(cd, pos + 32);
    let offset = u32(cd, pos + 42);
    pos += CENTRAL_SIZE;
    const nameBytes = cd.subarray(pos, pos + nameLength);
    pos = Math.min(pos + nameLength, cd.length);
    const origName = decodeName(nameBytes, flags);
    let name = sanitize(origName);
    let extra = cd.subarray(pos, pos + extraLength);
    pos = Math.min(pos + extraLength, cd.length);
    pos = Math.min(pos + commentLength, cd.length);
    if (extractVersion > MAX_EXTRACT_VERSION) {
      throw new ZipError(`zip file version ${(extractVersion / 10).toFixed(1)}`, "corrupt");
    }

    // Python's ZipInfo._decodeExtra: ZIP64 sizes and offset, Unicode path.
    while (extra.length >= 4) {
      const type = u16(extra, 0), length = u16(extra, 2);
      if (length + 4 > extra.length) {
        throw new ZipError(`Corrupt extra field ${type.toString(16).padStart(4, "0")} (size=${length})`, "corrupt");
      }
      let data = extra.subarray(4, length + 4);
      if (type === 0x0001) {
        const next = (field) => {
          if (data.length < 8) throw new ZipError(`Corrupt zip64 extra field. ${field} not found.`, "corrupt");
          const value = u64(data, 0);
          data = data.subarray(8);
          return value;
        };
        if (size === U32_MAX || size === U64_MAX) size = next("File size");
        if (compressedSize === U32_MAX) compressedSize = next("Compress size");
        if (offset === U32_MAX) offset = next("Header offset");
      } else if (type === 0x7075) {
        if (data.length < 5) throw new ZipError("Corrupt unicode path extra field (0x7075)", "corrupt");
        if (data[0] === 1 && u32(data, 1) === crc32(nameBytes)) {
          let unicodeName;
          try {
            unicodeName = utf8Strict.decode(data.subarray(5));
          } catch {
            throw new ZipError("Corrupt unicode path extra field (0x7075): invalid utf-8 bytes", "corrupt");
          }
          if (unicodeName) name = sanitize(unicodeName);
        }
      }
      extra = extra.subarray(length + 4);
    }

    entries.push({ name, origName, size, compressedSize, method, offset: offset + concat, crc, flags, endOffset: null });
    total += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }

  // Each member must end before the next local header (or the directory): Python's zip-bomb check.
  const byOffset = entries.map((_, i) => i).sort((a, b) => entries[a].offset - entries[b].offset || a - b);
  let endOffset = startDir;
  for (let k = byOffset.length - 1; k >= 0; k--) {
    const entry = entries[byOffset[k]];
    entry.endOffset = endOffset;
    endOffset = entry.offset;
  }
  return entries.filter((entry) => !entry.name.endsWith("/"));
}

// ---------- members ----------

/**
 * The bytes of one member, as Python's ZipFile.read gives them: never more than the declared size,
 * and a ZipError when the CRC doesn't match. Throws ZipError("too_big") as soon as the output passes
 * maxBytes, so a member that lies about its size can't fill the memory.
 */
export async function readZipEntry(source, entry, maxBytes = Infinity) {
  const origName = entry.origName ?? entry.name;
  const header = await readAt(source, entry.offset, LOCAL_SIZE);
  if (header.length !== LOCAL_SIZE) throw new ZipError("Truncated file header", "corrupt");
  if (u32(header, 0) !== SIG_LOCAL) throw new ZipError("Bad magic number for file header", "corrupt");
  const localFlags = u16(header, 6);
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  const localName = await readAt(source, entry.offset + LOCAL_SIZE, nameLength);
  const flags = entry.flags ?? 0;

  if (flags & FLAG_COMPRESSED_PATCH) throw new ZipError("compressed patched data (flag bit 5)", "unsupported");
  if (flags & FLAG_STRONG_ENCRYPTION) throw new ZipError("strong encryption (flag bit 6)", "encrypted");
  if (decodeName(localName, localFlags) !== origName) {
    throw new ZipError(`File name in directory ${quote(origName)} and header differ.`, "corrupt");
  }
  const dataStart = entry.offset + LOCAL_SIZE + nameLength + extraLength;
  if (entry.endOffset != null && dataStart + entry.compressedSize > entry.endOffset && entry.endOffset !== entry.offset) {
    throw new ZipError(`Overlapped entries: ${quote(origName)} (possible zip bomb)`, "corrupt");
  }
  if (flags & FLAG_ENCRYPTED) {
    throw new ZipError(`File ${quote(entry.name)} is encrypted, password required for extraction`, "encrypted");
  }
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new ZipError(`Compression method ${entry.method} is not supported`, "unsupported");
  }

  const data =
    entry.method === STORED
      ? await readStored(source, entry, dataStart, maxBytes)
      : await inflate(source, entry, dataStart, maxBytes);
  if (crc32(data) !== entry.crc) throw new ZipError(`Bad CRC-32 for file ${quote(entry.name)}`, "corrupt");
  return data;
}

function tooBig(entry, maxBytes) {
  return new ZipError(`${entry.name} unpacks to more than ${maxBytes} bytes`, "too_big");
}

async function readStored(source, entry, dataStart, maxBytes) {
  const length = Math.min(entry.compressedSize, entry.size);
  if (length > maxBytes) throw tooBig(entry, maxBytes);
  const data = await readAt(source, dataStart, length);
  if (data.length < length) throw new ZipError(`Truncated data for file ${quote(entry.name)}`, "corrupt");
  return data;
}

async function inflate(source, entry, dataStart, maxBytes) {
  const limit = entry.size; // Python stops at the declared size
  if (limit === 0) return new Uint8Array(0);
  const buffer = limit <= maxBytes && limit <= PREALLOCATE_LIMIT ? new Uint8Array(limit) : null;
  const pieces = [];
  let produced = 0;

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let finished = false;
  let readError = null;

  // Feed compressed bytes while the loop below drains the output (backpressure runs both ways).
  const feeding = (async () => {
    for (let pos = 0; pos < entry.compressedSize && !finished; ) {
      let chunk;
      try {
        chunk = await readAt(source, dataStart + pos, Math.min(READ_CHUNK, entry.compressedSize - pos));
        if (!chunk.length) throw new ZipError(`Truncated data for file ${quote(entry.name)}`, "corrupt");
      } catch (err) {
        readError = err;
        writer.abort(err).catch(() => {});
        return;
      }
      pos += chunk.length;
      try {
        await writer.write(chunk);
      } catch {
        return; // the stream failed or was cancelled; the reading side reports it
      }
    }
    if (!finished) await writer.close().catch(() => {});
  })();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = value;
      if (produced + chunk.length > limit) chunk = chunk.subarray(0, limit - produced);
      if (produced + chunk.length > maxBytes) throw tooBig(entry, maxBytes);
      if (buffer) buffer.set(chunk, produced);
      else pieces.push(chunk.slice());
      produced += chunk.length;
      if (produced >= limit) break;
    }
  } catch (err) {
    finished = true;
    reader.cancel().catch(() => {});
    if (readError) throw readError;
    if (err instanceof ZipError) throw err;
    throw new ZipError(`Bad compressed data for file ${quote(entry.name)}: ${err.message}`, "corrupt");
  }
  finished = true;
  reader.cancel().catch(() => {}); // stops the feeder when we stopped at the declared size
  await feeding;
  if (readError) throw readError;

  if (buffer) return produced === buffer.length ? buffer : buffer.slice(0, produced);
  const out = new Uint8Array(produced);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
