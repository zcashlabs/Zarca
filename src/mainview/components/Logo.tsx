export function Logo({ size = 28 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
			<defs>
				<linearGradient id="zarca-g" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--accent-strong)" />
					<stop offset="1" stopColor="var(--accent)" />
				</linearGradient>
			</defs>
			<rect width="32" height="32" rx="9" fill="url(#zarca-g)" />
			<path d="M10 10.5h12l-11 11h12" fill="none" stroke="var(--accent-text)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M16 7.5v3M16 21.5v3" stroke="var(--accent-text)" strokeWidth="2.6" strokeLinecap="round" />
		</svg>
	);
}
