import { useCallback, useState } from 'react';
import { type MessageKey } from '../i18n';
import { openPdf } from './pdf-open';
import { type ServicingClient } from './servicing';
import { servicingErrorKey } from './servicing-errors';
import { base64ByteLength } from './servicing-format';
import { documentContentProblem, openOutcomeKey } from './servicing-view';

/** The message to show under a list of documents after an attempt to open one. */
export interface OpenNotice {
  documentId: string;
  key: MessageKey;
}

/**
 * Opens a lender-issued file through the API's authenticated content route and hands it to the device's PDF viewer (the same
 * path as the Phase 07 documents). Nothing is stored: there is no link to keep, and the temporary file is removed by `openPdf`.
 * The file is checked against what the API recorded (which document, which loan, how many bytes) before any viewer sees it.
 */
export function useDocumentOpener(servicing: ServicingClient, loanId: string) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<OpenNotice | null>(null);

  const open = useCallback(
    async (documentId: string, viewerTitle: string) => {
      setOpeningId(documentId);
      setNotice(null);
      const result = await servicing.documentContent(loanId, documentId, 'view');
      if (!result.ok) {
        setOpeningId(null);
        setNotice({ documentId, key: servicingErrorKey(result.code) });
        return;
      }
      const problem = documentContentProblem(result.data, { loanId, documentId }, base64ByteLength);
      if (problem !== null) {
        setOpeningId(null);
        setNotice({ documentId, key: 'loans.doc.checkFailed' });
        return;
      }
      const outcome = await openPdf(result.data.contentBase64, viewerTitle);
      setOpeningId(null);
      const key = openOutcomeKey(outcome);
      if (key !== null) setNotice({ documentId, key });
    },
    [servicing, loanId],
  );

  return { open, openingId, notice };
}
