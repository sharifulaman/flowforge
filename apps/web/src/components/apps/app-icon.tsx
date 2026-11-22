import {
  Box,
  Building2,
  CalendarClock,
  Code,
  FlaskConical,
  Filter,
  Globe,
  Hash,
  Mail,
  MessageCircle,
  Rss,
  Send,
  Sheet,
  Timer,
  Webhook,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Explicit map keeps the bundle small (no "import every icon"). Unknown names fall back to a letter. */
const ICONS: Record<string, LucideIcon> = {
  Box,
  Building2,
  CalendarClock,
  Code,
  FlaskConical,
  Filter,
  Globe,
  Hash,
  Mail,
  MessageCircle,
  Rss,
  Send,
  Sheet,
  Timer,
  Webhook,
  Wrench,
};

export function AppIcon({
  app,
  size = 'md',
  className,
}: {
  app: { name: string; icon: string; color: string } | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const box = size === 'sm' ? 'size-6 rounded-md' : size === 'lg' ? 'size-11 rounded-xl' : 'size-8 rounded-lg';
  const glyph = size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4';
  if (!app) return <span className={cn(box, 'inline-flex shrink-0 bg-muted', className)} />;
  const Icon = ICONS[app.icon];
  return (
    <span
      className={cn(box, 'inline-flex shrink-0 items-center justify-center text-white shadow-sm ring-1 ring-black/5', className)}
      style={{ backgroundColor: app.color }}
      aria-hidden
    >
      {Icon ? <Icon className={glyph} /> : <span className="text-xs font-semibold">{app.name[0]}</span>}
    </span>
  );
}
