import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import NodeCard from './NodeCard';
import { ClientInfo, LiveRecord } from '../types';
import { formatUptime } from '../utils/format';

const client: ClientInfo = {
  uuid: 'node-a',
  name: 'Tokyo Edge',
  cpu_name: 'AMD EPYC',
  cpu_cores: 4,
  os: 'Debian 12',
  arch: 'x86_64',
  ipv4: '1.1.1.1',
  ipv6: '',
  region: 'JP',
  mem_total: 8 * 1024 * 1024 * 1024,
  swap_total: 0,
  disk_total: 64 * 1024 * 1024 * 1024,
  group: 'Asia',
  tags: '',
  hidden: false,
  price: 0,
  billing_cycle: 30,
  currency: 'USD',
  expired_at: '',
  traffic_limit: 0,
  traffic_limit_type: 'sum',
};

const live: LiveRecord = {
  cpu: 56,
  ram: 3 * 1024 * 1024 * 1024,
  ram_total: 8 * 1024 * 1024 * 1024,
  swap: 0,
  swap_total: 0,
  disk: 18 * 1024 * 1024 * 1024,
  disk_total: 64 * 1024 * 1024 * 1024,
  net_in: 233600,
  net_out: 435000,
  net_total_up: 5 * 1024 * 1024 * 1024,
  net_total_down: 9 * 1024 * 1024 * 1024,
  load: 0,
  temp: 0,
  uptime: 3600,
  process_count: 0,
  connections: 0,
  connections_udp: 0,
};

describe('NodeCard monitor layouts', () => {
  it('renders the monitor resource-ring layout alongside the next compact layout', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={client} live={live} online />
      </MemoryRouter>,
    );

    expect(html).toContain('data-monitor-layout="next"');
    expect(html).toContain('data-monitor-layout="monitor"');
    expect(html.match(/data-monitor-role="resource-ring"/g)).toHaveLength(3);
    expect(html).toContain('data-monitor-role="network-panel"');
  });

  it('anchors the region flag at the top-left of the card', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={client} live={live} online />
      </MemoryRouter>,
    );
    const flagIndex = html.indexOf('data-monitor-role="node-region-flag"');
    const titleIndex = html.indexOf(client.name);

    expect(flagIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeLessThan(titleIndex);
    expect(html).toContain('/assets/flags/JP.svg');
  });

  it('summarizes speed and total traffic in the network panel without repeating uptime', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={client} live={live} online />
      </MemoryRouter>,
    );
    const panelStart = html.indexOf('data-monitor-role="network-panel"');
    const networkPanelHtml = html.slice(panelStart);

    expect(panelStart).toBeGreaterThan(-1);
    expect(networkPanelHtml).toContain('data-monitor-role="network-speed-summary"');
    expect(networkPanelHtml).toContain('data-monitor-role="network-traffic-summary"');
    expect(networkPanelHtml).toContain('网络速率');
    expect(networkPanelHtml).toContain('总流量');
    expect(networkPanelHtml).not.toContain(formatUptime(live.uptime));
  });

  it('uses live total values for next theme usage bars when client totals are missing', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard
          client={{ ...client, mem_total: 0, disk_total: 0 }}
          live={{ ...live, ram: 4, ram_total: 8, disk: 40, disk_total: 80 }}
          online
        />
      </MemoryRouter>,
    );

    expect(html.match(/style="width:50%"/g)).toHaveLength(2);
  });

  it('keeps billing metadata in the title row with a reserved slot', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={{ ...client, price: 0, expired_at: '' }} live={live} online />
      </MemoryRouter>,
    );
    const titleIndex = html.indexOf(client.name);
    const billingSlotIndex = html.indexOf('node-card-billing-slot');
    const metaIndex = html.indexOf('node-card-komari-title-meta');

    expect(billingSlotIndex).toBeGreaterThan(titleIndex);
    expect(billingSlotIndex).toBeLessThan(metaIndex);
  });

  it('keeps the next theme fourth metric as monthly traffic instead of connections', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={{ ...client, traffic_limit: 0 }} live={{ ...live, connections: 12, connections_udp: 3 }} online />
      </MemoryRouter>,
    );
    const nextLayoutStart = html.indexOf('data-monitor-layout="next"');
    const nextLayoutEnd = html.indexOf('data-monitor-role="network-panel"', nextLayoutStart);
    const nextMetricsHtml = html.slice(nextLayoutStart, nextLayoutEnd);

    expect(nextMetricsHtml).toContain('月度');
    expect(nextMetricsHtml).toContain('未设置');
    expect(nextMetricsHtml).not.toContain('连接');
  });

  it('shows monitor ring details as capacity specs instead of duplicate percentages', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodeCard client={client} live={live} online />
      </MemoryRouter>,
    );

    expect(html).toContain('4核');
    expect(html).toContain('3.0 GB / 8.0 GB');
    expect(html).toContain('18.0 GB / 64.0 GB');
  });
});
