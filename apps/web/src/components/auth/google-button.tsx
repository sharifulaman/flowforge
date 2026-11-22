import { Button } from '@/components/ui/button';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.65Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.6H1.27a12 12 0 0 0 0 10.78l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.53 11.53 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4 3.11C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

/** Full-page navigation (not fetch): the API redirects to Google and back. */
export function GoogleButton({ returnTo, label = 'Continue with Google' }: { returnTo?: string | null; label?: string }) {
  const href = `/api/v1/auth/google${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
  return (
    <Button variant="outline" className="w-full" asChild>
      <a href={href}>
        <GoogleIcon />
        {label}
      </a>
    </Button>
  );
}
