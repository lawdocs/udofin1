import { describe, expect, it } from 'vitest';
import { parseEventEnvelope } from './envelope.js';

const valid = {
  specversion: '1.0',
  id: '01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6a',
  source: 'urn:udofin:api',
  type: 'in.udofin.application.submitted.v1',
  time: '2026-10-10T12:00:00+05:30',
  subject: 'application/01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6b',
  datacontenttype: 'application/json',
  tenantid: '01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6c',
  correlationid: '01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6d',
  dataclassification: 'confidential',
  data: { applicationId: '01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6b' },
};

describe('EventEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(parseEventEnvelope(valid).success).toBe(true);
  });

  it.each([
    'udofin.application.submitted',
    'in.udofin.application.submitted',
    'in.unknownproduct.application.submitted.v1',
    'in.udofin.Application.Submitted.v1',
  ])('rejects badly named event type %s', (type) => {
    expect(parseEventEnvelope({ ...valid, type }).success).toBe(false);
  });

  it('rejects timestamps without an offset', () => {
    expect(parseEventEnvelope({ ...valid, time: '2026-10-10T12:00:00' }).success).toBe(false);
  });

  it('requires a data classification label', () => {
    const { dataclassification: _omit, ...rest } = valid;
    expect(parseEventEnvelope(rest).success).toBe(false);
  });
});
