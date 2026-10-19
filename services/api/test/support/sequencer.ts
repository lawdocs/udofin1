import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * A fixed file order. The integration files share one database, and the account registry tests that prove "no active fingerprint
 * key means nothing can be registered" need a database in which nobody has activated a key yet, which every other file does.
 * Vitest's default order follows its result cache and file sizes, so it moves between runs and machines; this one does not.
 */
const FIRST = 'lender-accounts.integration.test.ts';

export default class FixedOrderSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (file: TestSpecification) => (file.moduleId.endsWith(`/${FIRST}`) ? 0 : 1);
    return Promise.resolve(
      [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId)),
    );
  }
}
