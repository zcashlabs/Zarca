import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { call } from "../lib/rpc";
import { useAction } from "../lib/hooks";
import { Badge, Button, CopyButton, ErrorText, Modal, Mono, Skeleton } from "../components/ui";
import { QrCode } from "../components/domain";

export function ReceiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [address, setAddress] = useState<{ address: string; network: string } | null>(null);
	const load = useAction(async (fresh: boolean) => setAddress(await call("receive.address", { fresh })));
	useEffect(() => {
		if (open) void load.run(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	return (
		<Modal open={open} onClose={onClose} title="Receive ZEC" subtitle="Share this shielded address. Senders and amounts stay private." width={480}
			footer={
				<>
					<Button variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={load.pending} onClick={() => load.run(true)}>New address</Button>
					<Button variant="primary" onClick={onClose}>Done</Button>
				</>
			}
		>
			<div className="flex flex-col items-center">
				{address ? <QrCode value={address.address} /> : <Skeleton className="size-[252px] rounded-2xl" />}
				{address?.network === "testnet" && <Badge tone="warning" className="mt-3">Testnet address</Badge>}
				<div className="mt-4 flex w-full items-start gap-2 rounded-xl border border-border bg-surface-2/60 px-3.5 py-3">
					{address ? <Mono className="flex-1 leading-relaxed">{address.address}</Mono> : <Skeleton className="h-10 flex-1" />}
					{address && <CopyButton text={address.address} label="Copy address" />}
				</div>
				{load.error && <div className="mt-3 w-full"><ErrorText>{load.error}</ErrorText></div>}
				<p className="mt-4 text-center text-xs text-muted">
					A new address can be used for each counterparty; all of them belong to this wallet. Payment links with a requested amount are coming soon.
				</p>
			</div>
		</Modal>
	);
}
