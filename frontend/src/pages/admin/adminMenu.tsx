import React from 'react';
import {
  Activity,
  AtSign,
  Bell,
  Bolt,
  CalendarClock,
  Ellipsis,
  Globe,
  MessageCircleMore,
  ScrollText,
  Server,
  TrendingUp,
  Unplug,
  User,
} from 'lucide-react';

export interface AdminMenuItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  children?: AdminMenuItem[];
  external?: boolean;
}

export const adminMenuItems: AdminMenuItem[] = [
  { path: '/admin', label: '服务器', icon: <Server size={18} /> },
  {
    path: '/admin/settings',
    label: '系统设置',
    icon: <Bolt size={18} />,
    children: [
      { path: '/admin/settings', label: '站点设置', icon: <Globe size={16} /> },
      { path: '/admin/settings/general', label: '通用设置', icon: <Ellipsis size={16} /> },
    ],
  },
  {
    path: '/admin/notifications',
    label: '通知管理',
    icon: <Bell size={18} />,
    children: [
      { path: '/admin/notifications/settings', label: '通知设置', icon: <MessageCircleMore size={16} /> },
      { path: '/admin/notifications/offline', label: '离线通知', icon: <Unplug size={16} /> },
      { path: '/admin/notifications/expiry', label: '到期通知', icon: <CalendarClock size={16} /> },
      { path: '/admin/notifications/load', label: '负载通知', icon: <TrendingUp size={16} /> },
    ],
  },
  { path: '/admin/ping', label: '延迟监测', icon: <Activity size={18} /> },
  { path: '/admin/logs', label: '审计日志', icon: <ScrollText size={18} /> },
  { path: '/admin/account', label: '账户', icon: <User size={18} /> },
  { path: '/admin/about', label: '关于', icon: <AtSign size={18} /> },
];

export function isAdminMenuPathActive(itemPath: string, currentPath: string) {
  if (itemPath === '/admin/settings') return currentPath.startsWith('/admin/settings');
  if (itemPath === '/admin/notifications') {
    return currentPath.startsWith('/admin/notifications') ||
      currentPath.startsWith('/admin/notification');
  }
  if (itemPath === '/admin') return currentPath === '/admin' || currentPath.startsWith('/admin/clients');
  return currentPath === itemPath;
}
