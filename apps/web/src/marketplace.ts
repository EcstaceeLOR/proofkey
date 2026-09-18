import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers';
import {
  allMachineMetadata,
  isMachineMetadata,
  type MachineMetadata,
} from './machine-metadata.js';

interface MarketplaceConfig {
  creditcoinRpcUrl: string;
  sepoliaRpcUrl: string;
  machineRegistryAddress: string;
  registryAddress: string;
  creditcoinRegistryDeploymentBlock: number;
  sepoliaRegistryDeploymentBlock: number;
  workerUrl: string;
}

export const machineRegistryEvents = new Interface([
  'event MachineRegistered(bytes32 indexed machineId,address indexed owner,address indexed controller,bytes32 metadataHash,uint128 tariff,bool active)',
  'event MachineControllerUpdated(bytes32 indexed machineId,address indexed controller)',
  'event MachineMetadataUpdated(bytes32 indexed machineId,bytes32 metadataHash)',
  'event MachineTariffUpdated(bytes32 indexed machineId,uint128 tariff)',
  'event MachineStatusUpdated(bytes32 indexed machineId,bool active)',
]);
export const paymentRegistryEvents = new Interface([
  'event MachineOfferSet(bytes32 indexed machineId,address indexed beneficiary,uint128 pricePerSecond,bool active)',
]);

const machineAbi = [
  'function machines(bytes32) view returns (address owner,address controller,bytes32 metadataHash,uint128 tariff,bool active)',
] as const;
const paymentAbi = [
  'function machineOffers(bytes32) view returns (address beneficiary,uint128 pricePerSecond,bool active)',
  'function paymentToken() view returns (address)',
] as const;
const tokenAbi = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

export interface ReplayLog {
  blockNumber: number;
  transactionIndex?: number;
  index: number;
  transactionHash: string;
  topics: readonly string[];
  data: string;
}
export interface RegistryMachine {
  machineId: string;
  owner: string;
  controller: string;
  metadataHash: string;
  tariff: bigint;
  active: boolean;
  registeredAtBlock: number;
  updatedAtBlock: number;
}
export interface RegistryOffer {
  machineId: string;
  beneficiary: string;
  pricePerSecond: bigint;
  active: boolean;
  updatedAtBlock: number;
}
export type MarketplaceStatus =
  'available' | 'inactive' | 'unsynchronized' | 'metadata-invalid';
export interface MarketplaceMachine extends RegistryMachine {
  metadata?: MachineMetadata;
  metadataValid: boolean;
  offer?: RegistryOffer;
  synchronized: boolean;
  status: MarketplaceStatus;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
}
export interface MarketplaceSnapshot {
  machines: MarketplaceMachine[];
  creditcoinBlock: number;
  sepoliaBlock: number;
}
export interface MarketplaceFilters {
  query: string;
  category: string;
  location: string;
  availability: string;
  sort: 'availability' | 'price-asc' | 'price-desc' | 'newest';
  page: number;
  pageSize: number;
}

function ordered(logs: readonly ReplayLog[]) {
  return [...logs].sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) ||
      a.index - b.index,
  );
}

export function replayMachineLogs(logs: readonly ReplayLog[]) {
  const machines = new Map<string, RegistryMachine>();
  for (const log of ordered(logs)) {
    const event = machineRegistryEvents.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!event) continue;
    const machineId = (event.args.machineId as string).toLowerCase();
    if (event.name === 'MachineRegistered') {
      machines.set(machineId, {
        machineId,
        owner: getAddress(event.args.owner as string),
        controller: getAddress(event.args.controller as string),
        metadataHash: event.args.metadataHash as string,
        tariff: event.args.tariff as bigint,
        active: event.args.active as boolean,
        registeredAtBlock: log.blockNumber,
        updatedAtBlock: log.blockNumber,
      });
      continue;
    }
    const machine = machines.get(machineId);
    if (!machine) continue;
    if (event.name === 'MachineControllerUpdated')
      machine.controller = getAddress(event.args.controller as string);
    if (event.name === 'MachineMetadataUpdated')
      machine.metadataHash = event.args.metadataHash as string;
    if (event.name === 'MachineTariffUpdated')
      machine.tariff = event.args.tariff as bigint;
    if (event.name === 'MachineStatusUpdated')
      machine.active = event.args.active as boolean;
    machine.updatedAtBlock = log.blockNumber;
  }
  return machines;
}

export function replayOfferLogs(logs: readonly ReplayLog[]) {
  const offers = new Map<string, RegistryOffer>();
  for (const log of ordered(logs)) {
    const event = paymentRegistryEvents.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!event || event.name !== 'MachineOfferSet') continue;
    const machineId = (event.args.machineId as string).toLowerCase();
    offers.set(machineId, {
      machineId,
      beneficiary: getAddress(event.args.beneficiary as string),
      pricePerSecond: event.args.pricePerSecond as bigint,
      active: event.args.active as boolean,
      updatedAtBlock: log.blockNumber,
    });
  }
  return offers;
}

export function metadataMatches(metadata: MachineMetadata, digest: string) {
  return (
    keccak256(toUtf8Bytes(metadata.uri)).toLowerCase() === digest.toLowerCase()
  );
}

export function reconcileMarketplace(
  registryMachines: ReadonlyMap<string, RegistryMachine>,
  offers: ReadonlyMap<string, RegistryOffer>,
  token: { address: string; decimals: number; symbol: string },
  metadataCatalog: readonly MachineMetadata[] = allMachineMetadata(),
) {
  return [...registryMachines.values()]
    .map<MarketplaceMachine>((machine) => {
      const metadata = metadataCatalog.find((item) =>
        metadataMatches(item, machine.metadataHash),
      );
      const offer = offers.get(machine.machineId);
      const metadataValid = Boolean(metadata);
      const synchronized = Boolean(
        offer &&
        offer.beneficiary.toLowerCase() === machine.owner.toLowerCase() &&
        offer.pricePerSecond === machine.tariff &&
        offer.active === machine.active,
      );
      const status: MarketplaceStatus = !metadataValid
        ? 'metadata-invalid'
        : !synchronized
          ? 'unsynchronized'
          : !machine.active || !offer?.active
            ? 'inactive'
            : 'available';
      return {
        ...machine,
        metadata,
        metadataValid,
        offer,
        synchronized,
        status,
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        tokenSymbol: token.symbol,
      };
    })
    .sort((a, b) => b.registeredAtBlock - a.registeredAtBlock);
}

export function filterMarketplace(
  machines: readonly MarketplaceMachine[],
  filters: MarketplaceFilters,
) {
  const needles = filters.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matching = machines.filter((machine) => {
    const metadata = machine.metadata;
    const searchable = [
      metadata?.name,
      metadata?.description,
      metadata?.category,
      metadata?.location.city,
      metadata?.location.country,
      metadata?.location.site,
      machine.machineId,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return (
      (needles.length === 0 ||
        needles.every((needle) => searchable.includes(needle))) &&
      (!filters.category || metadata?.category === filters.category) &&
      (!filters.location || metadata?.location.city === filters.location) &&
      (!filters.availability || machine.status === filters.availability)
    );
  });
  matching.sort((a, b) => {
    if (filters.sort === 'price-asc')
      return Number(
        (a.offer?.pricePerSecond ?? 0n) - (b.offer?.pricePerSecond ?? 0n),
      );
    if (filters.sort === 'price-desc')
      return Number(
        (b.offer?.pricePerSecond ?? 0n) - (a.offer?.pricePerSecond ?? 0n),
      );
    if (filters.sort === 'newest')
      return b.registeredAtBlock - a.registeredAtBlock;
    return Number(b.status === 'available') - Number(a.status === 'available');
  });
  const totalPages = Math.max(1, Math.ceil(matching.length / filters.pageSize));
  const page = Math.min(Math.max(1, filters.page), totalPages);
  return {
    items: matching.slice(
      (page - 1) * filters.pageSize,
      page * filters.pageSize,
    ),
    total: matching.length,
    page,
    totalPages,
  };
}

export class MarketplaceClient {
  private readonly creditcoin: JsonRpcProvider;
  private readonly sepolia: JsonRpcProvider;
  constructor(private readonly config: MarketplaceConfig) {
    this.creditcoin = new JsonRpcProvider(config.creditcoinRpcUrl, 102031, {
      staticNetwork: true,
    });
    this.sepolia = new JsonRpcProvider(config.sepoliaRpcUrl, 11155111, {
      staticNetwork: true,
    });
  }
  async load(): Promise<MarketplaceSnapshot> {
    const [creditcoinChainId, sepoliaChainId, creditcoinBlock, sepoliaBlock] =
      await Promise.all([
        this.creditcoin.send('eth_chainId', []),
        this.sepolia.send('eth_chainId', []),
        this.creditcoin.getBlockNumber(),
        this.sepolia.getBlockNumber(),
      ]);
    if (BigInt(creditcoinChainId as string) !== 102031n)
      throw new Error('Machine registry RPC is not CC3 testnet 102031.');
    if (BigInt(sepoliaChainId as string) !== 11155111n)
      throw new Error('Payment registry RPC is not Ethereum Sepolia 11155111.');
    const machineTopics = [
      'MachineRegistered',
      'MachineControllerUpdated',
      'MachineMetadataUpdated',
      'MachineTariffUpdated',
      'MachineStatusUpdated',
    ].map((name) => machineRegistryEvents.getEvent(name)!.topicHash);
    const machineLogs = await this.creditcoin.getLogs({
      address: this.config.machineRegistryAddress,
      topics: [machineTopics],
      fromBlock: this.config.creditcoinRegistryDeploymentBlock,
      toBlock: creditcoinBlock,
    });
    const machines = replayMachineLogs(machineLogs);
    const offers = new Map<string, RegistryOffer>();
    const machineRegistry = new Contract(
      this.config.machineRegistryAddress,
      machineAbi,
      this.creditcoin,
    );
    const paymentRegistry = new Contract(
      this.config.registryAddress,
      paymentAbi,
      this.sepolia,
    );
    await Promise.all(
      [...machines.values()].map(async (machine) => {
        const current = await machineRegistry.getFunction('machines')(
          machine.machineId,
        );
        Object.assign(machine, {
          owner: getAddress(current.owner as string),
          controller: getAddress(current.controller as string),
          metadataHash: current.metadataHash as string,
          tariff: current.tariff as bigint,
          active: current.active as boolean,
        });
      }),
    );
    // Avoid a deep Sepolia eth_getLogs backfill here. Public RPC endpoints may
    // reject archive log scans, and the current offer state is authoritative.
    await Promise.all(
      [...machines.keys()].map(async (machineId) => {
        const current =
          await paymentRegistry.getFunction('machineOffers')(machineId);
        if (
          (current.beneficiary as string) ===
          '0x0000000000000000000000000000000000000000'
        )
          return;
        offers.set(machineId, {
          machineId,
          beneficiary: getAddress(current.beneficiary as string),
          pricePerSecond: current.pricePerSecond as bigint,
          active: current.active as boolean,
          updatedAtBlock: sepoliaBlock,
        });
      }),
    );
    const tokenAddress = getAddress(
      (await paymentRegistry.getFunction('paymentToken')()) as string,
    );
    const tokenContract = new Contract(tokenAddress, tokenAbi, this.sepolia);
    const [decimals, symbol] = await Promise.all([
      tokenContract.getFunction('decimals')(),
      tokenContract.getFunction('symbol')(),
    ]);
    const metadataCatalog = [...allMachineMetadata()];
    const localCommitments = new Set(
      metadataCatalog.map((item) =>
        keccak256(toUtf8Bytes(item.uri)).toLowerCase(),
      ),
    );
    const remote = await Promise.all(
      [...machines.values()]
        .filter(
          (machine) =>
            !localCommitments.has(machine.metadataHash.toLowerCase()),
        )
        .map((machine) => this.loadRemoteMetadata(machine.metadataHash)),
    );
    metadataCatalog.push(
      ...remote.filter((item): item is MachineMetadata => Boolean(item)),
    );
    return {
      machines: reconcileMarketplace(
        machines,
        offers,
        {
          address: tokenAddress,
          decimals: Number(decimals),
          symbol: symbol as string,
        },
        metadataCatalog,
      ),
      creditcoinBlock,
      sepoliaBlock,
    };
  }

  private async loadRemoteMetadata(commitment: string) {
    try {
      const response = await fetch(
        `${this.config.workerUrl}/metadata/commitments/${commitment}`,
      );
      if (!response.ok) return undefined;
      const metadata = (await response.json()) as unknown;
      return isMachineMetadata(metadata) &&
        metadataMatches(metadata, commitment)
        ? metadata
        : undefined;
    } catch {
      return undefined;
    }
  }
}
