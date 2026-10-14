import { ApiError } from './api-error.js';

/**
 * Shared checks for every file a signed-in user uploads (lender onboarding evidence, KFS files).
 * Files are opened later by lender and Udofin staff and, for KFS, by the borrower, so one rule set
 * applies everywhere: the bytes must really be the declared type, and a PDF must not name active
 * content. This is a coarse filter, NOT a malware scanner (see `docs/audits/phase-01-*` R-06). It is
 * one layer; the second approver still reads every file before it is relied on.
 */

/** The file types that may be uploaded. */
export const UPLOAD_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

/**
 * PDF names (the token after a `/`) that run code, launch programs, reach outside the document or
 * carry a payload. Matching is exact and case-sensitive, because PDF names are: `/JavaScriptish` and
 * `/javascript` are different names that no reader treats as the action, so they are not refused.
 *
 * The list is deliberately short and each entry is something a lender evidence file or a KFS has no
 * reason to contain. Ordinary hyperlinks (`/URI`), in-document jumps (`/GoTo`) and named actions are
 * allowed. It is not exhaustive.
 */
export const ACTIVE_PDF_NAMES: ReadonlySet<string> = new Set([
  // Scripts.
  'JavaScript', // action type `/S /JavaScript`, and the catalog's JavaScript name tree
  'JS', // the key that holds the script text of a JavaScript action or field
  // Things that run without a click.
  'OpenAction', // catalog entry: an action performed when the document is opened
  'AA', // additional-actions dictionary: page open/close, mouse and form-field events
  // Reaching outside the document.
  'Launch', // starts an external application or opens a file
  'SubmitForm', // sends form data to a URL
  'ImportData', // reads form data from a file
  'GoToR', // jump into another file, local or remote (a known route to leak credentials via UNC paths)
  'GoToE', // jump into an embedded file
  // Payloads carried inside the file.
  'EmbeddedFile', // stream type of an attached file (the key is optional, so this is not complete)
  'EmbeddedFiles', // catalog name tree of attachments
  'FileAttachment', // annotation that attaches a file
  // Active media and form engines.
  'RichMedia', // Flash, video and 3D annotation container
  'Rendition', // media playback action
  'Movie', // legacy movie annotation / action
  'Sound', // legacy sound annotation / action
  'XFA', // XML Forms Architecture: dynamic forms with their own script engine
]);

const LISTED_NAMES: readonly Buffer[] = [...ACTIVE_PDF_NAMES].map((name) =>
  Buffer.from(name, 'latin1'),
);
/** Longest raw name worth decoding: the longest listed name with every character written as `#xx`. */
const MAX_RAW_NAME_BYTES = 3 * Math.max(...LISTED_NAMES.map((name) => name.length));

const SLASH = 0x2f;
const HASH = 0x23;

/**
 * Bytes that end a PDF name (ISO 32000-1 section 7.2): white-space characters NUL, TAB, LF, FF, CR,
 * SPACE, and the delimiters ( ) < > [ ] { } / %.
 */
const NAME_TERMINATOR = new Uint8Array(256);
for (const byte of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) NAME_TERMINATOR[byte] = 1;
for (const char of '()<>[]{}/%') NAME_TERMINATOR[char.charCodeAt(0)] = 1;
const endsName = (byte: number | undefined): boolean =>
  byte === undefined || NAME_TERMINATOR[byte] === 1;

/** Value of a hexadecimal digit, or -1. */
function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // A-F
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // a-f
  return -1;
}

/** Scratch space for one decoded name. Only used synchronously inside {@link isListedName}. */
const decoded = new Uint8Array(MAX_RAW_NAME_BYTES);

/**
 * Is the name `bytes[start, end)` one of the listed names once `#xx` escapes are decoded? In a PDF
 * name `#xx` stands for the byte xx, so `/J#61vaScript` is the name `/JavaScript`. One pass only, as
 * a reader does: `#2361` is the characters `#61`, not `a`. Allocation-free, because an attacker
 * controls how many names a file contains.
 */
function isListedName(bytes: Uint8Array, start: number, end: number): boolean {
  let length = 0;
  for (let i = start; i < end; i++) {
    let value = bytes[i] ?? 0;
    if (value === HASH && i + 2 < end) {
      const high = hexValue(bytes[i + 1]);
      const low = hexValue(bytes[i + 2]);
      if (high >= 0 && low >= 0) {
        value = high * 16 + low;
        i += 2;
      }
    }
    decoded[length++] = value;
  }
  for (const name of LISTED_NAMES) {
    if (name.length !== length) continue;
    let same = true;
    for (let k = 0; k < length && same; k++) same = name[k] === decoded[k];
    if (same) return true;
  }
  return false;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// A Map, so a declared type such as "constructor" can never resolve through the prototype chain.
const SIGNATURES: ReadonlyMap<string, readonly number[]> = new Map<
  UploadMimeType,
  readonly number[]
>([
  ['application/pdf', PDF_SIGNATURE],
  ['image/png', PNG_SIGNATURE],
  ['image/jpeg', JPEG_SIGNATURE],
]);

/** True when the first bytes are the signature of the declared type. Unknown types never match. */
export function hasSignatureFor(bytes: Uint8Array, mimeType: string): boolean {
  const signature = SIGNATURES.get(mimeType);
  return signature !== undefined && startsWith(bytes, signature);
}

/**
 * True when the bytes contain a PDF name from {@link ACTIVE_PDF_NAMES}, after decoding `#xx` escapes.
 *
 * Honest limits, so nobody mistakes this for a scanner:
 * - It reads the raw file. Names inside compressed object streams (PDF 1.5+) are not seen, so a
 *   crafted file can hide a catalog `/OpenAction` or an annotation's `/AA`. Stream objects themselves
 *   cannot live inside object streams, so some payload markers stay visible, but not all.
 * - It cannot see what a reader does after repairing a damaged file, or content inside nested files.
 * - It reads every byte, including compressed image and font data, because skipping "stream data"
 *   would let a crafted file hide real dictionaries behind a fake `stream` keyword. A random byte
 *   pattern can therefore spell a short name such as `/JS` or `/AA` followed by a delimiter: measured
 *   on random bytes, roughly one 1 MiB buffer in 150 is refused. The sender then re-exports a flat
 *   copy. A false refusal is the safe way to fail, and the error says what to do.
 */
export function hasActivePdfContent(bytes: Uint8Array): boolean {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let slash = buffer.indexOf(SLASH);
  while (slash !== -1) {
    const start = slash + 1;
    const limit = Math.min(buffer.length, start + MAX_RAW_NAME_BYTES);
    let end = start;
    while (end < limit && !endsName(buffer[end])) end++;
    // A name longer than the cap cannot decode to a listed name, so it is skipped without decoding.
    if (end > start && endsName(buffer[end]) && isListedName(buffer, start, end)) return true;
    slash = buffer.indexOf(SLASH, end);
  }
  return false;
}

export type UploadVerdict =
  { ok: true } | { ok: false; reason: 'type_mismatch' | 'active_content' };

/** Decides whether `bytes` may be stored as a file of the declared type. Pure, so it is easy to test. */
export function inspectUpload(bytes: Uint8Array, declaredMimeType: string): UploadVerdict {
  if (!hasSignatureFor(bytes, declaredMimeType)) return { ok: false, reason: 'type_mismatch' };
  if (declaredMimeType === 'application/pdf' && hasActivePdfContent(bytes)) {
    return { ok: false, reason: 'active_content' };
  }
  return { ok: true };
}

const ACTIVE_CONTENT_DETAIL =
  'This PDF was refused because it appears to contain scripts, launch actions or attached files (a check on the raw file can also refuse a clean file by mistake). Export a flat copy (for example, print to PDF) and upload that.';

/**
 * Route guard. Throws 422 `document_type_mismatch` (the code the upload routes already return) when
 * the bytes are not the declared type or a PDF names active content. Only the active-content case
 * adds a fixed `detail`, so the sender knows to upload a flat copy; nothing about the file itself
 * (name, size, bytes) goes into the response or a log. Size limits stay with the routes (413).
 */
export function assertUploadAllowed(bytes: Uint8Array, declaredMimeType: string): void {
  const verdict = inspectUpload(bytes, declaredMimeType);
  if (verdict.ok) return;
  throw new ApiError(
    422,
    'document_type_mismatch',
    'Unprocessable Content',
    verdict.reason === 'active_content' ? ACTIVE_CONTENT_DETAIL : undefined,
  );
}
