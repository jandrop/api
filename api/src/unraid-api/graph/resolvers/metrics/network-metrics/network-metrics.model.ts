import { Field, Float, ObjectType } from '@nestjs/graphql';

import { Node } from '@unraid/shared/graphql.model.js';

@ObjectType({
    description: 'Network utilization for a single interface',
})
export class NetworkInterfaceUtilization {
    @Field(() => String, { description: 'Interface name (e.g. eth0, br0, bond0)' })
    iface!: string;

    @Field(() => Float, { description: 'Total bytes received since last interface reset' })
    rxBytes!: number;

    @Field(() => Float, { description: 'Total bytes transmitted since last interface reset' })
    txBytes!: number;

    @Field(() => Float, { description: 'Current receive speed in bytes per second' })
    rxBytesPerSec!: number;

    @Field(() => Float, { description: 'Current transmit speed in bytes per second' })
    txBytesPerSec!: number;
}

@ObjectType({
    implements: () => Node,
    description: 'Snapshot of network utilization across all physical interfaces',
})
export class NetworkUtilization extends Node {
    @Field(() => [NetworkInterfaceUtilization], {
        description: 'Per-interface utilization metrics',
    })
    interfaces!: NetworkInterfaceUtilization[];
}
