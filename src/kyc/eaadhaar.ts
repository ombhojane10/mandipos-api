/**
 * The e-Aadhaar DigiLocker hands back: UIDAI's signed KycRes XML. We read the few fields the
 * counter shows; the XML itself is kept (encrypted) as the proof, signature and all.
 *
 *   <KycRes ts=".." ttl=".."><UidData uid="xxxxxxxx1234">
 *     <Poi name dob gender/> <Poa co house street lm loc vtc dist state pc country/>
 *     <Pht>base64 JPEG</Pht></UidData></KycRes>
 */
export type EAadhaar = {
  /** As UIDAI sends it: masked except the last four digits. */
  uidMasked: string;
  last4: string;
  name: string;
  /** DD-MM-YYYY as UIDAI writes it. */
  dob: string;
  gender: string;
  careOf: string;
  address: string;
  pincode: string;
  photo: Buffer | null;
  /** When UIDAI issued this KYC (DigiLocker may serve one from an earlier consent). */
  issuedAt: string;
};

export function parseEAadhaar(xml: string): EAadhaar | null {
  const uidData = attrs(xml, 'UidData');
  const poi = attrs(xml, 'Poi');
  if (!uidData || !poi?.name) return null;
  const poa = attrs(xml, 'Poa') ?? {};
  const uid = uidData.uid ?? '';
  const pht = /<Pht>([^<]+)<\/Pht>/.exec(xml)?.[1]?.replace(/\s+/g, '');
  const photo = pht ? Buffer.from(pht, 'base64') : null;
  const address = [poa.house, poa.street, poa.lm, poa.loc, poa.vtc, poa.subdist, poa.dist, poa.state]
    .map((s) => (s ?? '').trim())
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join(', ');
  return {
    uidMasked: uid,
    last4: uid.replace(/\D/g, '').slice(-4),
    name: poi.name,
    dob: poi.dob ?? '',
    gender: poi.gender ?? '',
    careOf: poa.co ?? '',
    address: poa.pc ? `${address} - ${poa.pc}` : address,
    pincode: poa.pc ?? '',
    photo: photo && photo.length > 3 && photo[0] === 0xff && photo[1] === 0xd8 ? photo : null,
    issuedAt: attrs(xml, 'KycRes')?.ts ?? '',
  };
}

function attrs(xml: string, tag: string): Record<string, string> | null {
  const m = new RegExp(`<${tag}((?:\\s+[\\w:]+="[^"]*")*)\\s*/?>`).exec(xml);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, k, v] of m[1].matchAll(/([\w:]+)="([^"]*)"/g)) out[k] = unescape(v);
  return out;
}

function unescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
