import type { SVGProps } from "react";

/** twain brand marks and the two menu icons: inline SVG in currentColor (twain header brief, section 10). */

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

/** The mark: a plus with one rounded quarter. Square, 140×140 units. */
export function TwainMark({ title, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 140 140" fill="currentColor" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...props}>
      {title && <title>{title}</title>}
      <path d="M56 0H84V56H140V84A56 56 0 0 0 84 140H56V84H0V56A56 56 0 0 0 56 0Z" />
    </svg>
  );
}

/** Raw path of the mark, for places that draw it themselves (OG images). */
export const TWAIN_MARK_PATH = "M56 0H84V56H140V84A56 56 0 0 0 84 140H56V84H0V56A56 56 0 0 0 56 0Z";

/** The wordmark "twain" (the dot of the i is the mark). 2811×1059 units. */
export function TwainWordmark({ title, ...props }: IconProps) {
  return (
    <svg viewBox="5.0 -1041.1 2811.0 1059.1" fill="currentColor" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...props}>
      {title && <title>{title}</title>}
      <path d="M315 7Q240 7 191.5 -12.5Q143 -32 119.0 -78.5Q95 -125 95 -204L96 -696H226L225 -195Q225 -155 246.5 -133.5Q268 -112 308 -112H393V7ZM9 -441V-543H393V-441Z" />
      <path d="M696 0 799 -525H959L1078 0H968L847 -522H905L798 0ZM655 0 654 -114H765V0ZM599 0 451 -543H586L727 0ZM1003 0V-114H1114L1113 0ZM1047 0 1172 -543H1298L1167 0Z" />
      <path d="M1729 0V-161H1706V-340Q1706 -387 1683.0 -410.0Q1660 -433 1612 -433Q1587 -433 1552.0 -432.0Q1517 -431 1481.5 -429.5Q1446 -428 1418 -426V-544Q1441 -546 1470.0 -548.0Q1499 -550 1529.5 -550.5Q1560 -551 1587 -551Q1671 -551 1726.5 -529.0Q1782 -507 1810.5 -460.0Q1839 -413 1839 -337V0ZM1554 14Q1495 14 1450.5 -7.0Q1406 -28 1381.5 -67.0Q1357 -106 1357 -161Q1357 -221 1386.5 -259.0Q1416 -297 1469.5 -316.0Q1523 -335 1595 -335H1721V-252H1593Q1545 -252 1519.5 -228.5Q1494 -205 1494 -168Q1494 -131 1519.5 -108.0Q1545 -85 1593 -85Q1622 -85 1646.5 -95.5Q1671 -106 1687.5 -131.5Q1704 -157 1706 -201L1740 -162Q1735 -105 1712.5 -66.0Q1690 -27 1650.5 -6.5Q1611 14 1554 14Z" />
      <path d="M2014 0V-543H2153V0ZM1938 -439V-543H2153V-439Z" />
      <path d="M2313 0V-543H2423V-310H2413Q2413 -393 2435.0 -448.5Q2457 -504 2500.5 -532.0Q2544 -560 2609 -560H2615Q2712 -560 2762.0 -497.5Q2812 -435 2812 -311V0H2673V-323Q2673 -373 2644.5 -404.0Q2616 -435 2566 -435Q2515 -435 2483.5 -403.5Q2452 -372 2452 -319V0Z" />
      <path d="M2076.98 -1037.13 H2153.00 V-885.09 H2305.04 V-809.07 A152.04 152.04 0 0 0 2153.00 -657.03 H2076.98 V-809.07 H1924.94 V-885.09 A152.04 152.04 0 0 0 2076.98 -1037.13 Z" />
    </svg>
  );
}

/** Burger: two horizontal lines, 18 px, stroke 2. */
export function IconMenu(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden {...props}>
      <path d="M4 8h16M4 16h16" />
    </svg>
  );
}

/** Close: a cross, 18 px, stroke 2. */
export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
