import React, { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Flex, Text } from '@radix-ui/themes';
import { Globe, Settings } from 'lucide-react';

const settingsTabs = [
  { path: '/admin/settings', label: '站点设置', icon: <Globe size={16} /> },
  { path: '/admin/settings/general', label: '通用设置', icon: <Settings size={16} /> },
];

export interface SettingsLayoutOutletContext {
  setAction: (action: React.ReactNode) => void;
}

export default function SettingsLayout() {
  const location = useLocation();
  const [action, setAction] = useState<React.ReactNode>(null);

  const isActive = (tab: typeof settingsTabs[0]) => {
    if (tab.path === '/admin/settings') {
      return location.pathname === '/admin/settings' || location.pathname === '/admin/settings/site';
    }
    return location.pathname === tab.path || location.pathname.startsWith(`${tab.path}/`);
  };

  return (
    <div className="admin-settings-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Settings size={20} />
          <Text size="5" weight="bold">系统设置</Text>
        </Flex>
      </Flex>

      <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3" mb="3">
        <Flex className="admin-subnav-row" gap="1">
          {settingsTabs.map(tab => {
            const active = isActive(tab);
            return (
              <Link
                key={tab.path}
                to={tab.path}
                className={`admin-subnav-link${active ? ' active' : ''}`}
              >
                {tab.icon}
                {tab.label}
              </Link>
            );
          })}
        </Flex>
        {action && <Flex className="admin-subnav-actions" align="center" gap="2">{action}</Flex>}
      </Flex>

      <Outlet context={{ setAction }} />
    </div>
  );
}
