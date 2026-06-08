import { describe, expect, it } from 'vitest';
import { ClientInfo, LiveDataMap } from '../types';
import {
  filterMonitorNodes,
  getNodeGroups,
  getNodeStatsSummary,
  normalizeLiveData,
  sortAdminNodes,
} from './monitorView';

const clients: ClientInfo[] = [
  {
    uuid: 'a',
    name: 'Tokyo Edge',
    cpu_name: 'AMD',
    cpu_cores: 4,
    os: 'Ubuntu 24.04',
    arch: 'x86_64',
    ipv4: '1.1.1.1',
    ipv6: '',
    region: 'JP',
    mem_total: 100,
    swap_total: 0,
    disk_total: 200,
    group: 'Asia',
    tags: 'premium',
    hidden: false,
    price: 5,
    billing_cycle: 30,
    currency: 'USD',
    expired_at: '',
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    remark: 'edge node',
    public_remark: '',
  },
  {
    uuid: 'b',
    name: 'Frankfurt Core',
    cpu_name: 'Intel',
    cpu_cores: 8,
    os: 'Debian 12',
    arch: 'x86_64',
    ipv4: '2.2.2.2',
    ipv6: '',
    region: 'DE',
    mem_total: 200,
    swap_total: 0,
    disk_total: 400,
    group: 'Europe',
    tags: 'stable',
    hidden: false,
    price: 8,
    billing_cycle: 30,
    currency: 'EUR',
    expired_at: '',
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    remark: '',
    public_remark: 'core',
  },
  {
    uuid: 'c',
    name: 'Seattle Backup',
    cpu_name: 'Intel',
    cpu_cores: 2,
    os: 'Windows Server',
    arch: 'x86_64',
    ipv4: '3.3.3.3',
    ipv6: '',
    region: 'US',
    mem_total: 100,
    swap_total: 0,
    disk_total: 150,
    group: 'America',
    tags: 'backup',
    hidden: false,
    price: 4,
    billing_cycle: 30,
    currency: 'USD',
    expired_at: '',
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    remark: '',
    public_remark: '',
  },
];

const liveData: LiveDataMap = {
  online: ['a', 'b'],
  data: {
    a: {
      cpu: 80,
      ram: 70,
      ram_total: 100,
      swap: 0,
      swap_total: 0,
      disk: 100,
      disk_total: 200,
      net_in: 10,
      net_out: 20,
      net_total_up: 100,
      net_total_down: 200,
      load: 0,
      temp: 0,
      uptime: 1000,
      process_count: 0,
      connections: 0,
      connections_udp: 0,
    },
    b: {
      cpu: 20,
      ram: 40,
      ram_total: 200,
      swap: 0,
      swap_total: 0,
      disk: 50,
      disk_total: 400,
      net_in: 5,
      net_out: 7,
      net_total_up: 50,
      net_total_down: 90,
      load: 0,
      temp: 0,
      uptime: 2000,
      process_count: 0,
      connections: 0,
      connections_udp: 0,
    },
  },
};

describe('normalizeLiveData', () => {
  it('keeps clients from raw clients list visible in online/data maps', () => {
    const normalized = normalizeLiveData({
      online: ['a'],
      clients: [{ uuid: 'b', cpu: 10 }],
      data: {},
    });

    expect(normalized.online).toEqual(['a', 'b']);
    expect(normalized.data.b.cpu).toBe(10);
  });

  it('does not mark D1 fallback clients online when online is explicitly false', () => {
    const normalized = normalizeLiveData({
      online: ['a'],
      clients: [
        { uuid: 'b', cpu: 10, online: false },
        { uuid: 'c', cpu: 20, online: true },
      ],
      data: {},
    });

    expect(normalized.online).toEqual(['a', 'c']);
    expect(normalized.data.b.cpu).toBe(10);
    expect(normalized.data.c.cpu).toBe(20);
  });
});

describe('monitorView', () => {
  it('filters by search, group, and status', () => {
    const result = filterMonitorNodes(clients, liveData, {
      searchTerm: 'core',
      selectedGroup: 'Europe',
      statusFilter: 'online',
    });

    expect(result.map((client) => client.uuid)).toEqual(['b']);
  });

  it('moves offline nodes to the end when requested', () => {
    const result = filterMonitorNodes(clients, liveData, {
      offlinePosition: 'last',
    });

    expect(result.map((client) => client.uuid)).toEqual(['b', 'a', 'c']);
  });

  it('returns sorted admin nodes by cpu descending', () => {
    const result = sortAdminNodes(clients, liveData, {
      sortKey: 'cpu',
      sortDir: 'desc',
    });

    expect(result.map((client) => client.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('builds unique sorted groups and aggregate stats', () => {
    expect(getNodeGroups(clients)).toEqual(['America', 'Asia', 'Europe']);

    expect(getNodeStatsSummary(clients, liveData)).toEqual({
      onlineCount: 2,
      totalCount: 3,
      regionCount: 2,
      totalUp: 150,
      totalDown: 290,
      totalSpeedUp: 15,
      totalSpeedDown: 27,
    });
  });
});
