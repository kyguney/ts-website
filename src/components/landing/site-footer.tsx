import Link from 'next/link';
import Image from 'next/image';
import { BrandLogo } from '@/components/brand-logo';

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Markets', href: '#markets' },
      { label: 'Signals', href: '#signals' },
      { label: 'Demo Portfolio', href: '#demo' },
      { label: 'Pricing', href: '#pricing' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Log In', href: '/login' },
      { label: 'Sign Up', href: '/register' },
      { label: 'Subscription', href: '/dashboard/billing' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms of Use', href: '/terms' },
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Risk Disclosure', href: '#faq' },
    ],
  },
  {
    title: 'Contact',
    links: [{ label: 'Contact Us', href: 'mailto:info@trendscore.io' }],
  },
];

export function SiteFooter() {
  return (
    <footer className='relative overflow-hidden border-t border-[var(--ts-stroke)] px-4 pb-10 pt-16 lg:min-h-[480px]'>
      {/* Decorative crystalline bull, anchored bottom-right behind the footer
          content (matches the reference mockup). Transparent PNG served
          unoptimized so its alpha channel is preserved. Responsive width. */}
      <Image
        src='/footer-bg-transparent.webp'
        alt=''
        aria-hidden
        width={2400}
        height={1601}
        unoptimized
        priority={false}
        className='pointer-events-none absolute bottom-0 right-0 z-0 h-auto max-h-[95%] w-[78%] max-w-[760px] select-none object-contain object-right-bottom opacity-25 sm:w-[60%] sm:opacity-30 lg:w-[50%]'
      />

      <div className='relative z-10 mx-auto max-w-6xl'>
        <div className='grid gap-10 md:grid-cols-[1.5fr_repeat(4,1fr)]'>
          <div>
            <BrandLogo height={96} />
            <p className='mt-3 max-w-xs text-xs text-[var(--ts-text-muted)]'>
              Trade Smarter. Score Higher. Crypto market intelligence, trend scores, and long/short
              signals in one clear view.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className='text-xs font-semibold uppercase tracking-wide text-[var(--ts-text-muted)]'>
                {col.title}
              </h4>
              <ul className='mt-3 space-y-2 text-sm'>
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className='text-[var(--ts-text)] transition-colors hover:text-[var(--ts-emerald)]'
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className='mt-12 flex flex-col items-start justify-between gap-2 border-t border-(--ts-stroke) pt-6 text-xs text-(--ts-text-muted)'>
          <p>© {new Date().getFullYear()} TrendScore. All rights reserved.</p>
          <p className='max-w-md sm:text-left'>
            Crypto trading involves risk. Demo results do not guarantee future returns.
          </p>
          <p>Not financial advice.</p>
        </div>
      </div>
    </footer>
  );
}
