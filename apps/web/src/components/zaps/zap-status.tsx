import type { ZapStatus } from '@flowforge/shared';
import { Badge } from '@/components/ui/badge';

const MAP: Record<ZapStatus, { label: string; variant: 'success' | 'secondary' | 'outline' | 'destructive' }> = {
  ACTIVE: { label: 'On', variant: 'success' },
  PAUSED: { label: 'Off', variant: 'secondary' },
  DRAFT: { label: 'Draft', variant: 'outline' },
  ERROR: { label: 'Error · off', variant: 'destructive' },
};

export function ZapStatusBadge({ status }: { status: ZapStatus }) {
  const s = MAP[status];
  return (
    <Badge variant={s.variant} data-testid="zap-status">
      {status === 'ACTIVE' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </Badge>
  );
}
