/**
 * Normalises an Indian mobile number to E.164 (+91XXXXXXXXXX). Returns null when it cannot be one.
 * The number is passed to the auth server only; it is never logged or stored by the app.
 */
export function normaliseIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return match?.[1] ? `+91${match[1]}` : null;
}

/** "+91 98••• ••210" style display that never shows the whole number on screen recordings. */
export function maskPhone(e164: string): string {
  return e164.length < 6 ? '•••' : `${e164.slice(0, 5)}•••••${e164.slice(-3)}`;
}
