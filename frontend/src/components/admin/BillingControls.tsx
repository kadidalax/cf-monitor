import React from 'react';
import { Button, Flex, IconButton, Select, Text, TextField, Tooltip } from '@radix-ui/themes';
import { toast } from 'sonner';
import {
  BILLING_CYCLE_OPTIONS,
  COMMON_CURRENCIES,
  formatBillingCycle,
  getLongTermDateValue,
} from '../../utils/billing';

export function CurrencySymbols({ onPick }: { onPick: (symbol: string) => void }) {
  return (
    <Flex className="currency-symbol-list" gap="1" wrap="wrap" align="center">
      {COMMON_CURRENCIES.map(({ symbol, name }) => (
        <Tooltip key={`${symbol}-${name}`} content={name}>
          <IconButton
            aria-label={`选择${name}`}
            size="1"
            variant="soft"
            className="currency-symbol-button"
            onClick={() => {
              onPick(symbol);
              toast.success(`已设置为${name}`);
            }}
          >
            {symbol}
          </IconButton>
        </Tooltip>
      ))}
    </Flex>
  );
}

export function BillingCycleSelect({
  value,
  onChange,
  label = '计费周期',
}: {
  value: number | string | null | undefined;
  onChange: (value: number) => void;
  label?: string;
}) {
  const selectedValue = String(value || 30);
  const hasPreset = BILLING_CYCLE_OPTIONS.some((option) => String(option.value) === selectedValue);

  return (
    <label>
      <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </Text>
      <Select.Root value={selectedValue} onValueChange={(next) => onChange(parseInt(next, 10))}>
        <Select.Trigger style={{ width: '100%' }} />
        <Select.Content>
          {!hasPreset && (
            <Select.Item value={selectedValue}>
              {formatBillingCycle(Number(selectedValue)) || `${selectedValue}天`}
            </Select.Item>
          )}
          {BILLING_CYCLE_OPTIONS.map((option) => (
            <Select.Item key={option.value} value={String(option.value)}>
              {option.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </label>
  );
}

export function ExpiryDateInput({
  value,
  onChange,
  label = '到期时间',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label>
      <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </Text>
      <TextField.Root
        style={{ width: '100%' }}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type="date"
      >
        <TextField.Slot side="right">
          <Button type="button" size="1" variant="ghost" onClick={() => onChange(getLongTermDateValue())}>
            设为长期
          </Button>
        </TextField.Slot>
      </TextField.Root>
    </label>
  );
}
