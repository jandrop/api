import { Module } from '@nestjs/common';

import { NetworkMetricsService } from '@app/unraid-api/graph/resolvers/metrics/network-metrics/network-metrics.service.js';

@Module({
    providers: [NetworkMetricsService],
    exports: [NetworkMetricsService],
})
export class NetworkMetricsModule {}