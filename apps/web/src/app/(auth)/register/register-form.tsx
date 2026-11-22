'use client';

import { type RegisterInput, registerSchema } from '@flowforge/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { FormField } from '@/components/auth/form-field';
import { GoogleButton } from '@/components/auth/google-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useRegister } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api-client';
import { safeReturnTo } from '@/lib/redirect';

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const register = useRegister();

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const me = await register.mutateAsync(values);
      const first = me.workspaces[0];
      router.replace(returnTo ?? (first ? `/w/${first.id}` : '/'));
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        for (const [field, message] of Object.entries(err.fieldErrors())) {
          form.setError(field as keyof RegisterInput, { message });
        }
        return;
      }
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        form.setError('email', { message: err.message });
        return;
      }
      form.setError('root', { message: err instanceof ApiError ? err.message : 'Something went wrong' });
    }
  });

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">Start automating in under a minute.</p>
      </div>

      <GoogleButton returnTo={returnTo} label="Sign up with Google" />

      <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {errors.root?.message && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {errors.root.message}
          </div>
        )}
        <FormField id="name" label="Full name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" placeholder="Ada Lovelace" aria-invalid={!!errors.name} {...form.register('name')} />
        </FormField>
        <FormField id="email" label="Work email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            aria-invalid={!!errors.email}
            {...form.register('email')}
          />
        </FormField>
        <FormField
          id="password"
          label="Password"
          error={errors.password?.message}
          hint={<span className="text-xs text-muted-foreground">8+ characters</span>}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...form.register('password')}
          />
        </FormField>
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />}
          Create account
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href={returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
