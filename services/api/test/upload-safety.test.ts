import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/api-error.js';
import {
  ACTIVE_PDF_NAMES,
  assertUploadAllowed,
  hasActivePdfContent,
  hasSignatureFor,
  inspectUpload,
} from '../src/http/upload-safety.js';

// Crafted, harmless byte strings. None of these is a working exploit; they only contain the tokens.
const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, 'latin1');
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('synthetic image bytes'),
]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('synthetic image bytes')]);
const escapeAll = (name: string) =>
  [...name].map((c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');

describe('file signatures', () => {
  it('accepts only the declared type', () => {
    expect(hasSignatureFor(pdf(''), 'application/pdf')).toBe(true);
    expect(hasSignatureFor(PNG, 'image/png')).toBe(true);
    expect(hasSignatureFor(JPEG, 'image/jpeg')).toBe(true);
    expect(hasSignatureFor(PNG, 'application/pdf')).toBe(false);
    expect(hasSignatureFor(pdf(''), 'image/png')).toBe(false);
    expect(hasSignatureFor(JPEG, 'image/png')).toBe(false);
  });

  it('refuses unknown types, empty input and truncated signatures', () => {
    expect(hasSignatureFor(pdf(''), 'text/html')).toBe(false);
    expect(hasSignatureFor(pdf(''), '')).toBe(false);
    expect(hasSignatureFor(pdf(''), 'constructor')).toBe(false); // not a prototype lookup
    expect(hasSignatureFor(Buffer.alloc(0), 'application/pdf')).toBe(false);
    expect(hasSignatureFor(Buffer.from('%PDF'), 'application/pdf')).toBe(false);
    expect(hasSignatureFor(Buffer.from('89504e47', 'hex'), 'image/png')).toBe(false);
    expect(hasSignatureFor(Buffer.from('ffd8', 'hex'), 'image/jpeg')).toBe(false);
  });

  it('requires the PDF header at byte 0 (no leading junk)', () => {
    expect(hasSignatureFor(Buffer.from(' %PDF-1.7\n'), 'application/pdf')).toBe(false);
  });
});

describe('active PDF content: plain names', () => {
  it('refuses every listed name, whatever follows it', () => {
    for (const name of ACTIVE_PDF_NAMES) {
      for (const after of [
        ' ',
        '\n',
        '\r',
        '\t',
        '\0',
        '\f',
        '/',
        '(',
        ')',
        '<',
        '>',
        '[',
        ']',
        '%',
      ]) {
        expect(
          hasActivePdfContent(pdf(`<< /${name}${after}1 0 R >>`)),
          `${name} then ${JSON.stringify(after)}`,
        ).toBe(true);
      }
      // End of file ends a name too.
      expect(hasActivePdfContent(Buffer.from(`%PDF-1.4\n/${name}`))).toBe(true);
    }
  });

  it('finds names squeezed between others without white space', () => {
    expect(hasActivePdfContent(pdf('<</S/JavaScript/JS(app.alert(1))>>'))).toBe(true);
    expect(hasActivePdfContent(pdf('<</Type/Catalog/AA<</O 4 0 R>>>>'))).toBe(true);
    expect(hasActivePdfContent(pdf('<</Type/Catalog/Pages 2 0 R/OpenAction[3 0 R/Fit]>>'))).toBe(
      true,
    );
  });

  it('finds a name late in a file and in an incremental update', () => {
    const filler = '1 0 obj\n<< /Type /Page >>\nendobj\n'.repeat(5000);
    expect(hasActivePdfContent(pdf(`${filler}trailer << /OpenAction 9 0 R >>`))).toBe(true);
  });

  it('allows an ordinary document', () => {
    const clean = pdf(
      [
        '1 0 obj << /Type /Catalog /Pages 2 0 R /Lang (en-IN) >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [5 0 R] >> endobj',
        '5 0 obj << /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.org) >> >> endobj',
        '6 0 obj << /S /GoTo /D [3 0 R /Fit] >> endobj',
        '7 0 obj << /Producer (synthetic) /Title (How JavaScript works) >> endobj',
      ].join('\n'),
    );
    expect(hasActivePdfContent(clean)).toBe(false);
    expect(inspectUpload(clean, 'application/pdf')).toEqual({ ok: true });
  });
});

describe('active PDF content: hex-escaped names', () => {
  it('decodes #xx escapes before matching', () => {
    for (const body of [
      '/J#61vaScript',
      '/Java#53cript',
      '/#4A#53', // JS
      '/#41#41', // AA
      '/Open#41ction',
      '/Launc#68',
      '/#45mbeddedFile',
      '/#58FA',
      `/${escapeAll('JavaScript')}`,
      `/${escapeAll('OpenAction')}`,
    ]) {
      expect(hasActivePdfContent(pdf(`<< ${body} 1 0 R >>`)), body).toBe(true);
    }
  });

  it('treats hex digits in either case alike', () => {
    expect(hasActivePdfContent(pdf('<< /J#61vaScript 1 0 R >>'))).toBe(true);
    expect(hasActivePdfContent(pdf('<< /#4a#53 1 0 R >>'))).toBe(true); // lower-case hex
    expect(hasActivePdfContent(pdf('<< /#4A#53 1 0 R >>'))).toBe(true); // upper-case hex
    expect(hasActivePdfContent(pdf('<< /#4a#5A#53 1 0 R >>'))).toBe(false); // JZS: not a listed name
  });

  it('still decodes the longest listed name written entirely as escapes (at the length cap)', () => {
    const longest = [...ACTIVE_PDF_NAMES].reduce((a, b) => (b.length > a.length ? b : a));
    const raw = escapeAll(longest);
    expect(raw.length).toBe(3 * longest.length);
    expect(hasActivePdfContent(pdf(`<< /${raw} 1 0 R >>`))).toBe(true);
    expect(hasActivePdfContent(pdf(`<< /${raw}#41 1 0 R >>`))).toBe(false); // one more character: another name
  });

  it('decodes once, as a reader does', () => {
    // `#2361` is the characters `#61`, not `a`; this is not `/JavaScript`.
    expect(hasActivePdfContent(pdf('<< /J#2361vaScript 1 0 R >>'))).toBe(false);
  });

  it('does not decode malformed escapes', () => {
    expect(hasActivePdfContent(pdf('<< /Java#Script 1 0 R >>'))).toBe(false);
    expect(hasActivePdfContent(pdf('<< /Java#5Script 1 0 R >>'))).toBe(false);
    expect(hasActivePdfContent(pdf('<< /JavaScript#2 1 0 R >>'))).toBe(false);
    expect(hasActivePdfContent(pdf('<< /JS# 1 0 R >>'))).toBe(false);
  });

  it('an escaped slash or space stays inside the name', () => {
    expect(hasActivePdfContent(pdf('<< /Open#2FAction 1 0 R >>'))).toBe(false);
    expect(hasActivePdfContent(pdf('<< /JS#20 1 0 R >>'))).toBe(false); // the name "JS " is another name
  });
});

describe('active PDF content: names are exact and case-sensitive', () => {
  it('does not refuse longer or shorter names that merely contain a listed name', () => {
    // These are different PDF names. No reader treats them as the action, so refusing them would only
    // produce false refusals. Decision recorded here on purpose.
    for (const name of [
      'Javascriptish',
      'JavaScripts',
      'JavaScript2',
      'JSON',
      'JSX',
      'JS-extra',
      'AAPL',
      'AAA',
      'Launcher',
      'OpenActions',
      'EmbeddedFileX',
      'XFAForm',
      'Jav',
      'J',
    ]) {
      expect(hasActivePdfContent(pdf(`<< /${name} 1 0 R >>`)), name).toBe(false);
    }
  });

  it('does not refuse other-case spellings, because PDF names are case-sensitive', () => {
    for (const name of [
      'javascript',
      'JAVASCRIPT',
      'Javascript',
      'js',
      'Js',
      'aa',
      'Aa',
      'openaction',
    ]) {
      expect(hasActivePdfContent(pdf(`<< /${name} 1 0 R >>`)), name).toBe(false);
    }
  });

  it('ignores listed words that are not names (no leading slash)', () => {
    expect(hasActivePdfContent(pdf('(JavaScript OpenAction Launch JS AA) Tj'))).toBe(false);
  });

  it('fails closed on a name-like token inside a string or comment', () => {
    // The scan does not parse strings or comments, so a slash there still starts a token.
    expect(hasActivePdfContent(pdf('<< /Title (The /JavaScript title) >>'))).toBe(true);
    expect(hasActivePdfContent(pdf('% notes: /OpenAction is not used here'))).toBe(true);
  });

  it('allows ordinary links and in-document jumps', () => {
    expect(
      hasActivePdfContent(
        pdf(
          '<< /S /URI /URI (https://example.org) >> << /S /GoTo /D (a) >> << /S /Named /N /NextPage >>',
        ),
      ),
    ).toBe(false);
  });
});

describe('active PDF content: long and hostile input', () => {
  it('skips names longer than any listed name, and keeps scanning after them', () => {
    const long = '/' + 'A'.repeat(5000);
    expect(hasActivePdfContent(pdf(`<< ${long} 1 0 R >>`))).toBe(false);
    expect(hasActivePdfContent(pdf(`<< ${long} 1 0 R /JS (x) >>`))).toBe(true);
    expect(hasActivePdfContent(pdf(`<< ${long}/OpenAction 1 0 R >>`))).toBe(true); // slash ends the long name
    // A near miss (the escaped name plus extra characters), then a listed name.
    expect(hasActivePdfContent(pdf(`<< /${escapeAll('JavaScript')}00 /AA 1 0 R >>`))).toBe(true);
  });

  it('copes with empty names and bare slashes', () => {
    expect(hasActivePdfContent(Buffer.alloc(0))).toBe(false);
    expect(hasActivePdfContent(Buffer.from('/'))).toBe(false);
    expect(hasActivePdfContent(Buffer.from('////'))).toBe(false);
    expect(hasActivePdfContent(Buffer.from('//JS'))).toBe(true);
  });

  it('reads a Uint8Array view, not only a Buffer', () => {
    const backing = new Uint8Array(Buffer.from('xxxx%PDF-1.7\n<< /JS (x) >>\nxxxx'));
    expect(hasActivePdfContent(backing.subarray(4, 4 + 25))).toBe(true);
    expect(hasActivePdfContent(backing.subarray(4, 4 + 9))).toBe(false); // cut before the name
  });

  it('handles the largest accepted upload quickly, clean and hostile', () => {
    const size = 8 * 1024 * 1024;
    const header = Buffer.from('%PDF-1.7\n');
    const clean = Buffer.concat([header, Buffer.alloc(size - header.length, 0x41)]);
    expect(inspectUpload(clean, 'application/pdf')).toEqual({ ok: true });

    const atEnd = Buffer.concat([
      clean.subarray(0, size - 20),
      Buffer.from('\n/OpenAction 1 0 R\n'),
    ]);
    expect(inspectUpload(atEnd, 'application/pdf')).toEqual({
      ok: false,
      reason: 'active_content',
    });

    // A file made only of tiny names forces the most work per byte; it must stay well under a second.
    const names = Buffer.concat([header, Buffer.from('/Ja'.repeat(Math.floor(size / 3)))]);
    const started = performance.now();
    expect(hasActivePdfContent(names)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('known limit: compressed object streams', () => {
  it('does NOT see a name that only exists inside a Flate-compressed object stream', () => {
    // This test documents a limit; it is not a feature. PDF 1.5 object streams can hold the catalog,
    // so `/OpenAction` there is invisible to a byte scan. The second approver still reads the file.
    // If this expectation ever flips, the scanner changed: update upload-safety.ts and the docs.
    const compressed = deflateSync(Buffer.from('1 0 << /Type /Catalog /OpenAction 5 0 R >>'));
    const file = Buffer.concat([
      Buffer.from(
        '%PDF-1.7\n7 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\n',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    expect(file.includes('OpenAction')).toBe(false);
    expect(hasActivePdfContent(file)).toBe(false);
  });
});

describe('inspectUpload and assertUploadAllowed', () => {
  const activePdf = pdf('<< /Type /Catalog /OpenAction 3 0 R >>');

  it('passes clean files of each type', () => {
    expect(inspectUpload(pdf('<< /Type /Catalog >>'), 'application/pdf')).toEqual({ ok: true });
    expect(inspectUpload(PNG, 'image/png')).toEqual({ ok: true });
    expect(inspectUpload(JPEG, 'image/jpeg')).toEqual({ ok: true });
    expect(() => assertUploadAllowed(PNG, 'image/png')).not.toThrow();
  });

  it('does not scan images for PDF names', () => {
    const withText = Buffer.concat([PNG, Buffer.from(' /OpenAction /JavaScript /JS /AA')]);
    expect(inspectUpload(withText, 'image/png')).toEqual({ ok: true });
    expect(inspectUpload(Buffer.concat([JPEG, Buffer.from(' /OpenAction')]), 'image/jpeg')).toEqual(
      { ok: true },
    );
  });

  it('reports why a file was refused', () => {
    expect(inspectUpload(activePdf, 'application/pdf')).toEqual({
      ok: false,
      reason: 'active_content',
    });
    expect(inspectUpload(PNG, 'application/pdf')).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(inspectUpload(activePdf, 'image/png')).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(inspectUpload(Buffer.alloc(0), 'application/pdf')).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
    expect(inspectUpload(pdf(''), 'application/zip')).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
  });

  it('throws the problem the upload routes already return, without file details', () => {
    for (const [bytes, mime] of [
      [activePdf, 'application/pdf'],
      [PNG, 'application/pdf'],
      [Buffer.alloc(0), 'image/png'],
    ] as const) {
      try {
        assertUploadAllowed(bytes, mime);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const api = error as ApiError;
        expect(api.status).toBe(422);
        expect(api.code).toBe('document_type_mismatch');
        expect(api.title).toBe('Unprocessable Content');
        // The detail is a fixed sentence: no name, size, hash or byte from the upload.
        expect(api.detail ?? '').not.toMatch(/OpenAction|\d{4,}/);
      }
    }
  });

  it('tells the sender what to do only for active content', () => {
    const detailOf = (bytes: Buffer, mime: string) => {
      try {
        assertUploadAllowed(bytes, mime);
      } catch (error) {
        return (error as ApiError).detail;
      }
      return 'none thrown';
    };
    expect(detailOf(activePdf, 'application/pdf')).toMatch(/flat copy/);
    expect(detailOf(PNG, 'application/pdf')).toBeUndefined();
  });
});
