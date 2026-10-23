import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db } from '../db/db.service';

const MAX_IMAGE_BYTES = 400_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export type ImageSender = (to: string, template: string, params: string[], png: Buffer) => Promise<string>;

/**
 * A slip to its grahak, or a beejak to its party, on WhatsApp from the MandiPlus bot's number:
 * the picture the terminal printed as the header, a short line of what it is as the body. One
 * send per tap — logged before it goes, and the same thing to the same number again within
 * 10 minutes is refused, so a double tap at the counter never sends twice.
 */
@Injectable()
export class SlipSendsService {
  /** Swappable in tests; the real one uploads the PNG and sends the template. */
  sender: ImageSender = (to, template, params, png) => this.sendImageTemplate(to, template, params, png);

  constructor(private readonly db: Db) {}

  async send(p: Principal, kind: 'slip' | 'beejak', refId: string, phone: string, imageBase64: string, params: string[]) {
    const c = config();
    const template = kind === 'slip' ? c.SLIP_TEMPLATE : c.BEEJAK_TEMPLATE;
    if (!template) throw new ConflictException('WhatsApp template abhi approve nahi hui');
    if (!c.WHATSAPP_TOKEN || !c.WHATSAPP_PHONE_NUMBER_ID) throw new ServiceUnavailableException('WhatsApp abhi chalu nahi hai');
    const png = Buffer.from(imageBase64, 'base64');
    if (png.length > MAX_IMAGE_BYTES) throw new BadRequestException('Photo bahut badi hai');
    if (!png.subarray(0, 4).equals(PNG)) throw new BadRequestException('Photo PNG nahi hai');

    const id = await this.db.tx(async (tx) => {
      if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
      const member = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId])).rowCount;
      if (!member) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
      // RLS reads need the shop on the transaction.
      await tx.query(`SELECT set_config('app.shop_id', $1, true)`, [p.shopId]);
      const found = (await tx.query(kind === 'slip' ? `SELECT 1 FROM bills WHERE id = $1` : `SELECT 1 FROM trucks WHERE id = $1`, [refId])).rowCount;
      if (!found) throw new NotFoundException(kind === 'slip' ? 'Yeh parchi nahi mili' : 'Yeh gaadi nahi mili');
      const recent = (await tx.query(
        `SELECT 1 FROM whatsapp_slip_sends WHERE shop_id = $1 AND kind = $2 AND ref_id = $3 AND phone = $4
           AND status <> 'failed' AND created_at > now() - interval '10 minutes'`, [p.shopId, kind, refId, phone])).rowCount;
      if (recent) throw new UnprocessableEntityException('Abhi bheja tha — 10 minute baad dobara');
      const row = uuidv7();
      await tx.query(
        `INSERT INTO whatsapp_slip_sends (id, shop_id, kind, ref_id, phone, sent_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row, p.shopId, kind, refId, phone, p.userId]);
      return row;
    });

    try {
      const wamid = await this.sender(`91${phone}`, template, params, png);
      await this.db.query(`UPDATE whatsapp_slip_sends SET status = 'sent', wa_message_id = $2 WHERE id = $1`, [id, wamid]);
      return { sent: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.db.query(`UPDATE whatsapp_slip_sends SET status = 'failed', error = $2 WHERE id = $1`, [id, msg.slice(0, 500)]);
      throw new ServiceUnavailableException('WhatsApp nahi gaya — thodi der mein phir try karein');
    }
  }

  /** Uploads the PNG to WhatsApp, then sends the template with it as the image header. */
  private async sendImageTemplate(to: string, template: string, params: string[], png: Buffer): Promise<string> {
    const c = config();
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/png');
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'parchi.png');
    const up = await fetch(`https://graph.facebook.com/v21.0/${c.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.WHATSAPP_TOKEN}` }, body: form,
    });
    const media = (await up.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
    if (!up.ok || !media.id) throw new Error(`WhatsApp media ${up.status}: ${media.error?.code ?? ''} ${media.error?.message ?? 'no media id'}`);
    const res = await fetch(`https://graph.facebook.com/v21.0/${c.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: template, language: { code: c.UDHAAR_ALERT_LANG },
          components: [
            { type: 'header', parameters: [{ type: 'image', image: { id: media.id } }] },
            // A parameter may not hold a line break or a run of spaces (Meta 132018).
            { type: 'body', parameters: params.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').trim() || '-' })) },
          ],
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp ${res.status}: ${body.error?.code ?? ''} ${body.error?.message ?? 'no message id'}`);
    return body.messages[0].id;
  }
}
