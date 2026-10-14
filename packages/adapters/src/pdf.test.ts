import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HINDI_SAMPLE_LABELS,
  SAMPLE_DIGEST,
  sampleKfsData,
  sampleKfsModel,
} from '../test/kfs-sample.js';
import {
  formatDate,
  formatInstant,
  formatPercent,
  formatRupees,
  RenderError,
  renderDocument,
  splitRuns,
} from './pdf.js';

const NOW = new Date('2026-10-14T05:00:00Z');
const havePdftotext = spawnSync('pdftotext', ['-v']).error === undefined;

function text(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'udofin-pdf-'));
  try {
    const file = join(dir, 'f.pdf');
    writeFileSync(file, bytes);
    const out = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    return out.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('formatting moves a decimal point and nothing else', () => {
  it('shows paise as rupees with Indian grouping', () => {
    expect(formatRupees(0)).toBe('₹ 0.00');
    expect(formatRupees(5)).toBe('₹ 0.05');
    expect(formatRupees(2_000_000)).toBe('₹ 20,000.00');
    expect(formatRupees(1_234_567_89)).toBe('₹ 12,34,567.89');
    expect(formatRupees(97_000)).toBe('₹ 970.00');
  });
  it('shows basis points as a percentage', () => {
    expect(formatPercent(1707)).toBe('17.07 %');
    expect(formatPercent(5)).toBe('0.05 %');
    expect(formatPercent(1500)).toBe('15.00 %');
  });
  it('refuses values that are not whole non-negative numbers', () => {
    expect(() => formatRupees(1.5)).toThrow(RenderError);
    expect(() => formatRupees(-1)).toThrow(RenderError);
    expect(() => formatPercent(0.5)).toThrow(RenderError);
    expect(() => formatDate('2026-13-01x')).toThrow(RenderError);
  });
  it('shows instants in India time', () => {
    expect(formatInstant('2026-10-14T18:29:59Z')).toBe('14/10/2026 23:59 IST');
    expect(formatInstant('2026-10-14T18:30:00Z')).toBe('15/10/2026 00:00 IST');
    expect(formatDate('2026-12-01')).toBe('01/12/2026');
  });
  it('chooses a font per character so the rupee sign and Devanagari both render', () => {
    expect(splitRuns('ऋण राशि ₹ 20,000')).toEqual([
      { font: 'dev', text: 'ऋण राशि ₹ ' },
      { font: 'lat', text: '20,000' },
    ]);
    expect(splitRuns('APR 17.07 %')).toEqual([{ font: 'lat', text: 'APR 17.07 %' }]);
  });
});

describe('KFS rendering', () => {
  it('produces a PDF that carries the lender figures unchanged', async () => {
    const bytes = await renderDocument(sampleKfsModel(), { generatedAt: NOW });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(8_000);
    if (!havePdftotext) return;
    const t = text(bytes);
    expect(t).toContain('Key Facts Statement');
    expect(t).toContain('UDF-0123456789AB');
    expect(t).toContain('Sample Lender Ltd (test)');
    expect(t).toContain('₹ 20,000.00');
    expect(t).toContain('₹ 23,274.00');
    expect(t).toContain('₹ 19,600.00');
    expect(t).toContain('17.07 %');
    expect(t).toContain('15.00 %');
    // The lender's schedule is printed as given: its own rounding is not "fixed" here, nothing is added up.
    expect(t).toContain('₹ 18,552.00');
    expect(t).not.toContain('19,999');
    expect(t).not.toContain('3,275');
    expect(t).toContain('Note from the lender on rounding');
    for (let n = 1; n <= 24; n++) expect(t).toMatch(new RegExp(`\\b${String(n)}\\b`));
    expect(t).toContain('15/10/2026 10:30 IST'.slice(0, 0) + '14/10/2026 10:30 IST');
    expect(t).toContain('20/10/2026');
  });

  it('is repeatable for the same input', async () => {
    const a = await renderDocument(sampleKfsModel(), { generatedAt: NOW });
    const b = await renderDocument(sampleKfsModel(), { generatedAt: NOW });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('shows the floating-rate table only when the rate is floating', async () => {
    const data = sampleKfsData();
    data.interest = { rateBps: 1500, type: 'floating' };
    data.floating = {
      referenceBenchmark: 'Sample benchmark',
      benchmarkRateBps: 1000,
      spreadBps: 500,
      finalRateBps: 1500,
      resetPeriodicityMonths: 6,
      impactOf25bps: {
        epiOnBenchmarkMinor: 1200,
        epiOnSpreadMinor: 1100,
        epiCountOnBenchmark: 1,
        epiCountOnSpread: 1,
      },
    };
    const bytes = await renderDocument(sampleKfsModel({ data }), { generatedAt: NOW });
    if (!havePdftotext) return;
    const t = text(bytes);
    expect(t).toContain('Sample benchmark');
    expect(t).toContain('Floating');
  });

  it('refuses to render without the validity window', async () => {
    await expect(
      renderDocument(sampleKfsModel({ validity: null }), { generatedAt: NOW }),
    ).rejects.toThrow('validity_missing');
  });

  it('refuses a template whose engine does not fit the document', async () => {
    const m = sampleKfsModel();
    await expect(
      renderDocument(
        { ...m, template: { ...m.template, body: { engine: 'agreement_v1', sections: [] } } },
        { generatedAt: NOW },
      ),
    ).rejects.toThrow('template_engine_mismatch');
  });
});

describe('Hindi rendering', () => {
  async function render() {
    const labels: Record<string, string> = { ...HINDI_SAMPLE_LABELS };
    // A non-English template must supply every word it uses; discover them by rendering until none is missing.
    for (let i = 0; i < 120; i++) {
      try {
        const m = sampleKfsModel({ language: 'hi' });
        m.template.body = { engine: 'annex_i_v1', labels };
        return await renderDocument(m, { generatedAt: NOW });
      } catch (e) {
        const match = e instanceof RenderError ? /^label_missing:(.+)$/.exec(e.code) : null;
        if (!match?.[1]) throw e;
        labels[match[1]] = `नमूना ${match[1]}`;
      }
    }
    throw new Error('too many missing labels');
  }

  it('does not fall back to English words when an approved word is missing', async () => {
    const m = sampleKfsModel({ language: 'hi' });
    m.template.body = { engine: 'annex_i_v1', labels: { ...HINDI_SAMPLE_LABELS } };
    await expect(renderDocument(m, { generatedAt: NOW })).rejects.toThrow(/^label_missing:/);
  });

  it('embeds both fonts and extracts the Devanagari text', async () => {
    const bytes = await render();
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).toMatch(/NotoSansDevanagari/);
    expect(raw).toMatch(/NotoSans-/);
    if (!havePdftotext) return;
    const t = text(bytes);
    expect(t).toContain('नमूना');
    expect(t).toContain('₹ 20,000.00');
  });
});

describe('Agreement rendering', () => {
  const agreement = () => {
    const kfs = sampleKfsModel();
    return sampleKfsModel({
      documentType: 'loan_agreement',
      validity: null,
      template: {
        id: '00000000-0000-4000-8000-000000000006',
        key: 'agreement.loan',
        version: 1,
        body: {
          engine: 'agreement_v1',
          title: 'SAMPLE - NOT A LEGAL DOCUMENT',
          sections: [
            {
              heading: 'Sample clause for {{lenderName}}',
              text: 'This is test text for proposal {{proposalNo}} of {{sanctionedAmount}}.',
            },
          ],
        },
      },
      kfsDocument: {
        id: '00000000-0000-4000-8000-000000000007',
        sha256: 'b'.repeat(64),
        contentDigest: SAMPLE_DIGEST,
      },
      kfsTemplate: kfs.template.body,
    });
  };

  it('prints the KFS as a summary box from the same data', async () => {
    const bytes = await renderDocument(agreement(), { generatedAt: NOW });
    if (!havePdftotext) return;
    const t = text(bytes);
    expect(t).toContain('Sample clause for Sample Lender Ltd (test)');
    expect(t).toContain('proposal UDF-0123456789AB of ₹ 20,000.00');
    expect(t).toContain('Key Facts Statement (summary box)');
    expect(t).toContain(SAMPLE_DIGEST);
    expect(t).toContain('17.07 %');
  });

  it('refuses a summary box whose KFS digest differs from the accepted KFS', async () => {
    const m = agreement();
    await expect(
      renderDocument(
        {
          ...m,
          kfsDocument: {
            id: m.kfsDocument?.id ?? '',
            sha256: 'b'.repeat(64),
            contentDigest: 'c'.repeat(64),
          },
        },
        { generatedAt: NOW },
      ),
    ).rejects.toThrow('summary_box_mismatch');
  });

  it('refuses a placeholder it does not know and an agreement without its KFS', async () => {
    const m = agreement();
    m.template.body = {
      engine: 'agreement_v1',
      sections: [{ heading: 'x', text: '{{borrowerPan}}' }],
    };
    await expect(renderDocument(m, { generatedAt: NOW })).rejects.toThrow(
      'placeholder_unknown:borrowerPan',
    );
    await expect(
      renderDocument({ ...agreement(), kfsDocument: null }, { generatedAt: NOW }),
    ).rejects.toThrow('kfs_missing');
  });
});
