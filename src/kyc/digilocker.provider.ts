/**
 * What the DigiLocker eKYC needs from a provider (Surepass, Sandbox): a hosted DigiLocker
 * sign-in page, its status, the Aadhaar, and the PAN if the grahak shared one. Each provider
 * maps its own API onto these shapes, so the service and the terminal never change.
 */
export type DlSession = { clientId: string; url: string; expirySeconds: number };
export type DlStatus = {
  completed: boolean;
  failed: boolean;
  aadhaarLinked: boolean;
  /** Documents the grahak agreed to share ('aadhaar', 'pan'); empty when the provider can't say. */
  documents: string[];
  error: string;
};
export type DlAadhaar = {
  last4: string;
  name: string;
  /** DD-MM-YYYY, as UIDAI writes it. */
  dob: string;
  gender: string;
  careOf: string;
  address: string;
  pincode: string;
  photo: Buffer | null;
  /** The mobile on their DigiLocker account, when the provider gives it. */
  mobile: string;
  /** The signed e-Aadhaar as issued, or the provider's answer when the file can't be had. */
  proof: Buffer;
};
export type DlPan = { status: 'none' | 'verified' | 'failed'; number: string; note: string; file: Buffer | null };

export interface DigilockerProvider {
  /** Stored in buyer_kyc.source: the provider, '-sandbox'/'-test' when it isn't production. */
  readonly source: string;
  readonly configured: boolean;
  initialize(o: { mobile?: string; redirectUrl: string; state: string }): Promise<DlSession>;
  status(clientId: string): Promise<DlStatus>;
  aadhaar(clientId: string): Promise<DlAadhaar>;
  pan(clientId: string, status: DlStatus): Promise<DlPan>;
}

/** A provider call that failed. gone = the session no longer exists or was used up. */
export class ProviderError extends Error {
  constructor(message: string, readonly status = 0, readonly code = '', readonly gone = false) {
    super(message);
  }
}

/** The PAN in a DigiLocker PAN record (an XML Certificate carrying number="ABCDE1234F"). */
export function panNumberIn(file: Buffer): string {
  return /\b([A-Z]{5}\d{4}[A-Z])\b/.exec(file.toString('utf8'))?.[1] ?? '';
}
