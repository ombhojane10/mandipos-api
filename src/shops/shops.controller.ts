import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AccountsService } from '../auth/accounts.service';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';

const CreateShopBody = z.object({
  name: z.string().trim().min(1).max(120),
  mandi: z.string().trim().max(80).default(''),
  shopNo: z.string().trim().max(20).default(''),
  // Stall numbers, printed under the firm name on every slip.
  fard: z.string().trim().max(40).default(''),
  gstin: z.string().trim().toUpperCase().max(15).default(''),
  role: z.enum(['owner', 'manager', 'munim']).default('owner'),
  ownerName: z.string().trim().max(80).default(''),
});

@Controller('v1/shops')
@UseGuards(AuthGuard)
export class ShopsController {
  constructor(private readonly accounts: AccountsService) {}

  /** Registers the caller's shop and attaches this device; returns an access token that carries the shop. */
  @Post()
  create(@Me() p: Principal, @Body() body: unknown) {
    return this.accounts.createShop(p, parse(CreateShopBody, body));
  }
}
