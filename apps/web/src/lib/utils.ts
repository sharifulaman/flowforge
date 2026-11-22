import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function initials(nameOrEmail: string | null | undefined): string {
  const src = (nameOrEmail ?? '').trim();
  if (!src) return '?';
  const parts = src.includes('@') ? [src[0]!] : src.split(/\s+/).slice(0, 2).map((p) => p[0]!);
  return parts.join('').toUpperCase();
}
