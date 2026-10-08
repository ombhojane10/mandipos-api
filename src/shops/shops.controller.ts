import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UdhaarAlertsService } from '../alerts/udhaar-alerts.service';
import { AccountsService } from '../auth/accounts.service';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse, phone } from '../common/validate';

const CreateShopBody = z.object({
  name: z.string().trim().min(1).max(120),
  mandi: z.string().trim().max(80).default(''),
  shopNo: z.string().trim().max(20).default(''),
  // Stall numbers, printed under the firm name on every slip.
  phad: z.string().trim().max(40).default(''),
  gstin: z.string().trim().toUpperCase().max(15).default(''),
  role: z.enum(['owner', 'manager', 'munim']).default('owner'),
  ownerName: z.string().trim().max(80).default(''),
  // What the shop sells. Tender coconut is every shop so far; amrud is sold on commission.
  commodity: z.enum(['nariyal', 'amrud']).default('nariyal'),
});

const JoinBody = z.object({ code: z.string().regex(/^\d{6}$/, 'must be the 6-digit shop code') });
const role = z.enum(['admin', 'accountant']);
const AddMemberBody = z.object({ phone, name: z.string().trim().max(80).default(''), role: role.default('accountant') });
const RoleBody = z.object({ role });
const UserId = z.uuid();
const BankAccount = z.object({
  holder: z.string().trim().max(80).default(''),
  bank: z.string().trim().max(80).default(''),
  ifsc: z.string().trim().toUpperCase().max(11).default(''),
  account: z.string().trim().max(34).default(''),
});
const LedgerBody = z.object({
  address: z.string().trim().max(200).default(''),
  bankAccounts: z.array(BankAccount).max(4).default([]),
});
const LimitBody = z.object({ slipLimitPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

@Controller('v1/shops')
@UseGuards(AuthGuard)
export class ShopsController {
  constructor(private readonly accounts: AccountsService, private readonly alerts: UdhaarAlertsService) {}

  /** Registers the caller's shop and attaches this device; returns an access token that carries the shop. */
  @Post()
  create(@Me() p: Principal, @Body() body: unknown) {
    return this.accounts.createShop(p, parse(CreateShopBody, body));
  }

  /** Joins an existing shop by its 6-digit code, as an accountant. */
  @Post('join')
  @HttpCode(200)
  join(@Me() p: Principal, @Body() body: unknown) {
    return this.accounts.joinShop(p, parse(JoinBody, body).code);
  }

  /** The team: everyone sees who is in it; only an admin gets the join code. */
  @Get('members')
  team(@Me() p: Principal) {
    return this.accounts.team(p);
  }

  /** Admin: adds a mobile number; that person's first login opens this shop. */
  @Post('members')
  @HttpCode(204)
  async add(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(AddMemberBody, body);
    await this.accounts.addMember(p, b.phone, b.name, b.role);
  }

  /** Admin: make admin, or back to accountant. */
  @Patch('members/:userId')
  @HttpCode(204)
  async setRole(@Me() p: Principal, @Param('userId') userId: string, @Body() body: unknown) {
    await this.accounts.setRole(p, parse(UserId, userId), parse(RoleBody, body).role);
  }

  /** The same as POST, because Android's HttpURLConnection cannot send PATCH. */
  @Post('members/:userId/role')
  @HttpCode(204)
  async setRoleByPost(@Me() p: Principal, @Param('userId') userId: string, @Body() body: unknown) {
    await this.accounts.setRole(p, parse(UserId, userId), parse(RoleBody, body).role);
  }

  /** Admin: takes someone off the team and shuts their devices out. */
  @Delete('members/:userId')
  @HttpCode(204)
  async remove(@Me() p: Principal, @Param('userId') userId: string) {
    await this.accounts.removeMember(p, parse(UserId, userId));
  }

  /** Admin: the morning udhaar WhatsApp — on or off, and who would get one today. */
  @Get('udhaar-alerts')
  udhaarAlerts(@Me() p: Principal) {
    return this.alerts.preview(p);
  }

  /** Admin: send one grahak their udhaar message now, as a test. */
  @Post('udhaar-alerts/test')
  @HttpCode(200)
  udhaarAlertTest(@Me() p: Principal, @Body() body: unknown) {
    return this.alerts.sendTest(p, parse(z.object({ buyerId: UserId }), body).buyerId);
  }

  @Post('udhaar-alerts')
  @HttpCode(204)
  async setUdhaarAlerts(@Me() p: Principal, @Body() body: unknown) {
    await this.alerts.setOn(p, parse(z.object({ on: z.boolean() }), body).on);
  }

  /** Admin: the parchi limit above which an accountant's slip needs approval (0 = none). */
  @Post('slip-limit')
  @HttpCode(204)
  async slipLimit(@Me() p: Principal, @Body() body: unknown) {
    await this.accounts.setSlipLimit(p, parse(LimitBody, body).slipLimitPaise);
  }

  /** Admin: the address and bank accounts at the head of every customer ledger. All optional. */
  @Post('ledger-details')
  @HttpCode(204)
  async ledgerDetails(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(LedgerBody, body);
    // A row with nothing typed in it is left out rather than printed blank.
    const accounts = b.bankAccounts.filter((a) => a.holder || a.bank || a.ifsc || a.account);
    await this.accounts.setLedgerDetails(p, b.address, accounts);
  }

  /** Admin: what the shop sells; every terminal follows it on its next /v1/me. */
  @Post('commodity')
  @HttpCode(204)
  async commodity(@Me() p: Principal, @Body() body: unknown) {
    await this.accounts.setCommodity(p, parse(z.object({ commodity: z.enum(['nariyal', 'amrud']) }), body).commodity);
  }

  /** Any member: the shop's WiFi printer, which every device of the shop then prints to. */
  @Post('printer')
  @HttpCode(204)
  async printer(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({
      host: z.string().trim().regex(/^(\d{1,3}(\.\d{1,3}){3})?$/, 'an IP like 192.168.1.50'),
      dots: z.union([z.literal(384), z.literal(576), z.literal(832)]).default(576),
    }), body);
    await this.accounts.setPrinter(p, b.host, b.dots);
  }

  /** Admin: the mobile number printed on the shop's slips. */
  @Post('phone')
  @HttpCode(204)
  async shopPhone(@Me() p: Principal, @Body() body: unknown) {
    await this.accounts.setShopPhone(p, parse(z.object({ phone }), body).phone);
  }

  /** Admin: a new join code; the old one stops working. */
  @Post('join-code')
  @HttpCode(200)
  newCode(@Me() p: Principal) {
    return this.accounts.newJoinCode(p);
  }
}
