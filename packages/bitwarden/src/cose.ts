/**
 * Local structural parsing of Bitwarden's signed account objects (COSE_Sign1, RFC 9052).
 *
 * The pinned SDK parses `security_state` and `signed_public_key` inside its asynchronous
 * `initialize_user_crypto` export. A parse failure there throws outside the returned Promise, which
 * then never settles. The SDK no longer exports a synchronous parser, so this module rejects any
 * input that its COSE parser (coset 0.4.2 over ciborium 0.2.2) would refuse before the SDK sees it.
 * It accepts a strict subset of that parser: definite lengths only, no tags, no counter signatures,
 * IVs or critical headers, and only the signature algorithms Bitwarden signs with.
 *
 * Parsing grants no trust. Signatures are verified only by the SDK during initialization.
 */

type CborItem =
  | { kind: "int"; value: bigint }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "text"; value: string }
  | { kind: "array"; items: CborItem[] }
  | { kind: "map"; entries: [CborItem, CborItem][] }
  /** CBOR major type 7, keyed by its additional information (22 is null). */
  | { kind: "simple"; info: number };

const MAX_DEPTH = 16;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class CborReader {
  offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private take(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) throw new Error();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private argument(info: number): bigint {
    if (info < 24) return BigInt(info);
    // 28-30 are reserved; 31 (indefinite length or break) is outside the accepted subset.
    if (info > 27) throw new Error();
    const width = 1 << (info - 24);
    let value = 0n;
    for (const byte of this.take(width)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  private length(info: number): number {
    const value = this.argument(info);
    if (value > BigInt(this.bytes.length - this.offset)) throw new Error();
    return Number(value);
  }

  item(depth = 0): CborItem {
    if (depth > MAX_DEPTH) throw new Error();
    const [initial] = this.take(1);
    const major = initial! >> 5;
    const info = initial! & 0x1f;
    switch (major) {
      case 0:
        return { kind: "int", value: this.argument(info) };
      case 1:
        return { kind: "int", value: -1n - this.argument(info) };
      case 2:
        return { kind: "bytes", value: this.take(this.length(info)) };
      case 3:
        return { kind: "text", value: utf8.decode(this.take(this.length(info))) };
      case 4: {
        const count = this.length(info);
        const items: CborItem[] = [];
        for (let index = 0; index < count; index += 1) items.push(this.item(depth + 1));
        return { kind: "array", items };
      }
      case 5: {
        const count = this.length(info);
        const entries: [CborItem, CborItem][] = [];
        for (let index = 0; index < count; index += 1)
          entries.push([this.item(depth + 1), this.item(depth + 1)]);
        return { kind: "map", entries };
      }
      case 6:
        // The SDK signer never emits tags, and ciborium reinterprets bignum tags 2 and 3.
        throw new Error();
      default:
        // false, true, null, undefined and half/single/double floats; other simple values are
        // outside the accepted subset.
        if (info >= 20 && info <= 23) return { kind: "simple", info };
        if (info >= 25 && info <= 27) {
          this.argument(info);
          return { kind: "simple", info };
        }
        throw new Error();
    }
  }
}

/** Decodes exactly one definite-length CBOR item; trailing bytes are rejected. */
function decodeCbor(bytes: Uint8Array): CborItem {
  const reader = new CborReader(bytes);
  const item = reader.item();
  if (reader.offset !== bytes.length) throw new Error();
  return item;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
// iana::Algorithm values Bitwarden signs with: EdDSA (Ed25519) and ML-DSA-44.
const SIGNATURE_ALGORITHMS = new Set([-8n, -48n]);
// iana::CoapContentFormat::Cbor, the only content format SDK-signed messages use.
const CBOR_CONTENT_FORMAT = 60n;

function labelKey(label: CborItem): string {
  if (label.kind === "int" && label.value >= I64_MIN && label.value <= I64_MAX)
    return `i${label.value}`;
  if (label.kind === "text") return `t${label.value}`;
  throw new Error();
}

function nonEmptyBytes(item: CborItem): void {
  if (item.kind !== "bytes" || item.value.length === 0) throw new Error();
}

function header(item: CborItem): void {
  if (item.kind !== "map") throw new Error();
  const seen = new Set<string>();
  for (const [label, value] of item.entries) {
    const key = labelKey(label);
    if (seen.has(key)) throw new Error();
    seen.add(key);
    switch (key) {
      case "i1":
        if (value.kind !== "int" || !SIGNATURE_ALGORITHMS.has(value.value)) throw new Error();
        break;
      case "i3":
        if (value.kind !== "int" || value.value !== CBOR_CONTENT_FORMAT) throw new Error();
        break;
      case "i4":
        nonEmptyBytes(value);
        break;
      // crit, IV, partial IV and counter signatures are never set by the SDK signer.
      case "i2":
      case "i5":
      case "i6":
      case "i7":
        throw new Error();
      default:
    }
  }
}

/** The untagged COSE_Sign1 array, as `CoseSign1::from_slice` reads it. */
function coseSign1(bytes: Uint8Array): { payload: Uint8Array | null } {
  const value = decodeCbor(bytes);
  if (value.kind !== "array" || value.items.length !== 4) throw new Error();
  const [protectedHeader, unprotectedHeader, payload, signature] = value.items as [
    CborItem,
    CborItem,
    CborItem,
    CborItem,
  ];
  if (protectedHeader.kind !== "bytes") throw new Error();
  if (protectedHeader.value.length > 0) header(decodeCbor(protectedHeader.value));
  header(unprotectedHeader);
  const absent = payload.kind === "simple" && payload.info === 22;
  if ((payload.kind !== "bytes" && !absent) || signature.kind !== "bytes") throw new Error();
  return { payload: payload.kind === "bytes" ? payload.value : null };
}

/** True when the SDK's COSE_Sign1 parser accepts these bytes. Grants no trust. */
export function isCoseSign1(bytes: Uint8Array): boolean {
  try {
    coseSign1(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `SecurityState.version` from a signed security state the SDK has ALREADY verified during
 * initialization. The payload is the SDK's CBOR map, e.g. `{"version": 2}`; other fields are ignored.
 * Anything else returns undefined, so callers fail closed.
 */
export function verifiedSecurityStateVersion(bytes: Uint8Array): number | undefined {
  try {
    const { payload } = coseSign1(bytes);
    if (!payload) return undefined;
    const state = decodeCbor(payload);
    if (state.kind !== "map") return undefined;
    const versions = state.entries.filter(
      ([key]) => key.kind === "text" && key.value === "version",
    );
    if (versions.length !== 1) return undefined;
    const [, version] = versions[0]!;
    if (version.kind !== "int" || version.value < 0n || version.value > 2n ** 32n) return undefined;
    return Number(version.value);
  } catch {
    return undefined;
  }
}
