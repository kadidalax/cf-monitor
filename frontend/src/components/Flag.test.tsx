import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Flag from './Flag';

describe('Flag', () => {
  it('renders ISO country codes as local flag SVGs', () => {
    const html = renderToStaticMarkup(<Flag region="US" size={18} />);

    expect(html).toContain('/assets/flags/US.svg');
  });

  it('renders flag emoji values as local flag SVGs', () => {
    const html = renderToStaticMarkup(<Flag region="🇩🇪" size={18} />);

    expect(html).toContain('/assets/flags/DE.svg');
  });

  it('maps common location names to local flag SVGs', () => {
    const html = renderToStaticMarkup(<Flag region="硅谷" size={18} />);

    expect(html).toContain('/assets/flags/US.svg');
  });
});
