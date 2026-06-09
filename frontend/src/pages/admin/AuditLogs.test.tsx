import { describe, expect, it } from 'vitest';
import { formatAuditLogDetailPreview, getAuditLogDetailText } from './AuditLogs';

describe('audit log detail formatting', () => {
  it('keeps empty or missing details from crashing the audit log page', () => {
    expect(getAuditLogDetailText(null)).toBe('-');
    expect(getAuditLogDetailText(undefined)).toBe('-');
    expect(getAuditLogDetailText('')).toBe('-');
  });

  it('clips long details for the table preview', () => {
    const detail = 'a'.repeat(121);

    expect(formatAuditLogDetailPreview(detail)).toBe(`${'a'.repeat(120)}...`);
  });
});
