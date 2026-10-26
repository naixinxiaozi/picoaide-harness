import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { ClientReleaseService } from './client-release.service';
import { ClientReleaseController, ClientReleaseFileController } from './client-release.controller';

/** 客户端安装包下发域：清单 + 静态下载。依赖 ChannelService（渠道 id）。 */
@Module({
  imports: [ChannelModule],
  providers: [ClientReleaseService],
  controllers: [ClientReleaseController, ClientReleaseFileController],
})
export class ClientReleaseModule {}
