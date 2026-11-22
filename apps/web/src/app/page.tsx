'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LogoMark } from '@/components/common/logo';
import { Spinner } from '@/components/ui/spinner';
import { useMe } from '@/hooks/use-auth';

/** Entry point: send the user to their first workspace. */
export default function HomePage() {
  const router = useRouter();
  const { data, isError } = useMe();

  useEffect(() => {
    if (data?.workspaces[0]) router.replace(`/w/${data.workspaces[0].id}`);
    if (isError) router.replace('/login');
  }, [data, isError, router]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 text-muted-foreground">
      <LogoMark className="size-10 animate-pulse" />
      <span className="flex items-center gap-2 text-sm">
        <Spinner /> Loading your workspace…
      </span>
    </div>
  );
}
