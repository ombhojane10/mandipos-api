import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
});

const JoinBody = z.object({ code: z.string().regex(/^\d{6}$/, 'must be the 6-digit shop code') });
const role = z.enum(['admin', 'accountant']);
const AddMemberBody = z.object({ phone, name: z.string().trim().max(80).default(''), role: role.default('accountant') });
const RoleBody = z.object({ role });
const UserId = z.uuid();

@Controller('v1/shops')
@UseGuards(AuthGuard)
export class ShopsController {
  constructor(private readonly accounts: AccountsService) {}

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

  /**
   * Admin: make admin, or back to accountant. Also as POST .../role, because Android's
   * HttpURLConnection cannot send PATCH.
   */
  @Patch('members/:userId')
  @Post('members/:userId/role')
  @HttpCode(204)
  async setRole(@Me() p: Principal, @Param('userId') userId: string, @Body() body: unknown) {
    await this.accounts.setRole(p, parse(UserId, userId), parse(RoleBody, body).role);
  }

  /** Admin: takes someone off the team and shuts their devices out. */
  @Delete('members/:userId')
  @HttpCode(204)
  async remove(@Me() p: Principal, @Param('userId') userId: string) {
    await this.accounts.removeMember(p, parse(UserId, userId));
  }

  /** Admin: a new join code; the old one stops working. */
  @Post('join-code')
  @HttpCode(200)
  newCode(@Me() p: Principal) {
    return this.accounts.newJoinCode(p);
  }
}
