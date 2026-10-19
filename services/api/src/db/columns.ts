/** `select` list that returns camelCase keys, e.g. { lenderOrgId: 'lender_org_id' }. */
export const columns = (map: Record<string, string>): string =>
  Object.entries(map)
    .map(([key, expression]) => `${expression} as "${key}"`)
    .join(', ');
