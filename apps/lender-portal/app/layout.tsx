import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Udofin Lender Portal',
  description:
    'Portal for authorised staff of partner regulated lenders: their own applications, products, decision queues, documents, complaints and reports.',
  // Internal portals must never be indexed by search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Same-origin token stylesheet keeps the CSP free of inline styles (see app/theme.css). */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/theme.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
