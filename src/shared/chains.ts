// Display names for NEAR Intents blockchain identifiers. Unknown chains fall
// back to the provider's identifier in capitals.
const NAMES: Record<string, string> = {
	eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain",
	avax: "Avalanche", gnosis: "Gnosis", bera: "Berachain", abs: "Abstract", scroll: "Scroll", hood: "Robinhood Chain",
	monad: "Monad", plasma: "Plasma", xlayer: "X Layer", sol: "Solana", btc: "Bitcoin", ltc: "Litecoin",
	doge: "Dogecoin", bch: "Bitcoin Cash", xrp: "XRP Ledger", tron: "Tron", ton: "TON", sui: "Sui",
	aptos: "Aptos", near: "NEAR", stellar: "Stellar", starknet: "Starknet", cardano: "Cardano", zec: "Zcash",
	miden: "Miden",
};

export function chainName(chain: string): string {
	return NAMES[chain] ?? chain.toUpperCase();
}
