import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { CheekuForwardSendsService } from './cheeku-forward-sends.service';

/**
 * The link in the grahak's SMS: opens the picture of their slip, the same one that went on WhatsApp.
 * No sign-in (the grahak has none) — the 10-letter random code is the key, and it stops opening after
 * 90 days or once the slip is cancelled.
 */
@Controller('b')
export class CheekuBillLinkController {
  constructor(private readonly sends: CheekuForwardSendsService) {}

  @Get(':code')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'private, max-age=300')
  async bill(@Param('code') code: string) {
    const png = await this.sends.linkImage(code);
    if (!png) throw new NotFoundException('Yeh bill nahi mila');
    return new StreamableFile(png);
  }
}
