import type { CurrencyCode, DecimalString, Id, LocalDate, MinorUnits, Timestamps } from './common';

export interface ReceiptLineItem {
  id: Id;
  description: string;
  quantity: DecimalString | null;
  /** Positive line total in the receipt currency. */
  amount: MinorUnits;
  /** Suggested category for "Split by items". */
  categoryId: Id | null;
}

export type ReceiptStatus =
  'uploaded' | 'processing' | 'parsed' | 'matched' | 'needs_review' | 'failed';

export interface Receipt extends Timestamps {
  id: Id;
  /** Object key of the image in R2. Never a public URL. */
  r2Key: string;
  merchant: string | null;
  date: LocalDate | null;
  /** Positive total as printed on the receipt. */
  total: MinorUnits | null;
  subtotal: MinorUnits | null;
  tax: MinorUnits | null;
  tip: MinorUnits | null;
  currency: CurrencyCode | null;
  lineItems: ReceiptLineItem[];
  matchedTransactionId: Id | null;
  status: ReceiptStatus;
  /** 0 to 1, how sure the extraction was. */
  aiConfidence: number | null;
  /**
   * Where the image lives on this device until it is uploaded. Added by
   * session A: the app saves receipt photos locally and gives `r2Key` a
   * placeholder (`pending-upload/<id>.jpg`). The backend upload replaces the
   * placeholder with the real R2 key and may then clear this field.
   */
  localUri?: string | null;
}
