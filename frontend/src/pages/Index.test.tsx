import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiUnavailableNotice, mobileNodeCardGridTemplateColumns, nodeCardGridTemplateColumns, TopCard } from './Index';

describe('public dashboard node grid', () => {
  it('uses a denser four-column desktop grid and two-column mobile grid', () => {
    expect(nodeCardGridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    expect(mobileNodeCardGridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('places status card icons before the label text', () => {
    const html = renderToStaticMarkup(
      <TopCard
        title="Current time"
        value="20:10"
        detail="now"
        icon={<span data-testid="stat-icon" />}
      />,
    );

    expect(html.indexOf('monitor-stat-icon')).toBeLessThan(html.indexOf('Current time'));
  });

  it('renders a clear Worker API failure notice instead of a generic empty state', () => {
    const html = renderToStaticMarkup(<ApiUnavailableNotice error="HTTP 500" />);

    expect(html).toContain('无法连接 Worker API');
    expect(html).toContain('HTTP 500');
    expect(html).toContain('D1 migration');
  });
});
