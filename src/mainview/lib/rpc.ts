import { Electroview } from "electrobun/view";
import type { Method, Params, Result, ZarcaRPCSchema } from "../../shared/api";
import type { SessionState, SyncState } from "../../shared/types";

type Listener<T> = (value: T) => void;

class Channel<T> {
	private listeners = new Set<Listener<T>>();
	value: T | null = null;
	emit(value: T) {
		this.value = value;
		for (const listener of this.listeners) listener(value);
	}
	subscribe(listener: Listener<T>) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export const sessionChannel = new Channel<SessionState>();
export const syncChannel = new Channel<SyncState>();
export const changeChannel = new Channel<number>();

const rpc = Electroview.defineRPC<ZarcaRPCSchema>({
	maxRequestTime: 10 * 60_000,
	handlers: {
		messages: {
			session: (state) => sessionChannel.emit(state),
			sync: (state) => syncChannel.emit(state),
			changed: ({ revision }) => changeChannel.emit(revision),
		},
	},
});

// Instantiating Electroview connects the view to the Bun process.
export const electrobun = new Electroview({ rpc });

export class RpcError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcError";
	}
}

export async function call<M extends Method>(method: M, ...args: Params<M> extends void ? [] : [Params<M>]): Promise<Result<M>> {
	const response = await rpc.request.invoke({ method, params: args[0] ?? null });
	if (!response.ok) throw new RpcError(response.error, response.code);
	return response.value as Result<M>;
}

// Inactivity tracking: tell the Bun process about user activity, throttled.
let lastPing = 0;
const ping = () => {
	const now = Date.now();
	if (now - lastPing < 20_000) return;
	lastPing = now;
	try {
		rpc.send.activity({ at: now });
	} catch {
		// Not connected yet.
	}
};
for (const event of ["pointerdown", "keydown", "wheel", "pointermove"] as const) {
	window.addEventListener(event, ping, { passive: true, capture: true });
}
