import React, { useCallback, useState } from 'react';
import { Popover } from '@radix-ui/themes';
import MiniPingChart from './MiniPingChart';

interface MiniPingChartFloatProps {
  uuid: string;
  trigger: React.ReactNode;
  chartWidth?: string | number;
  chartHeight?: number;
  limit?: number;
  rangeHours?: number;
}

export default function MiniPingChartFloat({
  uuid,
  trigger,
  chartWidth = 440,
  chartHeight = 260,
  limit = 360,
  rangeHours = 1,
}: MiniPingChartFloatProps) {
  const [open, setOpen] = useState(false);

  const handleTriggerClick = useCallback((event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen((current) => !current);
  }, []);

  const handleTriggerPointerDown = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <span
          onClick={handleTriggerClick}
          onPointerDown={handleTriggerPointerDown}
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {trigger}
        </span>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={8}
        onClick={(event) => event.stopPropagation()}
        style={{
          padding: 0,
          border: 'none',
          boxShadow: 'hsl(206 22% 7% / 35%) 0px 10px 38px -10px, hsl(206 22% 7% / 20%) 0px 10px 20px -15px',
          borderRadius: 'var(--radius-3)',
          zIndex: 5,
          width: chartWidth,
          maxWidth: 'calc(100vw - 24px)',
        }}
      >
        <MiniPingChart uuid={uuid} width="100%" height={chartHeight} limit={limit} rangeHours={rangeHours} />
      </Popover.Content>
    </Popover.Root>
  );
}
