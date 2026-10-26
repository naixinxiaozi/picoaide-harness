import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, ClientPrincipal } from '../common/decorators';
import { TelemetryService } from './telemetry.service';

/** 员工面遥测上报（Bearer）。 */
@Controller('api/client/v2/telemetry')
@UseGuards(BearerAuthGuard)
export class TelemetryController {
  constructor(private readonly svc: TelemetryService) {}

  @Post('skill-call')
  @HttpCode(HttpStatus.OK)
  skillCall(@CurrentUser() user: ClientPrincipal, @Body() body: unknown) {
    return this.svc.reportSkillCall(user, body);
  }

  @Post('error-reporting')
  @HttpCode(HttpStatus.OK)
  errorReporting(@CurrentUser() user: ClientPrincipal, @Body() body: unknown) {
    return this.svc.reportErrorReporting(user, body);
  }
}
