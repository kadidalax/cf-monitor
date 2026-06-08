import { formatBytes, formatSpeed } from './format';

export const defaultStatusCardVisibility = {
  currentTime: true,
  currentOnline: true,
  regionOverview: true,
  trafficOverview: true,
  networkSpeed: true,
} as const;

export type StatusCardKey = keyof typeof defaultStatusCardVisibility;

export interface DashboardStatusInput {
  currentTime: string;
  onlineCount: number;
  totalCount: number;
  regionCount: number;
  totalUp: number;
  totalDown: number;
  totalSpeedUp: number;
  totalSpeedDown: number;
}

export interface DashboardStatusCard {
  key: StatusCardKey;
  title: string;
  value: string;
  detail: string;
  oneLine?: boolean;
  inlineValues?: string[];
}

export function buildDashboardStatusCards(input: DashboardStatusInput): DashboardStatusCard[] {
  const trafficValues = [`↑ ${formatBytes(input.totalUp)}`, `↓ ${formatBytes(input.totalDown)}`];
  const speedValues = [`↑ ${formatSpeed(input.totalSpeedUp)}`, `↓ ${formatSpeed(input.totalSpeedDown)}`];

  return [
    {
      key: 'currentTime',
      title: '当前时间',
      value: input.currentTime,
      detail: '本地浏览器时间',
      oneLine: true,
    },
    {
      key: 'currentOnline',
      title: '当前在线',
      value: `${input.onlineCount} / ${input.totalCount}`,
      detail: '在线节点 / 全部节点',
      oneLine: true,
    },
    {
      key: 'regionOverview',
      title: '点亮地区',
      value: String(input.regionCount),
      detail: '当前在线地区数',
    },
    {
      key: 'trafficOverview',
      title: '流量概览',
      value: trafficValues.join('  '),
      detail: '累计上传 / 下载',
      inlineValues: trafficValues,
    },
    {
      key: 'networkSpeed',
      title: '网络速率',
      value: speedValues.join('  '),
      detail: '实时上传 / 下载',
      inlineValues: speedValues,
    },
  ];
}
