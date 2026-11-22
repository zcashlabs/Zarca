import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Method, Params, Result } from "../../shared/api";
import { call, changeChannel, sessionChannel, syncChannel } from "./rpc";

export function useSession() {
	return useSyncExternalStore(
		(cb) => sessionChannel.subscribe(cb),
		() => sessionChannel.value,
	);
}

export function useSync() {
	return useSyncExternalStore(
		(cb) => syncChannel.subscribe(cb),
		() => syncChannel.value,
	);
}

export function useRevision() {
	return useSyncExternalStore(
		(cb) => changeChannel.subscribe(cb),
		() => changeChannel.value ?? 0,
	);
}

export interface Query<T> {
	data: T | undefined;
	error: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
}

/** Fetches an RPC method; refetches when domain data changes or `deps` change. */
export function useQuery<M extends Method>(method: M, params?: Params<M>, deps: unknown[] = [], enabled = true): Query<Result<M>> {
	const [data, setData] = useState<Result<M>>();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const revision = useRevision();
	const sequence = useRef(0);
	const key = JSON.stringify(params ?? null);

	const refresh = useCallback(async () => {
		if (!enabled) return;
		const id = ++sequence.current;
		try {
			const value = await (call as (m: Method, p?: unknown) => Promise<Result<M>>)(method, params);
			if (id === sequence.current) {
				setData(value);
				setError(null);
			}
		} catch (e) {
			if (id === sequence.current) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (id === sequence.current) setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [method, key, enabled]);

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh, revision, ...deps]);

	return { data, error, loading: loading && data === undefined, refresh };
}

/** Runs an action with pending and error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = useCallback(
		async (...args: A): Promise<R | undefined> => {
			setPending(true);
			setError(null);
			try {
				return await fn(...args);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				return undefined;
			} finally {
				setPending(false);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[fn],
	);
	return { run, pending, error, setError };
}

export function useInterval(fn: () => void, ms: number) {
	const saved = useRef(fn);
	saved.current = fn;
	useEffect(() => {
		const id = setInterval(() => saved.current(), ms);
		return () => clearInterval(id);
	}, [ms]);
}
