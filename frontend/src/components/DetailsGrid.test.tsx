import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DetailsGrid from './DetailsGrid';

describe('DetailsGrid', () => {
  it('keeps long hardware values available as titles when the card clips text', () => {
    const cpu = 'Intel(R) Xeon(R) CPU E3-1270 v3 @ 3.50GHz';
    const html = renderToStaticMarkup(
      <DetailsGrid
        client={{
          cpu_name: cpu,
          cpu_cores: 1,
          arch: 'x86_64',
        }}
        compact
      />,
    );

    expect(html).toContain(`title="${cpu} (x1)"`);
    expect(html).toContain('DetailsGrid-item');
  });
});
