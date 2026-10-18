import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The screens are thin React Native files that the node test runner cannot draw, so what is checked here is their source: the
 * guards that keep them thin (no figure is computed, no timer counts down, no raw code or server text is drawn, the payment
 * buttons only navigate, a flagged quotation has no pay button, every link opens a screen that exists). The wording and the
 * rules themselves are tested on the view models in servicing.test.ts.
 */
const root = join(import.meta.dirname, '..');
const loansDir = join(root, 'app', '(app)', 'loans');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const read = (path: string) => readFileSync(path, 'utf8');
const screenFiles = walk(loansDir);
const SERVICING_SRC = [
  'servicing.ts',
  'servicing-view.ts',
  'servicing-format.ts',
  'servicing-errors.ts',
  'servicing-ui.tsx',
  'useDocumentOpener.ts',
  'useRequestActions.ts',
  'MyLoansEntry.tsx',
].map((name) => join(root, 'src', 'borrower', name));
const codeOnly = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
const sourceOf = (name: string) => codeOnly(read(join(loansDir, ...name.split('/'))));

describe('the screens that exist', () => {
  it('has every screen the feature needs', () => {
    const expected = [
      'index.tsx',
      'reminders.tsx',
      '[id]/index.tsx',
      '[id]/schedule.tsx',
      '[id]/activity.tsx',
      '[id]/statements.tsx',
      '[id]/quotation.tsx',
      '[id]/closure.tsx',
    ];
    for (const file of expected)
      expect(existsSync(join(loansDir, ...file.split('/'))), file).toBe(true);
  });

  it('never creates or edits anything in the payments folder', () => {
    for (const file of [...screenFiles, ...SERVICING_SRC]) {
      expect(relative(root, file), file).not.toContain(join('app', '(app)', 'payments'));
    }
  });

  it('every link to a loan screen opens a screen that exists', () => {
    const targets = new Set<string>();
    for (const file of [...screenFiles, ...SERVICING_SRC]) {
      for (const m of codeOnly(read(file)).matchAll(/'(\/loans[^']*)'/g)) targets.add(m[1] ?? '');
    }
    expect(targets.size).toBeGreaterThan(5);
    for (const target of targets) {
      const path =
        target === '/loans'
          ? 'index.tsx'
          : target === '/loans/[id]'
            ? '[id]/index.tsx'
            : `${target.replace('/loans/', '')}.tsx`;
      expect(existsSync(join(loansDir, ...path.split('/'))), target).toBe(true);
    }
  });
});

describe('the screens decide nothing', () => {
  it('do not compute, round or total a figure', () => {
    for (const file of [...screenFiles, ...SERVICING_SRC]) {
      const text = codeOnly(read(file));
      expect(text, file).not.toMatch(
        /\.reduce\(|toFixed|Math\.(round|floor|ceil|trunc)|parseFloat|parseInt|\* 100|\/ 100/,
      );
    }
  });

  it('have no timer, no clock and no countdown', () => {
    for (const file of screenFiles) {
      const text = codeOnly(read(file));
      expect(text, file).not.toMatch(
        /setInterval|setTimeout|Date\.now|new Date\(|requestAnimationFrame|useCountdown/,
      );
    }
  });

  it('do not log and do not call the network except through the API client', () => {
    for (const file of [...screenFiles, ...SERVICING_SRC]) {
      const text = codeOnly(read(file));
      expect(text, file).not.toMatch(/console\.|\bfetch\(|XMLHttpRequest|AsyncStorage|SecureStore/);
    }
  });

  it('never draw a raw error code or response text', () => {
    for (const file of [...screenFiles, ...SERVICING_SRC.filter((f) => f.endsWith('.tsx'))]) {
      const text = codeOnly(read(file));
      // {state.code} or {result.code} between tags would show the code itself.
      expect(text, file).not.toMatch(/(?<![=\w])\{\s*[\w.?]*\bcode\s*\}/);
      expect(text, file).not.toMatch(/\{\s*[\w.?]*\bdetail\s*\}/);
    }
  });

  it('turn every failure code into wording through the mapping of this feature', () => {
    for (const file of screenFiles) {
      const text = codeOnly(read(file));
      expect(text, file).not.toMatch(/from '.*borrower\/errors'/);
      if (/\.code\b/.test(text)) expect(text, file).toMatch(/servicingErrorKey|SectionError/);
    }
  });

  it('write no English or Hindi sentence of their own: every text comes through t()', () => {
    for (const file of [...screenFiles, ...SERVICING_SRC.filter((f) => f.endsWith('.tsx'))]) {
      const lines = codeOnly(read(file)).split('\n');
      lines.forEach((line, i) => {
        expect(line, `${relative(root, file)}:${String(i + 1)}`).not.toMatch(
          /^\s+[A-Z][a-z]+(?: [A-Za-z']+)+[.!?]?$/,
        );
        expect(line, `${relative(root, file)}:${String(i + 1)}`).not.toMatch(
          /\b(title|label|placeholder|accessibilityLabel)="[^"{]*[A-Za-z]{3}/,
        );
        expect(line, `${relative(root, file)}:${String(i + 1)}`).not.toMatch(/[ऀ-ॿ]/);
      });
    }
  });
});

describe('the payment buttons only navigate', () => {
  const home = () => sourceOf('[id]/index.tsx');

  it('Pay and Set up auto-pay open the payments screens with the loan id', () => {
    const text = home();
    expect(text).toContain("t('loans.home.pay')");
    expect(text).toContain('router.push(payHref(loanId))');
    expect(text).toContain("t('loans.home.autopay')");
    expect(text).toContain('router.push(mandateSetupHref(loanId))');
  });

  it('are always drawn: the loan page does not ask the payment options route first', () => {
    const text = home();
    expect(text).not.toMatch(/options|mandateOptions|\/v1\/payments|\/v1\/mandates/);
    // Not inside a conditional: the two buttons come straight after the other buttons of the page.
    expect(text).not.toMatch(/\?\s*\(\s*<Button\s+title=\{t\('loans\.home\.pay'\)/);
  });

  it('the client has no payments or mandate route at all', () => {
    const text = codeOnly(read(join(root, 'src', 'borrower', 'servicing.ts')));
    const paths = [...text.matchAll(/['`](\/v1\/[^'`?$]*)/g)].map((m) => m[1] ?? '');
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      expect(path, path).toMatch(/^\/v1\/(loans|me\/reminders)(\/|$)/);
    }
    expect(text).not.toMatch(/\/v1\/(payments|mandates|admin|platform)/);
    expect(text).not.toMatch(/\/v1\/me(?!\/reminders)/);
  });
});

describe('the quotation screen', () => {
  const text = () => sourceOf('[id]/quotation.tsx');

  it('offers payment only for a quotation the model says can be paid, and names the foreclosure purpose', () => {
    const source = text();
    expect(source).toMatch(
      /quote\.canPay\s*\?\s*\(\s*<Button\s+title=\{t\('loans\.quote\.pay'\)\}/,
    );
    expect(source).toContain('router.push(payQuotationHref(loanId))');
    expect(source.match(/payQuotationHref/g)?.length).toBe(2); // the import and the one use
  });

  it('asks for a corrected quotation, with no payment, when the parts do not add up', () => {
    const source = text();
    expect(source).toContain('totalMismatch');
    expect(source).toContain("t('loans.quote.requestCorrected'");
  });

  it('takes a new Idempotency-Key for each new request and keeps it only after a lost answer', () => {
    const source = text();
    expect(source).toContain('servicing.requestForeclosureQuote(loanId, requestKey)');
    expect(source).toContain('setRequestKey(keyAfter(result, requestKey))');
  });
});

describe('statements and messages', () => {
  it('a statement request goes out with its own key, renewed when the dates change', () => {
    const source = sourceOf('[id]/statements.tsx');
    expect(source).toContain('servicing.requestStatement(loanId, parsed.period, submitKey)');
    expect(source).toContain('setSubmitKey(keyAfter(result, submitKey))');
    expect(source.match(/setSubmitKey\(newActionKey\(\)\)/g)?.length).toBe(2);
  });

  it('the statement dates are checked before anything is sent', () => {
    const source = sourceOf('[id]/statements.tsx');
    const check = source.indexOf('parseStatementPeriod(');
    const call = source.indexOf('servicing.requestStatement(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(call);
    expect(source).toContain('if (!parsed.ok)');
  });

  it('a message is marked read only when opened, only if unread, and shown read only after the API answered', () => {
    const source = sourceOf('reminders.tsx');
    expect(source).toContain('shouldMarkRead({ id, unread }, inFlight.current)');
    expect(source).toContain('servicing.markReminderRead(id, newActionKey())');
    expect(source).toContain('if (result.ok) setReadNow(');
    expect(source).toContain('if (!willOpen || !shouldMarkRead(');
  });

  it('the lender’s message is drawn exactly as returned, not shortened or reformatted', () => {
    const source = sourceOf('reminders.tsx');
    expect(source).toContain('<Body>{model.message}</Body>');
    expect(source).not.toMatch(/model\.message\.(slice|substring|replace|trim|split|toLowerCase)/);
    expect(source).not.toMatch(/numberOfLines/);
  });

  it('opening a document goes through the content route and the checks before the viewer', () => {
    const source = codeOnly(read(join(root, 'src', 'borrower', 'useDocumentOpener.ts')));
    const content = source.indexOf('servicing.documentContent(');
    const check = source.indexOf('documentContentProblem(');
    const viewer = source.indexOf('openPdf(');
    expect(content).toBeGreaterThan(-1);
    expect(content).toBeLessThan(check);
    expect(check).toBeLessThan(viewer);
    expect(source).toContain("'view'");
    expect(source).not.toMatch(/Linking|WebBrowser|openURL|uri:/);
  });
});

describe('the home screen', () => {
  const home = codeOnly(read(join(root, 'app', '(app)', 'index.tsx')));

  it('has one "My loans" entry and keeps everything it had', () => {
    expect(home.match(/<MyLoansEntry \/>/g)?.length).toBe(1);
    for (const kept of [
      "t('home.noKyc')",
      "t('home.myRequests')",
      "t('home.newRequest')",
      "t('home.continueSetup')",
      "step === 'closed'",
      "step === 'closing'",
    ]) {
      expect(home, kept).toContain(kept);
    }
  });

  it('the entry draws nothing unless the loan list has a loan', () => {
    const entry = codeOnly(read(join(root, 'src', 'borrower', 'MyLoansEntry.tsx')));
    expect(entry).toContain("state.kind !== 'ready' || !hasAnyLoan(state.data)");
    expect(entry).toContain('return null');
  });
});
