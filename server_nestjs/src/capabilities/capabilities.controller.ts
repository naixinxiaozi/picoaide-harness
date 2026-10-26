import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { CapabilitiesService } from './capabilities.service';

@Controller('api/client/v2/capabilities')
@UseGuards(BearerAuthGuard)
export class CapabilitiesController {
  constructor(private readonly caps: CapabilitiesService) {}

  @Get()
  async list(
    @Query('source') source: string | undefined,
    @Query('type') type: string | undefined,
    @CurrentUser() user: ClientPrincipal,
  ) {
    const items = await this.caps.list(
      { source, type },
      user.username,
      user.role,
      user.userId,
    );
    return { items };
  }
}
