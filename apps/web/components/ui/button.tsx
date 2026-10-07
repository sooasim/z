'use client';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './icons';

type Variant = 'default' | 'primary' | 'accent' | 'ghost' | 'outline' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

function cls(variant: Variant, size: Size, block?: boolean, iconOnly?: boolean, extra?: string) {
  return ['btn', variant !== 'default' ? variant : '', size !== 'md' ? size : '', block ? 'block' : '', iconOnly ? 'icon' : '', extra ?? ''].filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  /** Accessible label for icon-only buttons. */
  label?: string;
}

export function Button({ variant = 'default', size = 'md', loading, block, icon, iconRight, label, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  const iconOnly = !children && !!icon;
  return (
    <button type={type} className={cls(variant, size, block, iconOnly, className)} data-loading={loading ? 'true' : undefined} aria-busy={loading || undefined} disabled={disabled || loading} aria-label={iconOnly ? label : undefined} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} />}
    </button>
  );
}

export function ButtonLink({ href, variant = 'default', size = 'md', block, icon, iconRight, children, className, ...rest }: { href: string; variant?: Variant; size?: Size; block?: boolean; icon?: IconName; iconRight?: IconName; children?: ReactNode; className?: string; target?: string; rel?: string; onClick?: () => void; 'aria-label'?: string }) {
  return (
    <Link href={href} className={cls(variant, size, block, !children && !!icon, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} />}
    </Link>
  );
}
