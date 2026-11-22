'use client';

import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMe } from '@/hooks/use-auth';
import { cn, initials } from '@/lib/utils';

export function WorkspaceSwitcher({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading } = useMe();
  const router = useRouter();

  if (isLoading || !data) return <Skeleton className="h-11 w-full" />;
  const current = data.workspaces.find((w) => w.id === workspaceId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-11 w-full items-center gap-2.5 rounded-lg border bg-card px-2.5 text-left shadow-xs transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
          {initials(current?.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{current?.name ?? 'Workspace'}</span>
          <span className="block text-[11px] text-muted-foreground capitalize">{current?.role.toLowerCase()}</span>
        </span>
        <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {data.workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}`)}>
            <span className="flex size-5 items-center justify-center rounded bg-primary/10 text-[10px] font-semibold text-primary">
              {initials(w.name)}
            </span>
            <span className="flex-1 truncate">{w.name}</span>
            <CheckIcon className={cn('size-4', w.id === workspaceId ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
