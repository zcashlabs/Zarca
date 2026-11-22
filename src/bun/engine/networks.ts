// Consensus schedules for the networks Zarca supports. The built-in zcash.js
// presets predate NU7 activation (zcashlabs/zcashjs#30), so Zarca supplies full
// definitions. A wallet database is bound to these exact bytes.
import { blockHash, defineNetwork, encodeNetworkParameters, type Network } from "@zcashlabs/zcash.js";
import type { NetworkName } from "../../shared/types";

const schedules = {
	mainnet: {
		genesisHash: "00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08",
		parameters: {
			encoding: "main", Overwinter: 347500, Sapling: 419200, Blossom: 653600, Heartwood: 903000,
			Canopy: 1046400, Nu5: 1687104, Nu6: 2726400, Nu6_1: 3146400, Nu6_2: 3364600, Nu6_3: 3428143,
			Nu7: 3543405,
		},
	},
	testnet: {
		genesisHash: "05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38",
		parameters: {
			encoding: "test", Overwinter: 207500, Sapling: 280000, Blossom: 584000, Heartwood: 903800,
			Canopy: 1028500, Nu5: 1842420, Nu6: 2976000, Nu6_1: 3536500, Nu6_2: 4052000, Nu6_3: 4134000,
			Nu7: 4465026,
		},
	},
} as const;

export const DEFAULT_SERVERS: Record<NetworkName, string> = {
	mainnet: "https://zec.rocks:443",
	testnet: "https://testnet.zec.rocks:443",
};

const cache = new Map<NetworkName, Promise<Network>>();

export function networkFor(name: NetworkName): Promise<Network> {
	let network = cache.get(name);
	if (!network) {
		const schedule = schedules[name];
		network = defineNetwork({
			identity: name === "mainnet" ? "zcash-mainnet" : "zcash-testnet",
			genesisHash: blockHash(schedule.genesisHash),
			...encodeNetworkParameters(schedule.parameters),
		});
		cache.set(name, network);
	}
	return network;
}

/** Block spacing changed from 75 s to 25 s at NU7. */
export function nu7Height(name: NetworkName): number {
	return schedules[name].parameters.Nu7;
}
