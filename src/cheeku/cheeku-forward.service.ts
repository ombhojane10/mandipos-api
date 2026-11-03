import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { uuidv7 } from '../common/uuid';
import { Db } from '../db/db.service';
import { EntriesService } from '../admin/entries.service';
import { LIVE_BILLS, n } from '../admin/sql';
import { CHEEKU_CAPS_NAMES, requireCheeku } from './cheeku';
import { CheekuForwardSendsService, type SendState } from './cheeku-forward-sends.service';

export type PersonalBillInput = { rates: Record<string, number>; bhadaPaise: number; mazdooriPaise: number; commissionPaise: number };

/** What a personal bill adds up to: goods at the shop's rates, less the charges, against what the boxes cost. */
export function billFigures(lines: { qty: number; ratePaise: number; costRatePaise: number }[], c: { bhadaPaise: number; mazdooriPaise: number; commissionPaise: number }) {
  const goodsPaise = lines.reduce((t, l) => t + l.qty * l.ratePaise, 0);
  const chargesPaise = c.bhadaPaise + c.mazdooriPaise + c.commissionPaise;
  const costKnown = lines.length > 0 && lines.every((l) => l.costRatePaise > 0);
  const costPaise = costKnown ? lines.reduce((t, l) => t + l.qty * l.costRatePaise, 0) : null;
  const netPaise = goodsPaise - chargesPaise;
  return {
    goodsPaise, chargesPaise, netPaise, costPaise,
    // + a profit, - a loss; null when a gaadi's buying rate was never entered.
    profitPaise: costPaise === null ? null : netPaise - costPaise,
  };
}

export type ForwardInput = {
  /** The grahak the maal goes to: a name, and a mobile (kept with the name, so it is typed once). Both may be left out. */
  customer?: { name: string; mobile: string };
  lots: { truckId: string; brandId: string; qty: number; ratePaise: number }[];
  vehicle: string; staff?: string;
};

/**
 * Cheeku's "aage bhejna": maal that came in on a gaadi from a supplier goes on to a grahak —
 * supplier → shop → grahak. It adds no table of its own for the sale: it is an ordinary cheeku
 * cash parchi (so the boxes leave the gaadi's stock and the shop keeps its own slip, with the
 * bhav), plus a lading_slips row for the vehicle. A grahak typed with a mobile is kept with that
 * mobile, found by name next time. What goes with the maal is a second slip built from the same
 * bill that carries no money at all — only the grahak, the vehicle, the quality and the boxes —
 * and the QR the gaadi scans. The shop's own working bill (rates, bhada, mazdoori, commission,
 * profit or loss) lives in forward_bills and never touches the slip.
 */
@Injectable()
export class CheekuForwardService {
  constructor(private readonly db: Db, private readonly modules: ModuleRef, private readonly sends: CheekuForwardSendsService) {}

  /** The shared plumbing (the parchi write, the website's device, pushing rows), looked up when first used. */
  private get e(): EntriesService {
    return this.modules.get(EntriesService, { strict: false });
  }

  /** Sends boxes off gaadis to a grahak: the shop's own slip (with bhav) is written and the vehicle noted. */
  async create(phone: string, shopId: string, input: ForwardInput) {
    await requireCheeku(this.db, shopId);
    const lots = input.lots.filter((l) => l.qty > 0);
    if (!lots.length) throw new BadRequestException('Kam se kam ek quality aur box daalein');
    const name = (input.customer?.name ?? '').trim();
    const mobile = (input.customer?.mobile ?? '').replace(/\D/g, '');
    if (mobile && !name) throw new BadRequestException('Mobile ke saath grahak ka naam bhi likhein');
    if (mobile && !/^[6-9][0-9]{9}$/.test(mobile)) throw new BadRequestException('10 ank ka sahi mobile number likhein');

    // A grahak the shop knows is used with the number it keeps; a number typed over it is a change on purpose.
    let buyerId: string | undefined;
    let buyerName: string | undefined;
    if (name) {
      const shown = CHEEKU_CAPS_NAMES ? name.toUpperCase() : name;
      const known = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string; phone: string }>(
        `SELECT id, phone FROM buyers WHERE hidden = false AND lower(trim(name)) = lower($1) LIMIT 1`, [shown])).rows[0]);
      if (known) {
        buyerId = known.id;
        if (mobile && known.phone !== mobile) await this.e.updateGrahak(phone, shopId, known.id, { phone: mobile });
      } else if (mobile) {
        buyerId = (await this.e.grahak(phone, shopId, { name: shown, phone: mobile })).id;   // kept now: the next slip needs no number
      } else buyerName = shown;
    }
    const r = await this.e.parchi(phone, shopId, {
      buyerId, buyerName, lots, pay: 'cash', packing: 'loose', staff: input.staff,
    }) as { billId: string; slipNo: number };
    const vehicle = input.vehicle.trim().toUpperCase().slice(0, 20);
    await this.e.push(await this.e.device(phone, shopId), shopId, [{
      table: 'lading_slips', txn: uuidv7(), row: { id: uuidv7(), created_at: new Date().toISOString(), bill_id: r.billId, vehicle },
    }]);
    return { billId: r.billId, slipNo: r.slipNo };
  }

  /**
   * Cancels a slip sent on — only while no box has been scanned out against it. The boxes go back
   * on the gaadi and the slip leaves every total (no cash was ever taken, so nothing is refunded).
   */
  async cancel(phone: string, shopId: string, billId: string) {
    await requireCheeku(this.db, shopId);
    const found = await this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query<{ slip_no: number | null }>(
        `SELECT lb.slip_no FROM ${LIVE_BILLS} lb WHERE lb.id = $1 AND EXISTS (SELECT 1 FROM lading_slips ls WHERE ls.bill_id = lb.id)`, [billId])).rows[0];
      if (!b) throw new NotFoundException('Yeh parchi aage bheji hui nahi mili');
      const scanned = n((await tx.query<{ q: string }>(`SELECT COALESCE(SUM(qty), 0) AS q FROM pickups WHERE bill_id = $1`, [billId])).rows[0].q);
      if (scanned > 0) throw new UnprocessableEntityException('Maal uth chuka hai — yeh parchi ab radd nahi ho sakti');
      return b;
    });
    await this.e.push(await this.e.device(phone, shopId), shopId, [{
      table: 'bill_voids', txn: uuidv7(), row: { id: uuidv7(), created_at: new Date().toISOString(), bill_id: billId, slip_no: found.slip_no, reason: 'deleted' },
    }]);
    return { cancelled: true };
  }

  /**
   * Every slip sent on, each with the shop's personal bill: the boxes at the shop's own rates (the
   * slip's until edited), bhada, mazdoori and commission, the net, and the profit or loss against
   * the gaadi's buying rate; and whether any box has been scanned out. Newest first.
   */
  async ledger(shopId: string) {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const bills = (await tx.query<{
        id: string; slip_no: number | null; day: string; buyer_id: string | null; buyer_name: string; phone: string | null; vehicle: string; total: string; scanned: string;
        rates: Record<string, number> | null; bhada: string | null; mazdoori: string | null; commission: string | null; edited_at: Date | null; edited_by: string | null;
        wa_status: string | null; wa_force: boolean | null; wa_tries: number | null; wa_error: string | null; sms_status: string | null; sms_force: boolean | null; sms_error: string | null;
      }>(
        `SELECT lb.id, lb.slip_no, lb.business_date::text AS day, lb.buyer_id, lb.buyer_name, u.phone, lb.total_paise AS total,
                COALESCE((SELECT ls.vehicle FROM lading_slips ls WHERE ls.bill_id = lb.id ORDER BY ls.created_at DESC LIMIT 1), '') AS vehicle,
                COALESCE((SELECT SUM(p.qty) FROM pickups p WHERE p.bill_id = lb.id), 0) AS scanned,
                fb.rates, fb.bhada_paise AS bhada, fb.mazdoori_paise AS mazdoori, fb.commission_paise AS commission, fb.updated_at AS edited_at, fb.updated_by AS edited_by,
                fs.status AS wa_status, fs.force AS wa_force, fs.tries AS wa_tries, fs.error AS wa_error,
                fs.sms_status, fs.sms_force, fs.sms_error
         FROM ${LIVE_BILLS} lb LEFT JOIN buyers u ON u.id = lb.buyer_id LEFT JOIN forward_bills fb ON fb.bill_id = lb.id
              LEFT JOIN forward_sends fs ON fs.bill_id = lb.id
         WHERE EXISTS (SELECT 1 FROM lading_slips ls WHERE ls.bill_id = lb.id)
         ORDER BY lb.created_at DESC LIMIT 300`)).rows;
      const lines = bills.length ? (await tx.query<{ bill_id: string; brand_id: string; quality: string; qty: string; rate: string; cost: string }>(
        `SELECT l.bill_id, l.brand_id, COALESCE(br.name, '?') AS quality, SUM(l.qty) AS qty, MAX(l.rate_paise) AS rate,
                COALESCE((SELECT MAX(g.rate_paise) FROM truck_grades g WHERE g.truck_id = l.truck_id AND g.brand_id = l.brand_id), 0) AS cost
         FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id
         WHERE l.bill_id = ANY($1::uuid[]) AND NOT l.leak
         GROUP BY l.bill_id, l.brand_id, br.name, l.truck_id ORDER BY MIN(l.created_at)`, [bills.map((b) => b.id)])).rows : [];
      return {
        // Whether the server can send at all (the bot is on and the slip template is set): said once, for the page's banner.
        whatsappOn: this.sends.on(),
        smsOn: this.sends.smsOn(),
        bills: bills.map((b) => {
          const rates = b.rates ?? {};
          // Where this slip's bill stands on WhatsApp.
          const scanned = n(b.scanned) > 0;
          const state: SendState = !b.phone ? 'none' : !b.wa_status ? 'notqueued'
            : b.wa_status === 'sent' ? 'sent' : b.wa_status === 'failed' ? 'failed'
            : b.wa_status === 'sending' || scanned || b.wa_force ? 'pending' : 'onscan';
          // The SMS with the bill link, which goes alongside (slips queued before SMS existed say none).
          const smsState: SendState = !b.phone || b.sms_status === 'none' ? 'none' : !b.sms_status ? 'notqueued'
            : b.sms_status === 'sent' ? 'sent' : b.sms_status === 'failed' ? 'failed'
            : b.sms_status === 'sending' || scanned || b.sms_force ? 'pending' : 'onscan';
          const own = lines.filter((l) => l.bill_id === b.id).map((l) => ({
            brandId: l.brand_id, quality: l.quality, qty: n(l.qty), slipRatePaise: n(l.rate), ratePaise: rates[l.brand_id] ?? n(l.rate), costRatePaise: n(l.cost),
          }));
          const charges = { bhadaPaise: n(b.bhada), mazdooriPaise: n(b.mazdoori), commissionPaise: n(b.commission) };
          return {
            // buyerId: the grahak's record when the slip has one (a name typed without a mobile has none).
            billId: b.id, slipNo: b.slip_no, date: b.day, buyerId: b.buyer_id, person: b.buyer_name, phone: b.phone ?? '', vehicle: b.vehicle,
            slipTotalPaise: n(b.total), scannedBoxes: n(b.scanned),
            whatsapp: { state, tries: b.wa_tries ?? 0, error: b.wa_error ?? '' },
            sms: { state: smsState, error: b.sms_error ?? '' },
            lines: own, ...charges, edited: !!b.edited_at, editedBy: b.edited_by ?? '', ...billFigures(own, charges),
          };
        }),
      };
    });
  }

  /** Saves the shop's personal bill for one slip sent on: its own rate per quality, bhada, mazdoori, commission. */
  async saveBill(shopId: string, billId: string, input: PersonalBillInput, by: string) {
    await requireCheeku(this.db, shopId);
    await this.db.withShop(shopId, async (tx) => {
      const ok = (await tx.query(
        `SELECT 1 FROM ${LIVE_BILLS} lb WHERE lb.id = $1 AND EXISTS (SELECT 1 FROM lading_slips ls WHERE ls.bill_id = lb.id)`, [billId])).rowCount;
      if (!ok) throw new NotFoundException('Yeh parchi aage bheji hui nahi mili');
      const brands = new Set((await tx.query<{ brand_id: string }>(`SELECT DISTINCT brand_id FROM bill_lines WHERE bill_id = $1`, [billId])).rows.map((r) => r.brand_id));
      for (const k of Object.keys(input.rates)) if (!brands.has(k)) throw new BadRequestException('Is parchi par yeh maal nahi hai');
      await tx.query(
        `INSERT INTO forward_bills (shop_id, bill_id, rates, bhada_paise, mazdoori_paise, commission_paise, updated_by, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now())
         ON CONFLICT (shop_id, bill_id) DO UPDATE SET rates = EXCLUDED.rates, bhada_paise = EXCLUDED.bhada_paise,
           mazdoori_paise = EXCLUDED.mazdoori_paise, commission_paise = EXCLUDED.commission_paise, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [shopId, billId, JSON.stringify(input.rates), input.bhadaPaise, input.mazdooriPaise, input.commissionPaise, by.slice(0, 60)]);
    });
    return (await this.ledger(shopId)).bills.find((b) => b.billId === billId)!;
  }

  /**
   * The slip that goes with the maal: the grahak (when one was named), the vehicle, and each
   * quality with its boxes, and the id the gaadi's QR carries. Built from named columns only — no
   * rate, amount, APMC, supplier or gaadi number can be on it.
   */
  async slip(shopId: string, billId: string) {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query<{ slip_no: number | null; day: string; person: string; vehicle: string; shop: string; mandi: string; shop_phone: string }>(
        `SELECT lb.slip_no, lb.business_date::text AS day, lb.buyer_name AS person,
                COALESCE((SELECT ls.vehicle FROM lading_slips ls WHERE ls.bill_id = lb.id ORDER BY ls.created_at DESC LIMIT 1), '') AS vehicle,
                s.name AS shop, s.mandi, s.phone AS shop_phone
         FROM ${LIVE_BILLS} lb JOIN shops s ON s.id = lb.shop_id
         WHERE lb.id = $1 AND EXISTS (SELECT 1 FROM lading_slips ls WHERE ls.bill_id = lb.id)`, [billId])).rows[0];
      if (!b) throw new NotFoundException('Yeh parchi aage bheji hui nahi mili');
      const lines = (await tx.query<{ quality: string; qty: string }>(
        `SELECT COALESCE(br.name, '?') AS quality, SUM(l.qty) AS qty
         FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id WHERE l.bill_id = $1 AND NOT l.leak
         GROUP BY br.name ORDER BY MIN(l.created_at)`, [billId])).rows;
      return {
        billId, slipNo: b.slip_no, date: b.day, from: { name: b.shop, mandi: b.mandi, phone: b.shop_phone },
        grahak: /^cash$/i.test(b.person.trim()) ? '' : b.person, vehicle: b.vehicle,
        lines: lines.map((l) => ({ quality: l.quality, qty: n(l.qty) })),
      };
    });
  }
}
