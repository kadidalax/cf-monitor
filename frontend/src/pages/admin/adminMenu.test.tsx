import { describe, expect, it } from 'vitest';
import { adminMenuItems, getAdminSectionTitle, isAdminChildPathActive, isAdminMenuPathActive } from './adminMenu';

function flattenLabels(items: typeof adminMenuItems): string[] {
  return items.flatMap((item) => [
    item.label,
    ...(item.children?.map((child) => child.label) || []),
  ]);
}

describe('admin menu', () => {
  it('keeps the Worker edition menu scoped to useful Komari features', () => {
    const labels = flattenLabels(adminMenuItems);

    expect(labels).toContain('服务器');
    expect(labels).toContain('系统设置');
    expect(labels).toContain('站点设置');
    expect(labels).toContain('通知设置');
    expect(labels).toContain('通用设置');
    expect(labels).toContain('离线通知');
    expect(labels).toContain('负载通知');
    expect(labels).toContain('延迟监测');
    expect(labels).toContain('审计日志');
    expect(labels).toContain('账户');
    expect(labels).toContain('关于');

    expect(labels).not.toContain('设置');
    expect(labels).not.toContain('主题管理');
    expect(labels).not.toContain('远程执行');
    expect(labels).not.toContain('会话管理');
    expect(labels).not.toContain('文档');
    expect(labels).not.toContain('2FA');
  });

  it('maps legacy notification URLs to the notification section', () => {
    expect(isAdminMenuPathActive('/admin/notifications', '/admin/notification/offline')).toBe(true);
    expect(getAdminSectionTitle('/admin/notification/load')).toBe('负载通知');
  });

  it('keeps settings child highlighting exact between site and general settings', () => {
    expect(isAdminChildPathActive('/admin/settings', '/admin/settings/general')).toBe(false);
    expect(isAdminChildPathActive('/admin/settings/general', '/admin/settings/general')).toBe(true);
    expect(isAdminChildPathActive('/admin/settings', '/admin/settings')).toBe(true);
    expect(isAdminChildPathActive('/admin/settings', '/admin/settings/site')).toBe(true);
  });
});
