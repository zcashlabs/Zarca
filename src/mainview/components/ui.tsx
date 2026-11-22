import {
	createContext,
	forwardRef,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, X, XCircle } from "lucide-react";
import { call } from "../lib/rpc";
import { initials } from "../lib/format";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

// ---------- Buttons ----------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
	primary: "bg-accent text-accent-text hover:bg-accent-strong shadow-sm disabled:opacity-50",
	secondary: "bg-surface text-text border border-border hover:border-border-strong hover:bg-surface-2 shadow-sm disabled:opacity-50",
	ghost: "text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-40",
	subtle: "bg-surface-2 text-text hover:bg-surface-3 disabled:opacity-50",
	danger: "bg-danger text-white hover:brightness-110 shadow-sm disabled:opacity-50",
};
const sizes: Record<Size, string> = {
	sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
	md: "h-9.5 px-4 text-sm gap-2 rounded-[10px]",
	lg: "h-11 px-5 text-[15px] gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	loading?: boolean;
	icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ variant = "secondary", size = "md", loading, icon, children, className, disabled, ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			type="button"
			disabled={disabled || loading}
			className={cx(
				"inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background,border,color,filter] duration-150 disabled:cursor-not-allowed",
				variants[variant],
				sizes[size],
				className,
			)}
			{...rest}
		>
			{loading ? <Loader2 className="size-4 animate-spin" /> : icon}
			{children}
		</button>
	);
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={cx("inline-flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text", className)}
			{...rest}
		>
			{children}
		</button>
	);
}

// ---------- Form controls ----------

const control =
	"w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 shadow-sm outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; suffix?: ReactNode }>(
	function Input({ className, invalid, suffix, ...rest }, ref) {
		const input = (
			<input ref={ref} className={cx(control, "h-10", invalid && "border-danger focus:border-danger focus:ring-danger/15", suffix ? "pr-16" : "", className)} {...rest} />
		);
		if (!suffix) return input;
		return (
			<div className="relative">
				{input}
				<div className="absolute inset-y-0 right-2 flex items-center">{suffix}</div>
			</div>
		);
	},
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
	function Textarea({ className, invalid, ...rest }, ref) {
		return <textarea ref={ref} className={cx(control, "min-h-20 resize-y py-2 leading-relaxed", invalid && "border-danger", className)} {...rest} />;
	},
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select className={cx(control, "h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9", className)}
			style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23888'%3E%3Cpath stroke-linecap='round' stroke-width='2' d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
			{...rest}>
			{children}
		</select>
	);
}

export function Field({ label, hint, error, children, optional, htmlFor }: {
	label: ReactNode;
	hint?: ReactNode;
	error?: string | null;
	children: ReactNode;
	optional?: boolean;
	htmlFor?: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={htmlFor} className="flex items-baseline justify-between text-[13px] font-medium text-text-2">
				<span>{label}</span>
				{optional && <span className="text-xs font-normal text-muted">Optional</span>}
			</label>
			{children}
			{error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
		</div>
	);
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
	return (
		<label className="flex cursor-pointer items-start gap-3 text-sm text-text-2">
			<span
				className={cx(
					"mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition",
					checked ? "border-accent bg-accent text-accent-text" : "border-border-strong bg-surface",
				)}
			>
				{checked && <Check className="size-3" strokeWidth={3} />}
			</span>
			<input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			<span>{children}</span>
		</label>
	);
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={cx("relative h-5.5 w-9.5 rounded-full transition", checked ? "bg-accent" : "bg-surface-3")}
		>
			<span className={cx("absolute top-0.5 size-4.5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
		</button>
	);
}

export function Segmented<T extends string>({ value, onChange, options, className }: {
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: ReactNode; count?: number }[];
	className?: string;
}) {
	return (
		<div className={cx("inline-flex rounded-[10px] bg-surface-2 p-0.5", className)} role="tablist">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					role="tab"
					aria-selected={value === o.value}
					onClick={() => onChange(o.value)}
					className={cx(
						"flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition",
						value === o.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
					)}
				>
					{o.label}
					{o.count !== undefined && o.count > 0 && (
						<span className={cx("num rounded-full px-1.5 text-[11px]", value === o.value ? "bg-accent-soft text-accent-strong" : "bg-surface-3 text-muted")}>
							{o.count}
						</span>
					)}
				</button>
			))}
		</div>
	);
}

// ---------- Display ----------

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
	return <div className={cx("rounded-2xl border border-border bg-surface shadow-card", padded && "p-5", className)}>{children}</div>;
}

export function CardHeader({ title, action, subtitle }: { title: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
	return (
		<div className="mb-4 flex items-start justify-between gap-4">
			<div>
				<h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
				{subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
			</div>
			{action}
		</div>
	);
}

type Tone = "neutral" | "accent" | "success" | "danger" | "warning" | "info";
const tones: Record<Tone, string> = {
	neutral: "bg-surface-2 text-text-2",
	accent: "bg-accent-soft text-accent-strong",
	success: "bg-success-soft text-success",
	danger: "bg-danger-soft text-danger",
	warning: "bg-warning-soft text-warning",
	info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
	return (
		<span className={cx("inline-flex h-5.5 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium", tones[tone], className)}>
			{dot && <span className="size-1.5 rounded-full bg-current" />}
			{children}
		</span>
	);
}

export function Tag({ children, onRemove, active, onClick }: { children: ReactNode; onRemove?: () => void; active?: boolean; onClick?: () => void }) {
	return (
		<span
			onClick={onClick}
			className={cx(
				"inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition",
				active ? "border-accent bg-accent-soft text-accent-strong" : "border-border bg-surface-2 text-text-2",
				onClick && "cursor-pointer hover:border-border-strong",
			)}
		>
			{children}
			{onRemove && (
				<button type="button" aria-label="Remove tag" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="-mr-1 rounded-full p-0.5 hover:bg-surface-3">
					<X className="size-3" />
				</button>
			)}
		</span>
	);
}

export function TagInput({ value, onChange, suggestions = [], placeholder = "Add a tag" }: {
	value: string[];
	onChange: (tags: string[]) => void;
	suggestions?: string[];
	placeholder?: string;
}) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const add = (tag: string) => {
		const clean = tag.trim();
		if (!clean || value.some((t) => t.toLowerCase() === clean.toLowerCase())) return setText("");
		onChange([...value, clean]);
		setText("");
	};
	const matches = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()) && s.toLowerCase().includes(text.toLowerCase())).slice(0, 6);
	return (
		<div className="relative">
			<div className={cx(control, "flex min-h-10 flex-wrap items-center gap-1.5 px-2 py-1.5")}>
				{value.map((tag) => (
					<Tag key={tag} onRemove={() => onChange(value.filter((t) => t !== tag))}>{tag}</Tag>
				))}
				<input
					value={text}
					onChange={(e) => setText(e.target.value)}
					onFocus={() => setOpen(true)}
					onBlur={() => setTimeout(() => setOpen(false), 120)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							add(text);
						} else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
					}}
					placeholder={value.length ? "" : placeholder}
					className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted/70"
				/>
			</div>
			{open && (matches.length > 0 || text) && (
				<div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop animate-fade">
					{matches.map((s) => (
						<button key={s} type="button" onMouseDown={(e) => { e.preventDefault(); add(s); }} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-2">
							{s}
						</button>
					))}
					{text && !matches.some((m) => m.toLowerCase() === text.toLowerCase()) && (
						<button type="button" onMouseDown={(e) => { e.preventDefault(); add(text); }} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-muted hover:bg-surface-2">
							Create “<span className="text-text">{text.trim()}</span>”
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function Avatar({ name, photo, size = 36 }: { name: string; photo?: string | null; size?: number }) {
	const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
	if (photo) return <img src={photo} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
	return (
		<span
			className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.38,
				background: `color-mix(in oklab, hsl(${hue} 55% 55%) 18%, var(--surface))`,
				color: `color-mix(in oklab, hsl(${hue} 55% 40%) 85%, var(--text))`,
			}}
			aria-hidden
		>
			{initials(name)}
		</span>
	);
}

export function Spinner({ className }: { className?: string }) {
	return <Loader2 className={cx("size-4 animate-spin text-muted", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
	return <div className={cx("skeleton", className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center px-6 py-14 text-center">
			{icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>}
			<h4 className="text-[15px] font-semibold">{title}</h4>
			{children && <p className="mt-1.5 max-w-sm text-[13px] text-muted">{children}</p>}
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}

export function Callout({ tone = "info", title, children, className }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode; className?: string }) {
	const Icon = tone === "danger" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info;
	return (
		<div className={cx("flex gap-3 rounded-xl px-3.5 py-3 text-[13px]", tones[tone], className)}>
			<Icon className="mt-0.5 size-4 shrink-0" />
			<div className="min-w-0 text-text-2">
				{title && <div className="font-semibold text-text">{title}</div>}
				{children}
			</div>
		</div>
	);
}

export function ErrorText({ children }: { children: ReactNode }) {
	if (!children) return null;
	return (
		<div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger animate-fade" role="alert">
			<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
			<span>{children}</span>
		</div>
	);
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<IconButton
			label={copied ? "Copied" : label}
			onClick={async () => {
				await call("system.copy", { text }).catch(() => navigator.clipboard?.writeText(text));
				setCopied(true);
				setTimeout(() => setCopied(false), 1400);
			}}
		>
			{copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
		</IconButton>
	);
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
	return <span data-selectable className={cx("font-mono text-[12.5px] break-all", className)}>{children}</span>;
}

export function KeyValue({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
	return (
		<div className={cx("flex items-start justify-between gap-6 py-2.5", className)}>
			<dt className="shrink-0 text-[13px] text-muted">{label}</dt>
			<dd className="min-w-0 text-right text-[13px] text-text">{children}</dd>
		</div>
	);
}

// ---------- Overlays ----------

export function Modal({ open, onClose, title, subtitle, children, footer, width = 520, dismissible = true }: {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	subtitle?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	width?: number;
	dismissible?: boolean;
}) {
	const titleId = useId();
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && dismissible) onClose();
		};
		window.addEventListener("keydown", onKey);
		const previous = document.activeElement as HTMLElement | null;
		setTimeout(() => ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not([data-close])")?.focus(), 10);
		return () => {
			window.removeEventListener("keydown", onKey);
			previous?.focus?.();
		};
	}, [open, dismissible, onClose]);
	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center p-6">
			<div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-fade" onClick={() => dismissible && onClose()} />
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? titleId : undefined}
				className="relative flex max-h-[calc(100vh-48px)] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-pop"
				style={{ maxWidth: width }}
			>
				{title && (
					<div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
						<div>
							<h2 id={titleId} className="text-base font-semibold tracking-tight">{title}</h2>
							{subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
						</div>
						{dismissible && (
							<IconButton label="Close" data-close onClick={onClose} className="-mr-2 -mt-1">
								<X className="size-4" />
							</IconButton>
						)}
					</div>
				)}
				<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
				{footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-6 py-3.5">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}

export function Drawer({ open, onClose, title, children, footer, width = 480 }: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	width?: number;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-40 flex justify-end">
			<div className="absolute inset-0 bg-black/25 animate-fade" onClick={onClose} />
			<aside role="dialog" aria-modal="true" className="relative flex h-full w-full flex-col border-l border-border bg-surface shadow-pop animate-slide" style={{ maxWidth: width }}>
				<div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
					<div className="min-w-0 text-base font-semibold tracking-tight">{title}</div>
					<IconButton label="Close" onClick={onClose} className="-mr-2">
						<X className="size-4" />
					</IconButton>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
				{footer && <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3.5">{footer}</div>}
			</aside>
		</div>,
		document.body,
	);
}

/** Explicit confirmation screen for destructive or irreversible actions. */
export function Confirm({ open, onClose, onConfirm, title, children, confirmLabel, tone = "danger", pending, error }: {
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
	title: ReactNode;
	children: ReactNode;
	confirmLabel: string;
	tone?: "danger" | "primary";
	pending?: boolean;
	error?: string | null;
}) {
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={title}
			width={440}
			footer={
				<>
					<Button variant="ghost" onClick={onClose} disabled={pending}>Go back</Button>
					<Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={pending}>{confirmLabel}</Button>
				</>
			}
		>
			<div className="space-y-3 text-sm text-text-2">{children}</div>
			{error && <div className="mt-4"><ErrorText>{error}</ErrorText></div>}
		</Modal>
	);
}

// ---------- Toasts ----------

interface ToastItem { id: number; tone: "success" | "danger" | "info"; text: string }
const ToastContext = createContext<(tone: ToastItem["tone"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<ToastItem[]>([]);
	const push = useCallback((tone: ToastItem["tone"], text: string) => {
		const id = Date.now() + Math.random();
		setItems((list) => [...list.slice(-3), { id, tone, text }]);
		setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4200);
	}, []);
	return (
		<ToastContext.Provider value={push}>
			{children}
			{createPortal(
				<div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2" aria-live="polite">
					{items.map((t) => (
						<div key={t.id} className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] shadow-pop animate-pop">
							{t.tone === "success" ? <CheckCircle2 className="size-4 text-success" /> : t.tone === "danger" ? <XCircle className="size-4 text-danger" /> : <Info className="size-4 text-info" />}
							{t.text}
						</div>
					))}
				</div>,
				document.body,
			)}
		</ToastContext.Provider>
	);
}
