import { CheckCircle2Icon } from 'lucide-react';
import { Logo } from '@/components/common/logo';
import { ThemeToggle } from '@/components/common/theme-toggle';

const POINTS = [
  'Connect Slack, Google Sheets, Telegram, email and any HTTP API',
  'Map data between steps with a visual field picker',
  'Retries, timeouts and full run history out of the box',
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,560px)]">
      <aside className="relative hidden overflow-hidden border-r bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 -left-40 size-[36rem] rounded-full bg-primary/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 -bottom-48 size-[30rem] rounded-full bg-violet-500/15 blur-3xl"
        />
        <Logo className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            Automate the busywork. Keep the flow.
          </h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-3 text-sm text-muted-foreground">
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">© {new Date().getFullYear()} FlowForge</p>
      </aside>

      <main className="relative flex flex-col">
        <div className="flex items-center justify-between p-4 lg:justify-end">
          <Logo className="lg:hidden" />
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-2 duration-500">{children}</div>
        </div>
      </main>
    </div>
  );
}
