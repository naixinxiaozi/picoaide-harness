import { Module } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { ChannelController } from './channel.controller';

/** 渠道域：员工面渠道内容/素材下发（管理面网关渠道注册表由 providers 域负责）。 */
@Module({
  providers: [ChannelService],
  controllers: [ChannelController],
  exports: [ChannelService],
})
export class ChannelModule {}
