/**
 * Opening the provider's hosted page (payment checkout or mandate authorisation).
 *
 * The link is a BEARER SECRET: whoever holds it can complete the payment or the authorisation. So this file, and the screens that
 * call it, follow these rules: the link is fetched only when the borrower taps; it lives in a local variable of that one tap
 * handler; it is never put in React state, a navigation parameter, a log, an analytics event, an error message, the clipboard,
 * storage or the screen; and a failure is reported as a closed word, never with the link or the system's message.
 */
export type OpenOutcome = 'opened' | 'unsafe' | 'failed';

/** `https` only, a plain host (letters, digits, dots, hyphens), an optional port, no user information, no whitespace. */
const HTTPS_LINK = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#]\S*)?$/;
/** A real hand-off link is a few hundred characters; anything far larger is not one. */
const MAX_LINK_LENGTH = 4096;

export function isOpenableHandoffUrl(link: string): boolean {
  return link.length <= MAX_LINK_LENGTH && HTTPS_LINK.test(link);
}

/**
 * Hands the link to the system (the screens pass `Linking.openURL` from react-native: the system browser, no new permission and no
 * new package). An unsafe link is never passed on. The result never carries the link or the thrown error.
 */
export async function openHandoff(
  link: string,
  opener: (url: string) => Promise<unknown>,
): Promise<OpenOutcome> {
  if (!isOpenableHandoffUrl(link)) return 'unsafe';
  try {
    await opener(link);
    return 'opened';
  } catch {
    return 'failed';
  }
}
